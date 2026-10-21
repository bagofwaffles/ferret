"use strict";
/* Ferret - a Bag of Waffles tool.
   Enables the hidden dev menu on a Teenage Engineering OP-XY, entirely in the
   browser. WebMIDI only: the unit's te-boot exposes a USB MIDI interface while
   its menu is up, and the te-boot console commands travel inside TE SysEx
   (F0 00 20 76 21 66 ...). Nothing is uploaded, no firmware is touched.

   The unit side is the te-boot console command 0xAC: it checks a 16-byte
   response that the unit itself reports via command 0x1F (OTP field 0x13),
   then writes the dev marker "bootloader.dev" and sets the runtime dev flag.
   This page reads the field live, so no secret is stored here. */

const $ = id => document.getElementById(id);
const logEl = () => $('log');
function ts() { const d = new Date(); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); }
function log(msg, cls = 'info') {
  const s = document.createElement('span');
  s.innerHTML = `<span class="t">[${ts()}]</span> <span class="${cls}">${String(msg).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</span>\n`;
  logEl().appendChild(s); logEl().scrollTop = logEl().scrollHeight;
}
const hex = u8 => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errMsg = e => (e && e.message) ? e.message : String(e);

/* ---------------- TE serial protocol (COBS + CRC-8) ----------------
   Identical framing to the TX-6 / OP-1 Field console:
     wire = COBS(body) + 0x00
     body = [route][seq][cmd][len][payload][crc8]
   route host->te-boot = 0x21; crc8 = poly 0x4D reflected, init/xorout 0xFF. */
const CRC8 = Uint8Array.from("ead496a8122c6e507f41033d87b9fbc5a59bd9e75d63211f300e4c72c8f6b48a744a08368cb2f0cee1df9da31927655b3b054779c3fdbf81ae90d2ec56682a14b38dcff14b75370926185a64dee0a29cfcc280be043a78466957152b91afedd32d13516fd5eba997b886c4fa407e3c02625c1e209aa4e6d8f7c98bb50f31734d5866241aa09edce2cdf3b18f350b497717296b55efd193ad82bcfec07a440638c6f8ba843e00427c536d2f11ab95d7e989b7f5cb714f0d331c22605ee4da98a6013f7d43f9c785bb94aae8d66c52102e4e70320cb688caf4dbe5a799231d5f619fa1e3dd67591b250a347648f2cc8eb0d0eeac922816546a457b3907bd83c1ff".match(/../g).map(h => parseInt(h, 16)));
const crc8 = (u8, c = 0) => { for (const b of u8) c = CRC8[c ^ b]; return c; };
function cobsEnc(u8) { const out = []; let blk = []; for (const b of u8) { if (b === 0) { out.push(blk.length + 1, ...blk); blk = []; } else { blk.push(b); if (blk.length === 254) { out.push(255, ...blk); blk = []; } } } out.push(blk.length + 1, ...blk); return Uint8Array.from(out); }
function cobsDec(u8) { const out = []; let i = 0; while (i < u8.length) { const code = u8[i]; if (code === 0) throw new Error('zero'); i++; for (let k = 0; k < code - 1; k++) out.push(u8[i + k]); i += code - 1; if (code < 255 && i < u8.length) out.push(0); } return Uint8Array.from(out); }
function teFrame(type, payload = new Uint8Array(0), seq = 0) { const b = Uint8Array.from([0x21, seq & 0xff, type & 0xff, payload.length, ...payload]); return Uint8Array.from([...cobsEnc(Uint8Array.from([...b, crc8(b)])), 0]); }
function parseFrame(b) { if (b.length < 5) return null; const seq = b[1], type = b[2], len = b[3]; if (b.length !== 5 + len || crc8(b.slice(0, -1)) !== b[b.length - 1]) return null; return { seq, type, payload: b.slice(4, 4 + len) }; }

