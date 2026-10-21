"use strict";
/* Ferret - a Bag of Waffles tool.
   Enables the hidden dev menu on a Teenage Engineering OP-1 Field, entirely in
   the browser. WebMIDI only: while its menu is up, te-boot exposes a USB MIDI
   interface, and the te-boot console commands travel inside TE SysEx.

   The OP-1 Field's packed SysEx header is 00 20 76 02 66 (verified in the
   te-boot 1000.0.34 MidiCommandHandler at 0x889e2a08: it compares
   F0 00 20 76 02 66 and the reply builder 0x889e2410 emits the same envelope).
   The OP-XY uses 00 20 76 21 66. The page probes the known headers with the
   read-only 0x09 metadata command and keeps whichever one te-boot answers on.

   The unit side is console command 0xAC: it checks a 16-byte response derived
   from command 0x1F (OTP field 0x13), then writes "bootloader.dev" and sets the
   runtime dev flag. This page reads the field live, so no secret is stored. */

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
   Identical framing to the OP-XY / TX-6 console:
     wire = COBS(body) + 0x00
     body = [route][seq][cmd][len][payload][crc8]
   route host->te-boot = 0x21; crc8 = poly 0x4D reflected, init/xorout 0xFF. */
const CRC8 = Uint8Array.from("ead496a8122c6e507f41033d87b9fbc5a59bd9e75d63211f300e4c72c8f6b48a744a08368cb2f0cee1df9da31927655b3b054779c3fdbf81ae90d2ec56682a14b38dcff14b75370926185a64dee0a29cfcc280be043a78466957152b91afedd32d13516fd5eba997b886c4fa407e3c02625c1e209aa4e6d8f7c98bb50f31734d5866241aa09edce2cdf3b18f350b497717296b55efd193ad82bcfec07a440638c6f8ba843e00427c536d2f11ab95d7e989b7f5cb714f0d331c22605ee4da98a6013f7d43f9c785bb94aae8d66c52102e4e70320cb688caf4dbe5a799231d5f619fa1e3dd67591b250a347648f2cc8eb0d0eeac922816546a457b3907bd83c1ff".match(/../g).map(h => parseInt(h, 16)));
const crc8 = (u8, c = 0) => { for (const b of u8) c = CRC8[c ^ b]; return c; };
function cobsEnc(u8) { const out = []; let blk = []; for (const b of u8) { if (b === 0) { out.push(blk.length + 1, ...blk); blk = []; } else { blk.push(b); if (blk.length === 254) { out.push(255, ...blk); blk = []; } } } out.push(blk.length + 1, ...blk); return Uint8Array.from(out); }
function cobsDec(u8) { const out = []; let i = 0; while (i < u8.length) { const code = u8[i]; if (code === 0) throw new Error('zero'); i++; for (let k = 0; k < code - 1; k++) out.push(u8[i + k]); i += code - 1; if (code < 255 && i < u8.length) out.push(0); } return Uint8Array.from(out); }
function teFrame(type, payload = new Uint8Array(0), seq = 0) { const b = Uint8Array.from([0x21, seq & 0xff, type & 0xff, payload.length, ...payload]); return Uint8Array.from([...cobsEnc(Uint8Array.from([...b, crc8(b)])), 0]); }
function parseFrame(b) { if (b.length < 5) return null; const seq = b[1], type = b[2], len = b[3]; if (b.length !== 5 + len || crc8(b.slice(0, -1)) !== b[b.length - 1]) return null; return { seq, type, payload: b.slice(4, 4 + len) }; }

/* ---------------- TE SysEx framing ----------------
   Packed te-serial (what carries the full console command set):
     F0 00 20 76 02 66 <7-bit-packed COBS wire> F7      (OP-1 Field)
     F0 00 20 76 21 66 <7-bit-packed COBS wire> F7      (OP-XY)
   TE-MIDI (identity / metadata only):
     F0 00 20 76 <dev> 40 <40|20|rid_hi> <rid_lo> <cmd> <7-bit data> F7  */
