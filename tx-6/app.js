"use strict";
/* Ferret - a Bag of Waffles tool.
   Reads the AES-256 key out of a Teenage Engineering TX-6, entirely in the browser.
   WebMIDI (mode switching) + File System Access (write the update disk) +
   Web Serial (console) + WebCrypto (decrypt). Nothing is uploaded, ever. */

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

/* ---------------- TE serial protocol (COBS + CRC-8) ---------------- */
const CRC8 = Uint8Array.from("ead496a8122c6e507f41033d87b9fbc5a59bd9e75d63211f300e4c72c8f6b48a744a08368cb2f0cee1df9da31927655b3b054779c3fdbf81ae90d2ec56682a14b38dcff14b75370926185a64dee0a29cfcc280be043a78466957152b91afedd32d13516fd5eba997b886c4fa407e3c02625c1e209aa4e6d8f7c98bb50f31734d5866241aa09edce2cdf3b18f350b497717296b55efd193ad82bcfec07a440638c6f8ba843e00427c536d2f11ab95d7e989b7f5cb714f0d331c22605ee4da98a6013f7d43f9c785bb94aae8d66c52102e4e70320cb688caf4dbe5a799231d5f619fa1e3dd67591b250a347648f2cc8eb0d0eeac922816546a457b3907bd83c1ff".match(/../g).map(h => parseInt(h, 16)));
const crc8 = (u8, c = 0) => { for (const b of u8) c = CRC8[c ^ b]; return c; };
function cobsEnc(u8) { const out = []; let blk = []; for (const b of u8) { if (b === 0) { out.push(blk.length + 1, ...blk); blk = []; } else { blk.push(b); if (blk.length === 254) { out.push(255, ...blk); blk = []; } } } out.push(blk.length + 1, ...blk); return Uint8Array.from(out); }
function cobsDec(u8) { const out = []; let i = 0; while (i < u8.length) { const code = u8[i]; if (code === 0) throw new Error('zero'); i++; for (let k = 0; k < code - 1; k++) out.push(u8[i + k]); i += code - 1; if (code < 255 && i < u8.length) out.push(0); } return Uint8Array.from(out); }
function teFrame(type, payload = new Uint8Array(0), seq = 0) { const b = Uint8Array.from([0x21, seq & 0xff, type, payload.length, ...payload]); return Uint8Array.from([...cobsEnc(Uint8Array.from([...b, crc8(b)])), 0]); }
function parseFrame(b) { if (b.length < 5) return null; const seq = b[1], type = b[2], len = b[3]; if (b.length !== 5 + len || crc8(b.slice(0, -1)) !== b[b.length - 1]) return null; return { seq, type, payload: b.slice(4, 4 + len) }; }

/* ---------------- TE SysEx (7-bit, MSB collector) ----------------
   Request framing per TE's own updater + our working swift helper:
     F0 00 20 76 <identity> 40 (40|20|id_hi) (id_lo) <cmd> <packed data> F7
   bit 0x40 (BIT_IS_REQUEST) MUST be set or the unit reads it as a response
   and ignores it.  Replies clear 0x40 and carry <cmd> <status> <packed data>. */
function pack7(d) { const out = []; for (let i = 0; i < d.length; i += 7) { const g = d.slice(i, i + 7); let m = 0; for (let k = 0; k < g.length; k++) m |= ((g[k] >> 7) & 1) << k; out.push(m); for (const b of g) out.push(b & 0x7f); } return out; }
function unpack7(a) { const out = []; for (let i = 0; i < a.length; i += 8) { const msb = a[i]; const g = a.slice(i + 1, i + 8); for (let k = 0; k < g.length; k++) out.push((g[k] & 0x7f) | (((msb >> k) & 1) << 7)); } return out; }
let reqId = 0;
function teReq(devId, cmd, data = new Uint8Array(0)) {
  reqId = (reqId + 1) & 0x0FFF;
  return Uint8Array.from([0xF0, 0x00, 0x20, 0x76, devId & 0x7f, 0x40,
    0x40 | 0x20 | ((reqId >> 7) & 0x1F), reqId & 0x7F, cmd & 0x7f,
    ...pack7(data), 0xF7]);
}
const UDI = Uint8Array.from([0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]);   // universal device inquiry
const rebootToMode = (devId, mode, delayMs = 1000) =>
  teReq(devId, 3, Uint8Array.from([0x01, mode, (delayMs >> 8) & 0xff, delayMs & 0xff]));
const infoQuery = devId => teReq(devId, 1, new Uint8Array(0));        // cmd 1 -> metadata string
let devId = 0x1C;                                                     // TE identity code (TX-6)