/* ---------------- te-boot over MIDI SysEx ----------------
   The te-boot MIDI personality (up while the te-boot menu is on screen) accepts
   the te-serial wire above MSB-packed inside a TE SysEx message:
     F0 00 20 76 21 66 <7-bit packed te-serial wire> F7
   Replies come back on the same header, packed the same way. */
const SYSEX_HEAD = Uint8Array.from([0x00, 0x20, 0x76, 0x21, 0x66]);
function pack7(d) { const out = []; for (let i = 0; i < d.length; i += 7) { const g = d.slice(i, i + 7); let m = 0; for (let k = 0; k < g.length; k++) m |= ((g[k] >> 7) & 1) << k; out.push(m); for (const b of g) out.push(b & 0x7f); } return out; }
function unpack7(a) { const out = []; for (let i = 0; i < a.length; i += 8) { const msb = a[i]; const g = a.slice(i + 1, i + 8); for (let k = 0; k < g.length; k++) out.push((g[k] & 0x7f) | (((msb >> k) & 1) << 7)); } return out; }
function sysexFrame(cmd, payload = new Uint8Array(0)) { return Uint8Array.from([0xF0, ...SYSEX_HEAD, ...pack7(teFrame(cmd, payload)), 0xF7]); }

/* ---------------- te-boot commands ----------------
   0x05 hello | 0x09 metadata (replies 0x0a) | 0x0d control (0x18 reboot normal)
   0x1f read OTP field 0x13 (replies 0x20, 16 bytes) | 0xac dev marker */
const CMD_META = 0x09, CMD_CONTROL = 0x0d, CMD_OTP13 = 0x1f, CMD_DEV = 0xac;
const REPLY_META = 0x0a, REPLY_OTP13 = 0x20;

/* ---------------- the dev-mode command (0xAC) ----------------
   payload (22 bytes):  99 4A F3 ED | sig[16] | marker | op
     sig[i] = otp13[i] ^ {99,4A,F3,ED}[i % 4]
     marker 0xBA = "bootloader.dev" (the dev/factory menu), 0xBE = "op1.dev"
     op     0xA7 = write, anything else = delete
   On success te-boot writes the marker file and sets its dev flag at runtime
   (the menu only re-renders when you navigate away and back). */
const ROT = Uint8Array.from([0x99, 0x4a, 0xf3, 0xed]);
const MARKER_BOOTLOADER = 0xba, OP_WRITE = 0xa7;
const devSignature = otp => Uint8Array.from(otp, (b, i) => b ^ ROT[i % 4]);
const devPayload = (otp, enable = true) => Uint8Array.from([...ROT, ...devSignature(otp), MARKER_BOOTLOADER, enable ? OP_WRITE : 0x00]);