const HEADER_CANDIDATES = [
  [0x00, 0x20, 0x76, 0x02, 0x66],   /* OP-1 Field - exact header from te-boot */
  [0x00, 0x20, 0x76, 0x21, 0x66],   /* OP-XY packed header */
  [0x00, 0x20, 0x76, 0x02, 0x21],
  [0x00, 0x20, 0x76, 0x02, 0x00],
  [0x00, 0x20, 0x76, 0x02, 0x7f],
  [0x00, 0x20, 0x76, 0x21, 0x02],
  [0x00, 0x20, 0x76, 0x00, 0x66],
  [0x00, 0x20, 0x76, 0x01, 0x66],
  [0x00, 0x20, 0x76, 0x7f, 0x66]
];
function pack7(d) { const out = []; for (let i = 0; i < d.length; i += 7) { const g = d.slice(i, i + 7); let m = 0; for (let k = 0; k < g.length; k++) m |= ((g[k] >> 7) & 1) << k; out.push(m); for (const b of g) out.push(b & 0x7f); } return out; }
function unpack7(a) { const out = []; for (let i = 0; i < a.length; i += 8) { const msb = a[i]; const g = a.slice(i + 1, i + 8); for (let k = 0; k < g.length; k++) out.push((g[k] & 0x7f) | (((msb >> k) & 1) << 7)); } return out; }
function packedSysex(hdr, cmd, payload = new Uint8Array(0)) { return Uint8Array.from([0xF0, ...hdr, ...pack7(teFrame(cmd, payload)), 0xF7]); }

/* ---------------- te-boot commands ----------------
   0x01 greet/ack | 0x09 metadata (replies 0x0a) | 0x0d control (0x18 reboot
   normal) | 0x1f read OTP field 0x13 (replies 0x20) | 0xac dev marker. */
const CMD_GREET = 0x01, CMD_META = 0x09, CMD_CONTROL = 0x0d, CMD_OTP13 = 0x1f, CMD_DEV = 0xac;
const REPLY_META = 0x0a, REPLY_OTP13 = 0x20;

/* ---------------- the dev-mode command (0xAC) ----------------
   payload (22 bytes):  99 4A F3 ED | sig[16] | marker | op
     sig[i] = otp13[i] ^ {99,4A,F3,ED}[i % 4]
     marker 0xBA = "bootloader.dev" (the dev menu), 0xBE = "op1.dev"
     op     0xA7 = write, anything else = delete
   On success te-boot writes the marker file and sets its dev flag at runtime
   (the menu only re-renders when you navigate away and back). No reply. */
const ROT = Uint8Array.from([0x99, 0x4a, 0xf3, 0xed]);
const MARKER_BOOTLOADER = 0xba, OP_WRITE = 0xa7;
const devSignature = otp => Uint8Array.from(otp, (b, i) => b ^ ROT[i % 4]);
const devPayload = (otp, enable = true) => Uint8Array.from([...ROT, ...devSignature(otp), MARKER_BOOTLOADER, enable ? OP_WRITE : 0x00]);

/* ---------------- MIDI ---------------- */
let access = null, midiIn = null, midiOut = null, midiFrames = [], midiBuf = [], midiWaiter = null, lastFrom = '', portName = null;
let devId = 0x02, header = null, packedReady = false, reqId = 0;