/* ---------------- MIDI ---------------- */
let access = null, midiIn = null, midiOut = null, midiQ = [], midiWaiter = null, lastFrom = '', portName = null;
function onMidi(ev) {
  if (ev.data[0] !== 0xF0) return;
  if (ev.target && ev.target.name) lastFrom = ev.target.name;
  midiQ.push(Array.from(ev.data));
  if (midiWaiter) { const w = midiWaiter; midiWaiter = null; w(); }
}
async function midiRead(ms) {
  if (!midiQ.length) { let tm; await Promise.race([new Promise(r => { midiWaiter = r; }), new Promise(r => { tm = setTimeout(r, ms); })]); clearTimeout(tm); midiWaiter = null; }
  return midiQ.shift() || null;
}
function onStateChange() {
  if (midiOut && midiOut.state === 'disconnected') {
    log('MIDI port "' + portName + '" dropped (unit rebooting?) - will re-open automatically', 'warn');
    midiOut = null; midiIn = null;
  }
}
async function openPair(name) {
  const outs = [...access.outputs.values()].filter(o => o.state !== 'disconnected');
  const ins = [...access.inputs.values()].filter(i => i.state !== 'disconnected');
  midiOut = outs.find(o => o.name === name) || null;
  midiIn = ins.find(i => i.name === name) || null;
  if (!midiOut) return false;
  await midiOut.open().catch(() => {});
  if (midiIn) { midiIn.onmidimessage = onMidi; await midiIn.open().catch(() => {}); }
  portName = name;
  return true;
}
async function ensureMIDI() {
  if (!access) return false;
  if (midiOut && midiOut.state !== 'disconnected') return true;
  const outs = [...access.outputs.values()].filter(o => o.state !== 'disconnected');
  if (!outs.length) return false;
  const o = outs.find(x => x.name === portName) || outs.find(x => /TX-6|teenage/i.test(x.name)) || outs[0];
  return openPair(o.name);
}
function parseTeReply(p) {
  if (p.length < 10 || p[0] !== 0xF0 || p[1] !== 0x00 || p[2] !== 0x20 || p[3] !== 0x76) return null;
  if (p[5] !== 0x40) return null;
  if ((p[6] & 0x40) !== 0) return null;                     // that's a request, not a reply
  const cmd = p[8], status = p[9];
  const packed = p.slice(10, p.length - 1);
  let data;
  try { data = Uint8Array.from(unpack7(packed)); } catch (_) { data = Uint8Array.from(packed); }
  return { cmd, status, data };
}
/* is the unit there and talking? (one info query, short window, no log spam) */
async function pingUnit(timeout = 1500) {
  if (!(await ensureMIDI())) return false;
  midiQ = [];
  try { midiOut.send(infoQuery(devId)); } catch (_) { return false; }
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const p = await midiRead(end - Date.now());
    if (!p) break;
    const r = parseTeReply(p);
    if (r && r.cmd === 1) return true;
  }
  return false;
}
/* full connect: permission -> knock UDI on every output -> sniff who answers -> handshake */
async function connectMIDI() {
  if (!navigator.requestMIDIAccess) { log('This browser has no WebMIDI - use Chrome or Edge on desktop.', 'err'); return false; }
  if (!access) {
    try { access = await navigator.requestMIDIAccess({ sysex: true }); access.onstatechange = onStateChange; }
    catch (e) {
      log('MIDI access denied: ' + e.message, 'err');
      log('If a prompt appeared, allow MIDI (SysEx) for this site and press the button again.', 'warn');
      return false;
    }
  }
  const outs = [...access.outputs.values()].filter(o => o.state !== 'disconnected');
  if (!outs.length) { log('no MIDI outputs found - is your TX-6 plugged in and powered on?', 'err'); return false; }
  const sel = $('port'); if (sel) sel.innerHTML = outs.map(o => `<option>${o.name}</option>`).join('');

  /* open every input so replies are heard no matter which port answers */
  for (const i of access.inputs.values()) { try { i.onmidimessage = onMidi; await i.open(); } catch (_) {} }

  midiQ = [];
  for (const o of outs) { try { await o.open(); o.send(UDI); } catch (_) {} }
  log('probing ' + outs.length + ' MIDI output' + (outs.length > 1 ? 's' : '') + '...', 'tx');
  let found = false;
  const end = Date.now() + 1600;
  while (Date.now() < end) {
    const p = await midiRead(end - Date.now());
    if (!p) break;
    if (p.length >= 9 && p[0] === 0xF0 && p[1] === 0x7E && p[3] === 0x06 && p[4] === 0x02 &&
        p[5] === 0x00 && p[6] === 0x20 && p[7] === 0x76) {
      devId = p[2]; found = true;
      log('TE device answered - identity 0x' + devId.toString(16).padStart(2, '0') + (lastFrom ? ' (replying on "' + lastFrom + '")' : ''), 'ok');
      break;
    }
  }
  const out = (lastFrom && outs.find(o => o.name === lastFrom)) ||
              outs.find(o => /TX-6|teenage/i.test(o.name)) ||
              (outs.length === 1 ? outs[0] : null);
  if (!out) {
    log((found ? 'heard a TE device but could not match its input to an output' : 'no UDI reply from any output') +
        ' - pick the port by hand in Plan B (manual controls).', 'warn');
    return false;
  }
  if (!(await openPair(out.name))) { log('could not open MIDI port "' + out.name + '"', 'err'); return false; }
  if (await pingUnit(1500)) { log('handshake ok - your unit is listening', 'ok'); return true; }
  log('your unit is there but did not answer the info query (cmd 1). Checklist:', 'err');
  log('  - powered on in normal mode (not already in update/console)?', 'warn');
  log('  - MIDI (SysEx) permission granted for this site?', 'warn');
  log('  - right output selected? (Plan B -> MIDI output)', 'warn');
  return false;
}
function sendMode(mode, label, delayMs = 1000) {
  if (!midiOut) { log('no MIDI output open', 'err'); return false; }
  try { midiOut.send(rebootToMode(devId, mode, delayMs)); }
  catch (e) { log('MIDI send failed: ' + e.message, 'err'); return false; }
  log('MIDI TX [reboot to ' + label + '] (mode ' + mode + ', identity 0x' + devId.toString(16) + ')', 'tx');
  return true;
}
/* wait for the unit to (re)appear: knock every ~2s until it answers info query */
async function waitForReturn(stepId, maxMs) {
  const t0 = Date.now(); let n = 0;
  while (Date.now() - t0 < maxMs) {
    if (stepId === 'install' && installDone) return true;
    if (await pingUnit(1200)) return true;
    n++;
    if (n % 4 === 0) st(stepId, 'active', 'waiting for device... (eject the disk if needed)');
    await sleep(1000);
  }
  return false;
}