/* ---------------- MIDI ---------------- */
let access = null, midiIn = null, midiOut = null, midiFrames = [], midiBuf = [], midiWaiter = null, lastFrom = '', portName = null;
function onMidi(ev) {
  const d = ev.data;
  if (!d || d.length < 8 || d[0] !== 0xF0 || d[d.length - 1] !== 0xF7) return;
  for (let i = 0; i < SYSEX_HEAD.length; i++) if (d[1 + i] !== SYSEX_HEAD[i]) return;
  if (ev.target && ev.target.name) lastFrom = ev.target.name;
  for (const b of unpack7(Array.from(d.subarray(1 + SYSEX_HEAD.length, d.length - 1)))) midiBuf.push(b);
  let i;
  while ((i = midiBuf.indexOf(0)) >= 0) {
    const chunk = midiBuf.splice(0, i); midiBuf.shift();
    if (!chunk.length) continue;
    let f = null;
    try { f = parseFrame(cobsDec(Uint8Array.from(chunk))); } catch (_) {}
    if (f) { log('RX [0x' + f.type.toString(16).padStart(2, '0') + '] ' + hex(f.payload).slice(0, 192), 'rx'); midiFrames.push(f); }
  }
  if (midiWaiter) { const w = midiWaiter; midiWaiter = null; w(); }
}
async function midiRead(ms) {
  if (!midiFrames.length) { let tm; await Promise.race([new Promise(r => { midiWaiter = r; }), new Promise(r => { tm = setTimeout(r, ms); })]); clearTimeout(tm); midiWaiter = null; }
  return midiFrames.shift() || null;
}
function onStateChange() {
  if (midiOut && midiOut.state === 'disconnected') {
    log('MIDI port "' + portName + '" dropped (unit rebooting?) - press "Find my OP-XY" again when it is back', 'warn');
    midiOut = null; midiIn = null;
  }
}
async function openPair(name) {
  const outs = [...access.outputs.values()].filter(o => o.state !== 'disconnected');
  const ins = [...access.inputs.values()].filter(i => i.state !== 'disconnected');
  midiOut = outs.find(o => o.name === name) || null;
  midiIn = ins.find(i => i.name === name) || null;
  if (!midiOut) return false;
  try { await midiOut.open(); } catch (_) {}
  if (midiIn) { midiIn.onmidimessage = onMidi; try { await midiIn.open(); } catch (_) {} }
  portName = name;
  return true;
}
async function ensureMIDI() {
  if (!access) return false;
  if (midiOut && midiOut.state !== 'disconnected') return true;
  const outs = [...access.outputs.values()].filter(o => o.state !== 'disconnected');
  if (!outs.length) return false;
  const o = outs.find(x => x.name === portName) || outs.find(x => /OP-XY|teenage/i.test(x.name)) || outs[0];
  return openPair(o.name);
}
function sendSysex(cmd, payload = new Uint8Array(0)) {
  if (!midiOut) { log('no MIDI port open - press "Find my OP-XY" first', 'err'); return false; }
  const msg = sysexFrame(cmd, payload);
  try { midiOut.send(msg); }
  catch (e) { log('MIDI send failed: ' + errMsg(e), 'err'); return false; }
  log('TX [0x' + cmd.toString(16).padStart(2, '0') + '] ' + hex(msg), 'tx');
  return true;
}
/* send one command and wait for the first reply of the wanted type (null = don't wait) */
async function teRequest(cmd, payload, want, timeout = 2500) {
  midiFrames = []; midiBuf = [];
  if (!sendSysex(cmd, payload)) return null;
  if (want === null) return true;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const hit = midiFrames.find(f => f.type === want);
    if (hit) return hit;
    await sleep(25);
  }
  return null;
}
/* is the unit there and talking te-boot? (one metadata query, short window) */
async function pingUnit(timeout = 1500) {
  if (!(await ensureMIDI())) return null;
  return await teRequest(CMD_META, new Uint8Array(0), REPLY_META, timeout);
}
function parseMeta(reply) {
  const text = new TextDecoder().decode(reply.payload).replace(/\0/g, '').trim();
  const fields = {};
  for (const kv of text.split(';')) { const j = kv.indexOf(':'); if (j > 0) fields[kv.slice(0, j)] = kv.slice(j + 1); }
  return { text, fields };
}
async function readOtp13() {
  const r = await teRequest(CMD_OTP13, new Uint8Array(0), REPLY_OTP13);
  if (r && r.payload.length >= 16) return r.payload.slice(0, 16);
  return null;
}