function wake() { if (midiWaiter) { const w = midiWaiter; midiWaiter = null; w(); } }
function drainPacked() {
  let i;
  while ((i = midiBuf.indexOf(0)) >= 0) {
    const chunk = midiBuf.splice(0, i); midiBuf.shift();
    if (!chunk.length) continue;
    let f = null;
    try { f = parseFrame(cobsDec(Uint8Array.from(chunk))); } catch (_) {}
    if (f) { log('RX packed [0x' + f.type.toString(16).padStart(2, '0') + '] ' + hex(f.payload).slice(0, 192), 'rx'); midiFrames.push(f); }
  }
}
function onMidi(ev) {
  const d = ev.data;
  if (!d || d.length < 6 || d[0] !== 0xF0 || d[d.length - 1] !== 0xF7) return;
  if (ev.target && ev.target.name) lastFrom = ev.target.name;
  const b = Array.from(d.subarray(1, d.length - 1));

  /* universal identity reply: 7E <dev> 06 02 <manufacturer> ... */
  if (b[0] === 0x7e && b[2] === 0x06) {
    if (!(b.length >= 8 && b[5] === 0x00 && b[6] === 0x20 && b[7] === 0x76)) return;
    devId = b[1];
    log('MIDI identity: device id 0x' + devId.toString(16).padStart(2, '0') + ' from "' + (lastFrom || '?') + '"', 'ok');
    midiFrames.push({ identity: true, dev: devId, from: lastFrom });
    wake(); return;
  }
  if (!(b[0] === 0x00 && b[1] === 0x20 && b[2] === 0x76)) return;

  /* TE-MIDI reply: 00 20 76 <dev> 40 <20|rid_hi> <rid_lo> <cmd> <status> ... */
  if (b[4] === 0x40 && b.length >= 9 && (b[5] & 0x40) === 0) {
    const cmd = b[7], status = b[8];
    const data = Uint8Array.from(unpack7(b.slice(9)));
    log('RX TE-MIDI [0x' + cmd.toString(16).padStart(2, '0') + '] status ' + status + ' ' + hex(data).slice(0, 160), 'rx');
    midiFrames.push({ teMidi: true, cmd, status, data });
    wake(); return;
  }

  /* packed te-serial reply: it starts with the same header we sent */
  let h = null;
  if (header && header.every((v, i) => b[i] === v)) h = header;
  if (!h) h = HEADER_CANDIDATES.find(c => c.every((v, i) => b[i] === v)) || null;
  if (!h) return;
  const wire = unpack7(b.slice(5));
  for (const x of wire) midiBuf.push(x);
  drainPacked();
  wake();
}
function onStateChange() {
  if (midiOut && midiOut.state === 'disconnected') {
    log('MIDI port "' + portName + '" dropped (unit rebooting?) - press "Find my OP-1 Field" again when it is back', 'warn');
    midiOut = null; midiIn = null; packedReady = false;
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
  const o = outs.find(x => x.name === portName) || outs.find(x => /OP-1|teenage/i.test(x.name)) || outs[0];
  return openPair(o.name);
}
async function waitFrame(pred, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const hit = midiFrames.find(pred);
    if (hit) return hit;
    let tm;
    await Promise.race([new Promise(r => { midiWaiter = r; }), new Promise(r => { tm = setTimeout(r, 25); })]);
    clearTimeout(tm); midiWaiter = null;
  }
  return null;
}
async function midiRead(ms) {
  if (!midiFrames.length) { let tm; await Promise.race([new Promise(r => { midiWaiter = r; }), new Promise(r => { tm = setTimeout(r, ms); })]); clearTimeout(tm); midiWaiter = null; }
  return midiFrames.shift() || null;
}

/* TE-MIDI: identity, greet and metadata only (command bytes are 7-bit) */
function teMidiFrame(cmd, payload = new Uint8Array(0)) {
  reqId = (reqId + 1) & 0x7f;
  const rid = reqId;
  return Uint8Array.from([0xF0, 0x00, 0x20, 0x76, devId & 0x7f, 0x40,
    0x40 | 0x20 | ((rid >> 7) & 0x1f), rid & 0x7f, cmd & 0x7f,
    ...pack7(payload), 0xF7]);
}
async function teMidiRequest(cmd, payload = new Uint8Array(0), timeout = 1500) {
  if (!midiOut) return null;
  midiFrames = []; midiBuf = [];
  const msg = teMidiFrame(cmd, payload);
  try { midiOut.send(msg); } catch (e) { log('MIDI send failed: ' + errMsg(e), 'err'); return null; }
  log('TX TE-MIDI [0x' + cmd.toString(16).padStart(2, '0') + '] ' + hex(msg), 'tx');
  return await waitFrame(f => f.teMidi && f.cmd === cmd, timeout);
}
/* packed te-serial: the full console command set */
function sendPacked(cmd, payload = new Uint8Array(0)) {
  if (!midiOut) { log('no MIDI port open - press "Find my OP-1 Field" first', 'err'); return false; }
  if (!header) { log('no packed te-serial header selected - probe headers first', 'err'); return false; }
  const msg = packedSysex(header, cmd, payload);
  try { midiOut.send(msg); } catch (e) { log('MIDI send failed: ' + errMsg(e), 'err'); return false; }
  log('TX packed [0x' + cmd.toString(16).padStart(2, '0') + '] ' + hex(msg), 'tx');
  return true;
}
async function packedRequest(cmd, payload = new Uint8Array(0), want = null, timeout = 2000) {
  midiFrames = []; midiBuf = [];
  if (!sendPacked(cmd, payload)) return null;
  if (want === null) return true;
  return await waitFrame(f => !f.teMidi && !f.identity && f.type === want, timeout);
}