/* ---------------- official firmware + patch ----------------
   We do NOT ship TE firmware. The user supplies their own official
   tx-6_firmware_1_3_3.tfw; we verify its SHA-256 and append a small
   ciphertext tail (window.TX6_PATCH) that supersedes the zip's central
   directory with a single entry: our patched bootloader. Without the
   user's file the patch is meaningless. */
const b64ToU8 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const PATCH = window.TX6_PATCH || null;
const APPEND = PATCH ? b64ToU8(PATCH.append_b64) : null;
let officialBytes = null, fileOk = false;

function crc16xm(u8, crc = 0) {
  for (let i = 0; i < u8.length; i++) {
    crc ^= u8[i] << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
const sha256hex = async u8 => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', u8)));

/* user's own file -> our installable image (or null) */
function applyPatch() {
  if (!PATCH || !officialBytes || !fileOk) return null;
  const out = new Uint8Array(PATCH.cut_file + APPEND.length);
  out.set(officialBytes.subarray(0, PATCH.cut_file), 0);
  out.set(APPEND, PATCH.cut_file);
  const L = PATCH.len_val;                                   // zip length, LE u32 in the container header
  out[PATCH.len_off] = L & 0xff; out[PATCH.len_off + 1] = (L >>> 8) & 0xff;
  out[PATCH.len_off + 2] = (L >>> 16) & 0xff; out[PATCH.len_off + 3] = (L >>> 24) & 0xff;
  const ci = crc16xm(out.subarray(0x80));                     // inner CRC-16/XMODEM [0x80..EOF)
  out[0x49] = ci >> 8; out[0x4a] = ci & 0xff;
  const co = crc16xm(out.subarray(0x40));                     // outer CRC-16/XMODEM [0x40..EOF) - covers 0x49
  out[0x05] = co >> 8; out[0x06] = co & 0xff;
  return out;
}

async function loadOfficial(file) {
  officialBytes = new Uint8Array(await file.arrayBuffer());
  const h = await sha256hex(officialBytes);
  fileOk = !!PATCH && officialBytes.length === PATCH.official_size && h === PATCH.official_sha256;
  const kb = (officialBytes.length / 1024).toFixed(1);
  $('vstatus').innerHTML = fileOk
    ? `<b>verified official 1.3.3</b> - ${kb} KB, SHA-256 <code>${h.slice(0, 16)}...</code>`
    : `not the official 1.3.3 file - ${kb} KB, SHA-256 <code>${h.slice(0, 16)}...</code>. Grab the exact file linked above.`;
  log('official file: ' + (fileOk ? 'verified' : 'REJECTED') + ' (' + officialBytes.length + ' bytes)', fileOk ? 'ok' : 'err');
  return fileOk;
}

function saveBlob(name, bytes) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = name; a.click();
  log('downloaded ' + name + ' (' + bytes.length + ' bytes)', 'ok');
}

/* disk picker + write - returns true, false, 'abort' (user cancelled) or 'nopick' (no fresh user activation).
   Pass an image to write something other than the patched build (e.g. the unmodified official file). */
async function pickAndWrite(image) {
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'tx6vol', mode: 'readwrite' }); }
  catch (e) { return (e && e.name === 'AbortError') ? 'abort' : 'nopick'; }
  const bytes = image || applyPatch();
  if (!bytes) { log('load and verify the official 1.3.3 .tfw first', 'err'); return false; }
  try {
    const fh = await dir.getFileHandle('tx6_force.tfw', { create: true });
    const w = await fh.createWritable();
    await w.write(bytes); await w.close();
  } catch (e) { log('write failed: ' + e.message, 'err'); return false; }
  log('wrote tx6_force.tfw (' + bytes.length + ' bytes) to "' + dir.name + '" - eject when ready', 'ok');
  return true;
}