/* ---------------- connect: MIDI access + probe for te-boot ---------------- */
async function connectMIDI() {
  if (!navigator.requestMIDIAccess) { log('This browser has no WebMIDI - use Chrome or Edge on desktop.', 'err'); return null; }
  if (!access) {
    try {
      access = await navigator.requestMIDIAccess({ sysex: true });
      access.onstatechange = onStateChange;
    } catch (e) {
      log('MIDI access denied: ' + errMsg(e), 'err');
      log('If a prompt appeared, allow MIDI (SysEx) for this site and press the button again.', 'warn');
      return null;
    }
  }
  const outs = [...access.outputs.values()].filter(o => o.state !== 'disconnected');
  if (!outs.length) { log('no MIDI outputs found - is the OP-XY plugged in and powered on?', 'err'); return null; }
  const sel = $('port'); if (sel) sel.innerHTML = outs.map(o => `<option>${o.name.replace(/[<>&]/g, '')}</option>`).join('');

  /* open every input so replies are heard no matter which port answers */
  for (const i of access.inputs.values()) { try { i.onmidimessage = onMidi; await i.open(); } catch (_) {} }

  midiFrames = []; midiBuf = []; lastFrom = '';
  for (const o of outs) { try { await o.open(); o.send(sysexFrame(CMD_META)); } catch (_) {} }
  log('probing ' + outs.length + ' MIDI output' + (outs.length > 1 ? 's' : '') + ' for te-boot...', 'tx');

  let meta = null;
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    const f = await midiRead(end - Date.now());
    if (!f) break;
    if (f.type === REPLY_META) { meta = parseMeta(f); break; }
    log('a port answered, but not with te-boot metadata - ignoring (this is not the te-boot interface)', 'warn');
  }
  const out = (lastFrom && outs.find(o => o.name === lastFrom)) ||
              outs.find(o => /OP-XY|teenage/i.test(o.name)) ||
              (outs.length === 1 ? outs[0] : null);
  if (!meta) {
    log('no answer from any MIDI output. Checklist:', 'err');
    log('  - the OP-XY must be in its te-boot menu: power off, hold COM while powering on', 'warn');
    log('  - if you pressed track 1 (upload firmware), the unit switches to its disk personality and the MIDI port goes away - go back to the menu or power-cycle with COM held', 'warn');
    log('  - normal OS mode does not answer these commands; and MIDI (SysEx) permission must be allowed', 'warn');
    return null;
  }
  if (!out) {
    log('te-boot answered on "' + (lastFrom || '?') + '" but no output matches it - pick the port by hand in Plan B', 'warn');
    return null;
  }
  if (!(await openPair(out.name))) { log('could not open MIDI port "' + out.name + '"', 'err'); return null; }
  log('te-boot is listening on "' + out.name + '"', 'ok');
  return meta;
}

/* ---------------- the wizard ---------------- */
let checkOk = false, midiReady = false, devSent = false;

function st(id, cls, note) {
  const el = $('s-' + id); if (!el) return;
  el.classList.remove('pending', 'active', 'done', 'fail');
  el.classList.add(cls);
  const n = $('sn-' + id); if (n) n.textContent = note || '';
  if (cls === 'fail') { const d = $('d-log'); if (d) d.open = true; }
}
const activate = (id, note) => st(id, 'active', note);

function refresh() {
  $('conn').disabled = !checkOk;
  $('enable').disabled = !midiReady;
  $('disable').disabled = !midiReady;
  $('verify').hidden = !devSent;
}

function supportCheck() {
  const has = [['MIDI', !!navigator.requestMIDIAccess]];
  $('support').innerHTML = has.map(([n, v]) => `<span class="chip ${v ? 'on' : 'off'}">${n}: ${v ? 'ok' : 'missing'}</span>`).join('');
  const https = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  checkOk = has.every(([, v]) => v) && https;
  if (checkOk) {
    st('check', 'done', 'ready');
    $('checkhint').innerHTML = 'WebMIDI is available. The page will ask for <b>MIDI (SysEx)</b> permission when you connect.';
    activate('teboot');
  } else {
    st('check', 'fail', 'unsupported');
    $('checkhint').innerHTML = !https
      ? 'Serve this page over <b>https</b> (the hosted version is fine) - WebMIDI needs a secure context.'
      : 'This browser has no WebMIDI. Use <b>Chrome or Edge on a desktop</b>.';
  }
  refresh();
}