function parseMeta(reply) {
  const text = new TextDecoder().decode(reply.payload).replace(/\0/g, '').trim();
  const fields = {};
  for (const kv of text.split(';')) { const j = kv.indexOf(':'); if (j > 0) fields[kv.slice(0, j)] = kv.slice(j + 1); }
  return { text, fields };
}
async function readMetadata(timeout = 2000) {
  const r = await packedRequest(CMD_META, new Uint8Array(0), REPLY_META, timeout);
  return r ? parseMeta(r) : null;
}
async function readOtp13(timeout = 2000) {
  const r = await packedRequest(CMD_OTP13, new Uint8Array(0), REPLY_OTP13, timeout);
  return (r && r.payload.length >= 16) ? r.payload.slice(0, 16) : null;
}

/* ---------------- header discovery ----------------
   The read-only 0x09 query is the probe: it has no side effects. The first
   header that returns a metadata reply (0x0A) is kept for the session. */
function parseHeaderInput() {
  const s = ($('hdr') ? $('hdr').value : '').trim().replace(/[\s:]/g, '').replace(/^f0/i, '');
  if (!s) return null;
  if (!/^[0-9a-fA-F]{10}$/.test(s)) return 'invalid';
  return Uint8Array.from(s.match(/../g).map(h => parseInt(h, 16)));
}
async function probeHeaders(only = null, timeout = 800) {
  const list = only ? [only] : HEADER_CANDIDATES;
  for (const h of list) {
    header = Array.from(h);
    midiFrames = []; midiBuf = [];
    if (!sendPacked(CMD_META)) continue;
    const r = await waitFrame(f => !f.teMidi && !f.identity && f.type === REPLY_META, timeout);
    if (r) {
      log('packed te-serial header ' + hex(header) + ' answered te-boot metadata', 'ok');
      return r;
    }
    log('packed header ' + hex(header) + ' - no answer', 'warn');
  }
  header = null;
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
  if (!outs.length) { log('no MIDI outputs found - is the OP-1 Field plugged in and powered on?', 'err'); return null; }
  const sel = $('port'); if (sel) sel.innerHTML = outs.map(o => `<option>${o.name.replace(/[<>&]/g, '')}</option>`).join('');

  /* open every input so replies are heard no matter which port answers */
  for (const i of access.inputs.values()) { try { i.onmidimessage = onMidi; await i.open(); } catch (_) {} }

  midiFrames = []; midiBuf = []; lastFrom = ''; packedReady = false; header = null;
  for (const o of outs) { try { await o.open(); o.send(Uint8Array.from([0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7])); } catch (_) {} }
  log('probing ' + outs.length + ' MIDI output' + (outs.length > 1 ? 's' : '') + ' for te-boot...', 'tx');

  let ident = null, identFrom = '';
  const idEnd = Date.now() + 1500;
  while (Date.now() < idEnd) {
    const f = await midiRead(idEnd - Date.now());
    if (!f) break;
    if (f.identity) {
      /* prefer the OP-1's own port if several TE devices answer */
      if (!ident || /OP-1/i.test(f.from || '')) { ident = f; identFrom = f.from || ''; }
      if (/OP-1/i.test(f.from || '')) break;
    }
  }
  const out = (identFrom && outs.find(o => o.name === identFrom)) ||
              (lastFrom && outs.find(o => o.name === lastFrom)) ||
              outs.find(o => /OP-1|teenage/i.test(o.name)) ||
              (outs.length === 1 ? outs[0] : null);
  if (!out) {
    log('a unit answered on "' + (lastFrom || '?') + '" but no output matches it - pick the port by hand in Plan B', 'warn');
    return null;
  }
  if (!(await openPair(out.name))) { log('could not open MIDI port "' + out.name + '"', 'err'); return null; }
  log('MIDI port "' + out.name + '" open' + (ident ? ' (device id 0x' + devId.toString(16).padStart(2, '0') + ')' : ''), 'ok');

  /* TE-MIDI greet: confirms the unit and gives us serial/versions */
  const greet = await teMidiRequest(CMD_GREET, new Uint8Array(0), 1500);
  let meta = null;
  if (greet && greet.status === 0x00) {
    meta = parseMeta({ payload: greet.data });
    log('TE-MIDI greet: ' + meta.text, 'ok');
  } else if (greet) {
    log('TE-MIDI greet returned status 0x' + greet.status.toString(16) + ' (this personality rejected 0x01)', 'warn');
  } else {
    log('no answer to the TE-MIDI greet (0x01)', 'warn');
  }

  /* then find the packed te-serial header that carries the console commands */
  const manual = parseHeaderInput();
  if (manual === 'invalid') log('the header in Plan B is not 10 hex chars - ignoring it', 'warn');
  const packedMeta = await probeHeaders(manual === 'invalid' ? null : manual);
  if (packedMeta) {
    packedReady = true;
    meta = parseMeta(packedMeta);
  } else {
    log('no packed te-serial header answered. The unit is talking MIDI, but this', 'err');
    log('MIDI personality is not accepting the console command set (0x09).', 'err');
    log('If you know the OP-1 Field header, paste it in Plan B -> Transport and probe again.', 'warn');
  }
  return meta || { text: '', fields: {} };
}