/* ---------------- Serial console (Web Serial) ---------------- */
let ser = null, serWriter = null;
async function openSerial(port) {
  if (ser === port && serWriter) return;
  await port.open({ baudRate: 115200 });
  try { await port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch (_) {}
  ser = port; serWriter = port.writable.getWriter();
  const i = port.getInfo();
  log('serial open (usb ' + [i.usbVendorId, i.usbProductId].map(x => (x || 0).toString(16)).join(':') + ')', 'ok');
}
async function closeSerial() {
  if (!ser) return;
  try { await ser.close(); } catch (_) {}
  ser = null; serWriter = null;
}
async function serialExchange(frame, want, timeout = 2500) {
  if (!serWriter) return null;
  const buf = [];
  const reader = ser.readable.getReader();
  let done = false;
  const pump = (async () => {
    try {
      while (!done) {
        const { value, done: d } = await reader.read();
        if (d) break;
        if (value) for (const b of value) buf.push(b);
      }
    } catch (_) {}
  })();
  try { await serWriter.write(frame); } catch (e) { done = true; try { await reader.cancel(); } catch (_) {} return null; }
  const end = Date.now() + timeout;
  let got = null;
  while (Date.now() < end && !got) {
    let i;
    while ((i = buf.indexOf(0)) >= 0) {
      const chunk = Uint8Array.from(buf.splice(0, i)); buf.shift();
      if (!chunk.length) continue;
      try { const f = parseFrame(cobsDec(chunk)); if (f && (want === null || f.type === want)) got = f; } catch (_) {}
      if (got) break;
    }
    if (!got) await sleep(40);
  }
  done = true; try { await reader.cancel(); } catch (_) {}
  return got;
}
/* a port this site was already granted, preferring Teenage Engineering (VID 0x2367) */
async function grantedPort() {
  if (!navigator.serial) return null;
  try {
    const ports = await navigator.serial.getPorts();
    return ports.find(p => { const i = p.getInfo(); return i.usbVendorId === 0x2367; }) || ports[0] || null;
  } catch (_) { return null; }
}
/* open the console port (with retries while it re-enumerates) and sniff msg 0x1f */
async function sniffViaSerial(port) {
  st('read', 'active', 'opening the console port...');
  let opened = false;
  for (let i = 0; i < 6 && !opened; i++) {
    try { await openSerial(port); opened = true; }
    catch (e) { if (i === 5) { log('serial failed: ' + e.message, 'err'); return false; } await sleep(700); }
  }
  st('read', 'active', 'reading key...');
  for (let i = 0; i < 3; i++) {
    const r = await serialExchange(teFrame(0x1F, new Uint8Array(0), 0), 0x20, 3000);
    if (r && r.payload.length === 32) { keyValue = hex(r.payload); return true; }
    if (r && r.payload.length) log('console replied with ' + r.payload.length + ' bytes (not 32) - stock bootloader still installed?', 'warn');
    await sleep(400);
  }
  await closeSerial();
  return false;
}

/* Plan B: pull the OTP key without the wizard (connects the port if needed) */
async function manualReadKey() {
  if (!navigator.serial) { log('Web Serial not available - use Chrome/Edge on desktop', 'err'); return; }
  try {
    if (!serWriter) {
      let port = await grantedPort();
      if (!port) port = await navigator.serial.requestPort();
      await openSerial(port);
    }
  } catch (e) {
    if (e && e.name === 'AbortError') { log('no port picked', 'warn'); return; }
    log('serial failed: ' + e.message, 'err'); return;
  }
  for (let i = 0; i < 3; i++) {
    const r = await serialExchange(teFrame(0x1F, new Uint8Array(0), 0), 0x20, 3000);
    if (r && r.payload.length === 32) { keyValue = hex(r.payload); log('OTP key read', 'ok'); showKeys(); return; }
    if (r && r.payload.length) log('reply was ' + r.payload.length + ' bytes, not 32 - stock bootloader?', 'warn');
    await sleep(400);
  }
  log('no reply to 0x1f - is the TX-6 in console mode?', 'err');
}

/* Plan B: derive the built-in key from the loaded file + OTP key */
async function manualDerive() {
  if (!keyValue) { log('read the OTP key first - it decrypts your file', 'err'); return; }
  $('keybox').hidden = false;
  await deriveAndShowBuiltin();
}

/* ---------------- built-in key derivation ----------------
   The built-in key (container key index 0xFF) is NOT stored in this page.
   It is derived from the visitor's own file: decrypt the container with the
   OTP key, open the zip, decompress firmware/blackfin/bin/bootloader.ldr and
   read 32 bytes at a fixed offset. That is deterministic because the official
   1.3.3 file is pinned by SHA-256 above. Only the SHA-256 of the expected key
   is pinned here, to confirm the derived bytes. */
const BUILTIN_SHA256 = 'dc75ff3b23d69849261365f6f636707d274255bed2ccdfb16768f3054b9945ba';
const BUILTIN_OFFSET = 0x1F748;
const BUILTIN_MEMBER = 'firmware/blackfin/bin/bootloader.ldr';
let builtinKey = null;

/* minimal zip reader: central directory -> member bytes (store or deflate) */
async function zipMember(zip, name) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip EOCD not found');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const want = new TextEncoder().encode(name);
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    let match = nlen === want.length;
    for (let i = 0; match && i < nlen; i++) match = zip[p + 46 + i] === want[i];
    if (match) {
      if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('bad local header');
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const raw = zip.subarray(start, start + csize);
      if (method === 0) return raw;
      if (method !== 8) throw new Error('unsupported zip method ' + method);
      if (!('DecompressionStream' in window)) throw new Error('DecompressionStream unavailable');
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error('member not found: ' + name);
}

async function deriveBuiltinKey(otpHex) {
  if (!officialBytes || !fileOk) throw new Error('official 1.3.3 file not loaded');
  const iv = officialBytes.slice(0xF0, 0x100);
  const n = (officialBytes.length - 0x380) & ~15;
  const ck = await crypto.subtle.importKey('raw',
    Uint8Array.from(otpHex.match(/../g).map(h => parseInt(h, 16))),
    { name: 'AES-CBC' }, false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv }, ck, officialBytes.slice(0x380, 0x380 + n)));
  const ldr = await zipMember(pt.slice(0x100), BUILTIN_MEMBER);
  const key = ldr.subarray(BUILTIN_OFFSET, BUILTIN_OFFSET + 32);
  const sha = await sha256hex(key);
  return { hex: hex(key), ok: sha === BUILTIN_SHA256, sha };
}