function showUnit(meta) {
  const f = meta.fields;
  if (f.product && f.product !== 'OP-XY') log('that answered as "' + f.product + '", not an OP-XY - continue only if you know what you are doing', 'warn');
  if (f.mode) log('te-boot mode: ' + f.mode + (f.os_version ? ', OS ' + f.os_version : ''), 'info');
  $('ub-serial').textContent = f.serial || '(unknown)';
  $('ub-fw').textContent = f.os_version || '(unknown)';
  $('ub-bl').textContent = f.bl_version || '(unknown)';
  $('unitbox').hidden = false;
}

async function connectFlow() {
  $('conn').disabled = true;
  st('teboot', 'active', 'asking for MIDI access...');
  const meta = await connectMIDI();
  if (meta) {
    midiReady = true;
    st('teboot', 'done', 'te-boot found');
    st('connect', 'done', 'connected');
    showUnit(meta);
    activate('enable');
    log('te-boot: ' + meta.text, 'ok');
  } else {
    st('teboot', 'fail', 'no answer - see the log');
  }
  refresh();
}

/* Step 4: enable or disable the dev marker (same command, write or delete op) */
async function devMarkerFlow(enable) {
  $('enable').disabled = true; $('disable').disabled = true;
  st('enable', 'active', 'reading OTP field 0x13...');
  const otp = await readOtp13();
  if (!otp) {
    st('enable', 'fail', 'no answer to 0x1F - check the connection');
    log('command 0x1F gave no 16-byte reply - is the unit still in its te-boot menu?', 'err');
    refresh(); return;
  }
  log('OTP field 0x13 = ' + hex(otp) + ' (a per-unit challenge value - not the firmware key)', 'rx');
  log('0xAC response   = ' + hex(devSignature(otp)), 'info');
  st('enable', 'active', 'sending the dev-mode command...');
  if (!sendSysex(CMD_DEV, devPayload(otp, enable))) { st('enable', 'fail', 'could not send'); refresh(); return; }
  devSent = true;
  st('enable', 'active', 'sent - check the OP-XY screen');
  log(enable ? 'command 0xAC sent: te-boot writes "bootloader.dev" and switches dev mode on.'
             : 'command 0xAC sent: te-boot deletes "bootloader.dev" and switches dev mode off.', 'ok');
  const ping = await pingUnit(1500);
  if (ping) log('the unit is still answering after the command (0x09 round-trip ok).', 'ok');
  else log('the unit stopped answering - it may be rebooting; reconnect before sending again.', 'warn');
  log('Re-render the menu to see the result: press 8 (system menu), then 8 (back).', 'warn');
  log('te-boot cannot report dev mode back, so the menu on the screen is the confirmation.', 'info');
  $('verifyhint').innerHTML = enable
    ? 'you should now see <b>3. dev menu</b> in the main menu.'
    : 'the <b>3. dev menu</b> entry should now be gone from the main menu.';
  st('enable', 'done', enable ? 'dev mode on' : 'dev mode off');
  refresh();
}

async function rebootNormal() {
  const ok = sendSysex(CMD_CONTROL, Uint8Array.from([0x18]));
  await sleep(300);
  if (ok) $('mm-norm').disabled = true;
  log(ok ? 'sent reboot to the normal OS (0x0d 0x18) - the unit leaves te-boot.' : 'could not send the reboot command - power-cycle the unit instead.', ok ? 'ok' : 'warn');
}

/* Plan B: turn dev mode off (deletes the marker; the runtime flag clears too) */
async function devOff() {
  if (!midiOut) { log('no MIDI port open - press "Find my OP-XY" first', 'err'); return; }
  const otp = await readOtp13();
  if (!otp) { log('no reply to 0x1F - is the unit still in te-boot?', 'err'); return; }
  await sendSysex(CMD_DEV, devPayload(otp, false));
  log('sent dev-mode OFF: te-boot deletes "bootloader.dev" (press 8 -> system menu, then 8 -> back to re-render).', 'ok');
}