/* ---------------- the wizard ---------------- */
let checkOk = false, tebootOk = false, midiReady = false, devSent = false;

function st(id, cls, note) {
  const el = $('s-' + id); if (!el) return;
  el.classList.remove('pending', 'active', 'done', 'fail');
  el.classList.add(cls);
  const n = $('sn-' + id); if (n) n.textContent = note || '';
  if (cls === 'fail') { const d = $('d-log'); if (d) d.open = true; }
}
const activate = (id, note) => st(id, 'active', note);

function refresh() {
  $('conn').disabled = !(checkOk && tebootOk);
  const on = midiReady && packedReady;
  $('enable').disabled = !on;
  $('disable').disabled = !on;
  $('verify').hidden = !devSent;
}

function supportCheck() {
  const has = [['MIDI', !!navigator.requestMIDIAccess]];
  $('support').innerHTML = has.map(([n, v]) => `<span class="chip ${v ? 'on' : 'off'}">${n}: ${v ? 'ok' : 'missing'}</span>`).join('');
  const https = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  checkOk = has.every(([, v]) => v) && https;
  if (checkOk) {
    st('check', 'done', 'ready');
    $('checkhint').innerHTML = 'WebMIDI (SysEx) is available. The page will ask for <b>MIDI (SysEx)</b> permission when you connect.';
    activate('teboot');
  } else {
    st('check', 'fail', 'unsupported');
    $('checkhint').innerHTML = !https
      ? 'Serve this page over <b>https</b> (the hosted version is fine) - WebMIDI needs a secure context.'
      : 'This browser has no WebMIDI. Use <b>Chrome or Edge on a desktop</b>.';
  }
  $('teboot-ok').disabled = !checkOk;
  refresh();
}

function showUnit(meta) {
  const f = meta.fields;
  if (f.product && f.product !== 'OP-1') log('that answered as "' + f.product + '", not an OP-1 Field - continue only if you know what you are doing', 'warn');
  if (f.mode && f.mode !== 'bootloader') log('te-boot reports mode "' + f.mode + '" - the dev menu normally lives in mode:bootloader', 'warn');
  $('ub-serial').textContent = f.serial || '(unknown)';
  $('ub-fw').textContent = f.os_version || '(unknown)';
  $('ub-bl').textContent = f.bl_version || '(unknown)';
  $('ub-mode').textContent = f.mode || '(unknown)';
  $('ub-head').textContent = header ? hex(header) : '(none - console commands unreachable)';
  $('unitbox').hidden = false;
}

async function connectFlow() {
  if (!navigator.requestMIDIAccess) { log('This browser has no WebMIDI - use Chrome or Edge on desktop.', 'err'); return; }
  $('conn').disabled = true;
  st('teboot', 'active', 'asking for MIDI access...');
  const meta = await connectMIDI();
  if (meta) {
    midiReady = true;
    st('teboot', 'done', 'te-boot found');
    st('connect', packedReady ? 'done' : 'fail', packedReady ? 'connected' : 'MIDI metadata only');
    showUnit(meta);
    if (meta.text) log('te-boot: ' + meta.text, 'ok');
    if (packedReady) activate('enable');
  } else {
    st('teboot', 'fail', 'no answer - see the log');
    log('Checklist:', 'warn');
    log('  - the OP-1 Field must be in its te-boot menu: power off, hold COM while powering on', 'warn');
    log('  - the unit\'s MIDI interface only exists while that menu is up', 'warn');
    log('  - normal OS mode does not answer these commands; MIDI (SysEx) permission must be allowed', 'warn');
  }
  refresh();
}