/* ---------------- Decrypt (WebCrypto) ---------------- */
async function decrypt() {
  const f = $('f').files[0];
  if (!f) { $('dout').textContent = 'choose a .tfw first'; return; }
  const key = $('keyfield').value.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(key)) { $('dout').textContent = 'the key field needs exactly 64 hex chars'; return; }
  const buf = new Uint8Array(await f.arrayBuffer());
  if (buf.length < 0x500) { $('dout').textContent = 'file too small'; return; }
  const iv = buf.slice(0xF0, 0x100);
  const n = (buf.length - 0x380) & ~15;
  try {
    const ck = await crypto.subtle.importKey('raw', Uint8Array.from(key.match(/../g).map(h => parseInt(h, 16))), { name: 'AES-CBC' }, false, ['decrypt']);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, buf.slice(0x380, 0x380 + n)));
    const name = new TextDecoder().decode(pt.slice(0, 32)).split('\0')[0];
    const zip = pt.slice(0x100);
    const ok = zip[0] === 0x50 && zip[1] === 0x4b;
    log('decrypt: name=' + name + ' zip=' + ok, ok ? 'ok' : 'err');
    $('dout').innerHTML = `filename <b>${name}</b> - zip ${ok ? 'ok' : 'failed'} (${zip.length} bytes)<br>`;
    if (ok) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
      a.download = f.name.replace(/\.tfw$/, '') + '.zip';
      a.textContent = 'download the decrypted zip';
      $('dout').appendChild(a);
    }
  } catch (e) { log('decrypt failed: ' + e.message, 'err'); $('dout').textContent = 'decrypt failed - wrong key?'; }
}

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1900);
}