/* Plan B: show the exact bytes for a pasted OTP field, no device needed */
function dryRun() {
  let otp = new Uint8Array(16);
  const s = $('dry-otp').value.trim().replace(/\s+/g, '');
  if (s) {
    if (!/^[0-9a-fA-F]{32}$/.test(s)) { $('dryout').textContent = 'OTP field 0x13 must be exactly 32 hex chars (16 bytes)'; return; }
    otp = Uint8Array.from(s.match(/../g).map(h => parseInt(h, 16)));
  } else {
    $('dryout').innerHTML = '<span class="hint">no value given - showing it with a zero OTP field for illustration</span>';
  }
  const p = devPayload(otp, true);
  $('dryout').innerHTML =
    '<pre class="wire">0x1F  te-serial: ' + hex(teFrame(CMD_OTP13)) + '\n' +
    '0x1F  MIDI     : ' + hex(sysexFrame(CMD_OTP13)) + '\n' +
    '0xAC  payload   : ' + hex(p) + '\n' +
    '0xAC  MIDI     : ' + hex(sysexFrame(CMD_DEV, p)) + '</pre>' +
    '<span class="hint">The MIDI line is exactly what the unit receives: <code>F0 00 20 76 21 66</code> + the ' +
    'te-serial frame, 7-bit packed (bytes with bit 7 set travel in the leading MSB byte), + <code>F7</code>.</span>';
}

/* ---------------- wiring ---------------- */
window.addEventListener('DOMContentLoaded', () => {
  supportCheck();

  $('conn').onclick = connectFlow;
  $('enable').onclick = () => devMarkerFlow(true);
  $('disable').onclick = () => devMarkerFlow(false);

  /* Plan B */
  $('useport').onclick = async () => {
    const name = $('port').value;
    if (!name) { log('pick a MIDI output first', 'warn'); return; }
    if (!access) { log('press "Connect MIDI" first', 'err'); return; }
    if (!(await openPair(name))) { log('could not open "' + name + '"', 'err'); return; }
    const meta = await pingUnit(1500);
    if (meta) { midiReady = true; showUnit(parseMeta(meta)); st('teboot', 'done', 'te-boot found'); st('connect', 'done', 'connected'); activate('enable'); refresh(); log('port "' + name + '" answers te-boot', 'ok'); }
    else log('no te-boot answer from "' + name + '" - try another port, or check the unit is in its te-boot menu', 'warn');
  };
  $('mm-midi').onclick = connectFlow;
  $('mm-meta').onclick = async () => {
    if (!midiOut) { log('no MIDI port open - press "Find my OP-XY" first', 'err'); return; }
    const meta = await pingUnit(1500);
    if (meta) { const m = parseMeta(meta); log('metadata: ' + m.text, 'ok'); showUnit(m); }
    else log('no reply to 0x09', 'err');
  };
  $('mm-otp').onclick = async () => {
    if (!midiOut) { log('no MIDI port open - press "Find my OP-XY" first', 'err'); return; }
    const otp = await readOtp13();
    if (!otp) { log('no 16-byte reply to 0x1F', 'err'); return; }
    log('OTP field 0x13 = ' + hex(otp), 'rx');
    log('0xAC response   = ' + hex(devSignature(otp)), 'info');
  };
  $('mm-on').onclick = async () => { if (!midiReady && !midiOut) { log('no MIDI port open - press "Find my OP-XY" first', 'err'); return; } await devMarkerFlow(true); };
  $('mm-off').onclick = devOff;
  $('mm-norm').onclick = rebootNormal;
  $('mm-dry').onclick = dryRun;
  $('clear').onclick = () => { logEl().textContent = ''; };

  log('Ready. Flow: power on with COM held (te-boot menu) -> Find my OP-XY -> enable dev mode.', 'ok');
  log('Nothing is uploaded, and no firmware is read or written by this page.', 'info');
});