/* Step 4: enable or disable the dev marker (same command, write or delete op) */
async function devMarkerFlow(enable) {
  if (!midiReady || !packedReady) { log('no packed te-boot link - press "Find my OP-1 Field" first', 'err'); return; }
  $('enable').disabled = true; $('disable').disabled = true;

  st('enable', 'active', 'reading OTP field 0x13 (0x1F)...');
  const otp = await readOtp13();
  if (!otp) {
    st('enable', 'fail', 'no answer to 0x1F - see the log');
    log('command 0x1F gave no 16-byte reply.', 'err');
    log('If the unit has gone quiet, power-cycle it, then press "Find my OP-1 Field" again.', 'warn');
    log('Otherwise: is the unit still on its te-boot menu?', 'warn');
    refresh(); return;
  }
  log('OTP field 0x13 = ' + hex(otp) + ' (a per-unit challenge value - not the firmware key)', 'rx');
  log('0xAC response   = ' + hex(devSignature(otp)), 'info');
  st('enable', 'active', 'sending the dev-mode command...');
  if (!(await packedRequest(CMD_DEV, devPayload(otp, enable), null))) { st('enable', 'fail', 'could not send'); refresh(); return; }
  devSent = true;
  await sleep(350);

  const ping = await readMetadata(1500);
  if (ping) log('the unit is still answering after the command (0x09 round-trip ok).', 'ok');
  else log('the unit stopped answering - it may be rebooting; reconnect before sending again.', 'warn');
  log(enable ? 'command 0xAC sent: te-boot writes "bootloader.dev" and switches dev mode on.'
             : 'command 0xAC sent: te-boot deletes "bootloader.dev" and switches dev mode off.', 'ok');
  log('Re-render the menu to see the result: leave the te-boot menu and come back to it.', 'warn');
  log('te-boot cannot report dev mode back, so the menu on the screen is the confirmation.', 'info');
  $('verifyhint').innerHTML = enable
    ? 'the hidden dev entry should now be in the te-boot menu.'
    : 'the hidden dev entry should now be gone from the te-boot menu.';
  st('enable', 'done', enable ? 'dev mode on' : 'dev mode off');
  refresh();
}

async function rebootNormal() {
  if (!midiReady || !packedReady) { log('no packed te-boot link - press "Find my OP-1 Field" first', 'err'); return; }
  const ok = await packedRequest(CMD_CONTROL, Uint8Array.from([0x18]), null, 600);
  log(ok ? 'sent reboot to the normal OS (0x0d 0x18) - the unit leaves te-boot.' : 'could not send the reboot command - power-cycle the unit instead.', ok ? 'ok' : 'warn');
  if (ok) { midiReady = false; packedReady = false; midiOut = null; midiIn = null; refresh(); }
}

/* ---------------- Plan B ---------------- */
async function manualInfo() {
  if (!midiOut) { log('no MIDI port open - press "Find my OP-1 Field" first', 'err'); return; }
  const greet = await teMidiRequest(CMD_GREET, new Uint8Array(0), 1200);
  if (greet && greet.status === 0x00) log('TE-MIDI metadata: ' + parseMeta({ payload: greet.data }).text, 'ok');
  else log('no TE-MIDI greet reply', 'warn');
  if (!packedReady) { log('no packed te-serial link - use Plan B -> Probe headers again', 'warn'); return; }
  const meta = await readMetadata();
  if (meta) { showUnit(meta); log('packed metadata: ' + meta.text, 'ok'); }
  else log('no reply to packed 0x09', 'err');
}
async function manualOtpRead() {
  if (!packedReady) { log('no packed te-serial link - probe headers first', 'err'); return; }
  const otp = await readOtp13();
  if (!otp) { log('no 16-byte reply to 0x1F. If the unit went quiet, power-cycle it.', 'err'); return; }
  log('OTP field 0x13 = ' + hex(otp), 'rx');
  log('0xAC response   = ' + hex(devSignature(otp)), 'info');
}
async function probeFlow() {
  if (!midiOut) { log('no MIDI port open - press "Find my OP-1 Field" first', 'err'); return; }
  const manual = parseHeaderInput();
  if (manual === 'invalid') { log('the header must be 10 hex chars (5 bytes after F0)', 'err'); return; }
  const r = await probeHeaders(manual);
  packedReady = !!r;
  if (r) {
    const meta = parseMeta(r);
    showUnit(meta);
    log('packed link ready: ' + meta.text, 'ok');
    activate('enable');
  } else {
    log('none of the probed headers answered. te-boot\'s MIDI personality may only route', 'err');
    log('its DFU set on this firmware; paste the exact 5-byte header in Plan B if you know it.', 'warn');
  }
  refresh();
}