/* ---------------- the wizard ---------------- */
let checkOk = false, midiReady = false, installDone = false, keyGot = false, keyValue = '';

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
  $('install').disabled = installDone || !(midiReady && fileOk);
  $('grab').disabled = !installDone;
  $('done').disabled = !keyGot;
}

function supportCheck() {
  const has = [['MIDI', !!navigator.requestMIDIAccess], ['Serial', !!navigator.serial], ['Disk', !!window.showDirectoryPicker], ['Crypto', !!crypto.subtle]];
  $('support').innerHTML = has.map(([n, v]) => `<span class="chip ${v ? 'on' : 'off'}">${n}: ${v ? 'ok' : 'missing'}</span>`).join('');
  const https = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  checkOk = has.every(([, v]) => v) && https;
  if (checkOk) {
    st('check', 'done', 'ready');
    $('checkhint').textContent = 'All required browser features are available.';
    activate('connect');
  } else {
    st('check', 'fail', 'unsupported');
    $('checkhint').innerHTML = !https
      ? 'Serve this page over <b>https</b> (the hosted version is fine) - the browser APIs need a secure context.'
      : 'This browser is missing required features. Use <b>Chrome or Edge on a desktop</b>.';
  }
  refresh();
}

function finishInstall() {
  installDone = true;
  st('install', 'done', 'device connected');
  log('device is back - ready to read the key', 'ok');
  activate('read');
  refresh();
}

function showKeys() {
  $('keyout').textContent = keyValue;
  $('keybox').hidden = false;
  $('keyfield').value = keyValue;
  keyGot = true;
  refresh();
  $('keybox').scrollIntoView({ behavior: 'smooth', block: 'center' });
  deriveAndShowBuiltin();
}

function keyFound() {
  st('read', 'done', 'key saved');
  activate('done');
  showKeys();
  log('OTP key: ' + keyValue, 'ok');
}

async function deriveAndShowBuiltin() {
  if (builtinKey) { $('keyout2').textContent = builtinKey; return; }
  $('keymeta2').textContent = 'Deriving from your firmware...';
  try {
    const r = await deriveBuiltinKey(keyValue);
    if (!r.ok) throw new Error('SHA-256 mismatch');
    builtinKey = r.hex;
    $('keyout2').textContent = builtinKey;
    $('keymeta2').textContent = 'Derived from the bootloader in your file, verified by SHA-256. Decrypts OP-Z and OP-1 field <= 1.1.5 firmware; not used by TX-6 .tfw.';
    log('built-in key derived from bootloader.ldr - SHA-256 verified', 'ok');
  } catch (e) {
    log('built-in key derivation failed: ' + e.message, 'err');
    $('keymeta2').textContent = 'Could not derive it: ' + e.message + '. Load the verified official 1.3.3 file, then try again.';
  }
}

async function installFlow() {
  $('install').disabled = true; $('b-pick').hidden = true; $('b-back').hidden = true;
  if (!midiReady) {
    st('install', 'active', 'connecting over MIDI...');
    if (!(await connectMIDI())) { st('install', 'fail', 'no MIDI - connect the TX-6 first (step 2)'); refresh(); return; }
    midiReady = true;
  }
  st('install', 'active', 'switching to update mode...');
  if (!(await ensureMIDI())) { st('install', 'fail', 'your TX-6 went quiet - still plugged in?'); refresh(); return; }
  if (!sendMode(2, 'update-disk', 800)) { st('install', 'fail', 'could not reach the TX-6'); refresh(); return; }
  await pickWriteWait();
}

async function pickWriteWait() {
  st('install', 'active', 'pick the TX-6 disk...');
  let r;
  try { r = await pickAndWrite(); } catch (e) { log('picker failed: ' + e.message, 'err'); r = 'nopick'; }
  if (r === 'abort') { st('install', 'active', 'cancelled - press the button to retry'); refresh(); return; }
  if (r === 'nopick') { st('install', 'active', 'dialog needs a new click - use the button below'); $('b-pick').hidden = false; return; }
  if (r !== true) { st('install', 'fail', 'the write failed - see the log or Plan B'); refresh(); return; }
  st('install', 'active', 'written. Eject the TX-6 disk (Cmd+E) to start the upgrade.');
  setTimeout(() => { if (!installDone) $('b-back').hidden = false; }, 30000);
  if (await waitForReturn('install', 300000)) finishInstall();
  else st('install', 'active', 'no device yet - after UPGRADE -> DONE, press "Continue".');
}

async function grabFlow() {
  $('grab').disabled = true; $('grab2').hidden = true;
  st('read', 'active', 'checking the device...');
  const awake = await pingUnit(1500) || await waitForReturn('read', 45000);
  if (!awake) { st('read', 'fail', 'no answer - is the TX-6 powered on and connected?'); refresh(); return; }
  st('read', 'active', 'switching to console mode...');
  if (!(await ensureMIDI()) || !sendMode(4, 'console', 800)) { st('read', 'fail', 'MIDI hiccup - press again'); refresh(); return; }
  await sleep(1300);
  st('read', 'active', 'connecting to the console...');
  let port = await grantedPort();
  if (!port) {
    st('read', 'active', 'pick the TX-6 port...');
    try { port = await navigator.serial.requestPort(); }
    catch (e) {
      if (e && e.name === 'AbortError') { st('read', 'active', 'no port picked - press again when ready'); refresh(); return; }
      st('read', 'active', 'dialog needs a new click - use the button below');
      $('grab2').hidden = false; return;
    }
  }
  const got = await sniffViaSerial(port);
  if (got) keyFound();
  else { st('read', 'fail', 'no reply - press again (see log)'); refresh(); }
}

/* ---------------- wiring ---------------- */
window.addEventListener('DOMContentLoaded', () => {
  supportCheck();
  refresh();

  $('conn').onclick = async () => {
    $('conn').disabled = true; $('connhint').hidden = true;
    activate('connect', 'connecting...');
    const ok = await connectMIDI();
    if (ok) { midiReady = true; st('connect', 'done', 'connected'); activate('firmware'); refresh(); }
    else { st('connect', 'fail', 'no answer'); $('connhint').hidden = false; refresh(); }
  };

  const takeFirmware = async (file) => {
    if (!file) return;
    activate('firmware', 'checking the file...');
    const ok = await loadOfficial(file);
    if (ok) {
      $('drop').classList.add('ok');
      $('drop').innerHTML = '<b>' + file.name.replace(/[<>&]/g, '') + '</b><br><span class="sub">verified</span>';
      st('firmware', 'done', 'verified');
      activate('install');
      if (keyGot && !builtinKey) deriveAndShowBuiltin();    /* key read out of order (Plan B) - derive now */
    } else {
      $('drop').classList.remove('ok');
      st('firmware', 'fail', 'not the 1.3.3 file');
    }
    refresh();
  };
  $('fw').onchange = () => takeFirmware($('fw').files[0]);
  const drop = $('drop');
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hover'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hover'); }));
  drop.addEventListener('drop', e => takeFirmware(e.dataTransfer.files[0]));

  $('install').onclick = installFlow;
  $('b-pick').onclick = () => { $('b-pick').hidden = true; pickWriteWait(); };
  $('b-back').onclick = () => { $('b-back').hidden = true; finishInstall(); };

  $('grab').onclick = grabFlow;
  $('grab2').onclick = async () => {
    $('grab2').hidden = true;
    st('read', 'active', 'pick the TX-6 port...');
    try {
      const port = await navigator.serial.requestPort();
      const got = await sniffViaSerial(port);
      if (got) keyFound();
      else { st('read', 'fail', 'still no reply - press "Read key" again'); refresh(); }
    } catch (e) {
      if (e && e.name === 'AbortError') { st('read', 'active', 'no port picked - use the button below when ready'); $('grab2').hidden = false; }
      else { st('read', 'fail', 'serial failed: ' + e.message); refresh(); }
    }
  };

  $('done').onclick = async () => {
    st('done', 'active', 'sending your TX-6 back to normal...');
    let ok = false;
    try {
      if (!serWriter) { const p = await grantedPort(); if (p && !p.readable) await openSerial(p); }
      if (serWriter) { await serialExchange(teFrame(0x0D, Uint8Array.from([0x18]), 0), null, 400); ok = true; }
    } catch (e) { log('reboot-normal failed: ' + e.message, 'err'); }
    if (ok) log('sent reboot-normal (msg 0x0d sub 0x18)', 'ok');
    st('done', ok ? 'done' : 'fail', ok ? 'done - back to normal mode' : 'could not reach the console - power-cycle the TX-6');
    if (ok) $('factory').hidden = false;
  };

  /* optional cleanup: put the official firmware back over the patched bootloader */
  $('factory-flash').onclick = async () => {
    if (!fileOk) { log('load and verify the official 1.3.3 .tfw first', 'err'); return; }
    $('factory-flash').disabled = true;
    st('done', 'active', 'checking your TX-6 is awake...');
    const awake = await pingUnit(1500) || await waitForReturn('done', 60000);
    if (!awake) { st('done', 'fail', 'no answer from your TX-6 - is it powered on?'); $('factory-flash').disabled = false; return; }
    st('done', 'active', 'switching to update mode...');
    if (!(await ensureMIDI()) || !sendMode(2, 'update-disk', 800)) {
      st('done', 'fail', 'could not reach the TX-6');
      $('factory-flash').disabled = false; return;
    }
    st('done', 'active', 'pick the TX-6 disk in the dialog...');
    let r;
    try { r = await pickAndWrite(officialBytes); } catch (e) { log('picker failed: ' + e.message, 'err'); r = 'nopick'; }
    if (r === 'abort') { st('done', 'active', 'cancelled - press the button to retry'); $('factory-flash').disabled = false; return; }
    if (r === 'nopick') { st('done', 'active', 'the dialog needs a fresh click - press again'); $('factory-flash').disabled = false; return; }
    if (r !== true) { st('done', 'fail', 'the write failed - see the log'); $('factory-flash').disabled = false; return; }
    st('done', 'active', 'written. Eject the TX-6 disk (Cmd+E) to start the install.');
    const back = await waitForReturn('done', 300000);
    st('done', back ? 'done' : 'fail', back ? 'factory firmware installed' : 'no device yet - after UPGRADE -> DONE you are done');
    if (back) { $('factory').hidden = true; log('factory firmware installed - unit is back to stock', 'ok'); }
    else $('factory-flash').disabled = false;
  };

  const copyTo = async (value, el, what) => {
    try { await navigator.clipboard.writeText(value); toast(what + ' copied'); }
    catch (_) {
      const r = document.createRange(); r.selectNodeContents(el);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      toast('selected - press Cmd+C');
    }
  };
  $('copy').onclick = () => copyTo(keyValue, $('keyout'), 'OTP key');
  $('copy2').onclick = () => {
    if (!builtinKey) { toast('built-in key not derived yet'); return; }
    copyTo(builtinKey, $('keyout2'), 'built-in key');
  };

  $('useport').onclick = async () => {
    const name = $('port').value;
    if (!name) { log('pick a MIDI output first', 'warn'); return; }
    if (!(await openPair(name))) return;
    if (await pingUnit(1500)) { midiReady = true; log('port "' + name + '" answers', 'ok'); refresh(); }
    else log('no reply from "' + name + '" - try a different port?', 'warn');
  };
  const manualMode = async (mode, label) => {
    if (!(await ensureMIDI())) { log('no MIDI open - press "Find my TX-6" first', 'err'); return; }
    if (!(await pingUnit(1500))) log('no reply to the info query - sending anyway', 'warn');
    sendMode(mode, label);
  };
  $('mm-up').onclick = () => manualMode(2, 'update-disk');
  $('mm-con').onclick = () => manualMode(4, 'console');
  $('mm-midi').onclick = async () => {
    if (await connectMIDI()) { midiReady = true; refresh(); }
  };
  $('mm-fw').onclick = () => $('fw').click();
  $('mm-write').onclick = async () => {
    const r = await pickAndWrite();
    if (r === 'abort') log('no disk picked', 'warn');
    else if (r === 'nopick') log('the dialog needs a fresh click - press again', 'warn');
    else if (r === true) log('now eject the TX-6 disk (Cmd+E) to start the upgrade', 'warn');
  };
  $('mm-otp').onclick = manualReadKey;
  $('mm-derive').onclick = manualDerive;
  $('mm-norm').onclick = async () => {
    try {
      if (!serWriter) { const p = await grantedPort(); if (p && !p.readable) await openSerial(p); }
      if (serWriter) { await serialExchange(teFrame(0x0D, Uint8Array.from([0x18]), 0), null, 400); log('sent reboot-normal', 'tx'); return; }
    } catch (_) {}
    log('no serial console open - power-cycle the TX-6 instead', 'warn');
  };

  $('dl').onclick = () => {
    const img = applyPatch();
    if (!img) { log('load and verify the official 1.3.3 .tfw first', 'err'); return; }
    saveBlob('tx6_force.tfw', img);
  };
  $('restore').onclick = async () => {
    if (!fileOk) { log('load and verify the official 1.3.3 .tfw first', 'err'); return; }
    const r = await pickAndWrite(officialBytes);
    if (r === true) log('that was the unmodified official 1.3.3 - eject the disk to install it (UPGRADE -> DONE)', 'warn');
  };

  $('dec').onclick = decrypt;
  $('clear').onclick = () => { logEl().textContent = ''; };

  log(APPEND ? 'Ready - patch loaded (' + APPEND.length + ' B tail; needs the official 1.3.3 file).'
             : 'patch.js missing - reload the page.', APPEND ? 'ok' : 'err');
  log('Flow: connect -> load official 1.3.3 -> install + eject -> read key -> return to normal.');
});