/* show the exact bytes for a pasted OTP field, no device needed */
function dryRun() {
  let otp = new Uint8Array(16);
  const s = $('dry-otp').value.trim().replace(/\s+/g, '');
  if (s) {
    if (!/^[0-9a-fA-F]{32}$/.test(s)) { $('dryout').textContent = 'OTP field 0x13 must be exactly 32 hex chars (16 bytes)'; return; }
    otp = Uint8Array.from(s.match(/../g).map(h => parseInt(h, 16)));
  } else {
    $('dryout').innerHTML = '<span class="hint">no value given - showing it with a zero OTP field for illustration</span>';
  }
  const manual = parseHeaderInput();
  const hdr = (manual && manual !== 'invalid') ? Array.from(manual) : HEADER_CANDIDATES[0];
  const p = devPayload(otp, true);
  $('dryout').innerHTML =
    '<pre class="wire">identity       : F0 7E 7F 06 01 F7\n' +
    'TE-MIDI 0x01   : ' + hex(teMidiFrame(CMD_GREET)) + '\n' +
    'header         : ' + hex(Array.from(hdr)) + '\n' +
    '0x1F  packed   : ' + hex(packedSysex(hdr, CMD_OTP13)) + '\n' +
    '0xAC  payload  : ' + hex(p) + '\n' +
    '0xAC  packed   : ' + hex(packedSysex(hdr, CMD_DEV, p)) + '</pre>' +
    '<span class="hint">Packed te-serial is the COBS + CRC-8 wire (<code>[0x21][seq][cmd][len][payload][crc8] + 0x00</code>), ' +
    '7-bit packed inside <code>F0 &lt;header&gt; &hellip; F7</code>. Reply type for <code>0x1F</code> is <code>0x20</code>; ' +
    '<code>0xAC</code> sends no reply. The header above is the first probe candidate: change it in Plan B -> Transport.</span>';
}

/* ---------------- wiring ---------------- */
window.addEventListener('DOMContentLoaded', () => {
  supportCheck();

  $('teboot-ok').onclick = () => {
    tebootOk = true;
    st('teboot', 'done', 'te-boot menu');
    log('press "Find my OP-1 Field" and allow MIDI (SysEx)', 'info');
    refresh();
  };

  $('conn').onclick = connectFlow;

  $('enable').onclick = () => devMarkerFlow(true);
  $('disable').onclick = () => devMarkerFlow(false);

  /* Plan B */
  $('mm-midi').onclick = connectFlow;
  $('useport').onclick = async () => {
    const name = $('port').value;
    if (!name) { log('pick a MIDI output first', 'warn'); return; }
    if (!access) { log('press "Find my OP-1 Field" first', 'err'); return; }
    if (!(await openPair(name))) { log('could not open "' + name + '"', 'err'); return; }
    const greet = await teMidiRequest(CMD_GREET, new Uint8Array(0), 1200);
    if (greet) { midiReady = true; log('port "' + name + '" answers te-boot', 'ok'); }
    else log('no te-boot answer from "' + name + '" - try another port', 'warn');
    await probeFlow();
    refresh();
  };
  $('mm-meta').onclick = manualInfo;
  $('mm-otp').onclick = manualOtpRead;
  $('mm-on').onclick = () => devMarkerFlow(true);
  $('mm-off').onclick = () => devMarkerFlow(false);
  $('mm-norm').onclick = rebootNormal;
  $('mm-hdr').onclick = probeFlow;
  $('mm-dry').onclick = dryRun;
  $('clear').onclick = () => { logEl().textContent = ''; };

  log('Ready. Flow: power on with COM held (te-boot menu) -> Find my OP-1 Field -> enable dev mode.', 'ok');
  log('Nothing is uploaded, and no firmware is read or written by this page.', 'info');
});
