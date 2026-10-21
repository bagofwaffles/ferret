# Ferret - TX-6 key reader | a **Bag of Waffles** tool

Ferret is a fully client-side wizard that reads the AES-256 keys out of a
Teenage Engineering TX-6 firmware update file - no server, no backend, no build
step, nothing uploaded.

```
index.html     the guided wizard (UI + instructions)
app.js         all logic (WebMIDI + File System Access + Web Serial + WebCrypto)
patch.js       our patch: a ~120 KB ciphertext tail (base64) + parameters
```

All styling and the shared images live in `../assets/` (one stylesheet for every
page) - serve the repo root, not this folder alone.

**No TE firmware and no keys are shipped here** - and the page itself stores no
key material. `patch.js` only contains a small ciphertext blob that has to be
*appended to the visitor's own official `tx-6_firmware_1_3_3.tfw`* - without that
file the patch produces nothing usable. The OTP key is read from the unit; the
built-in key is derived from the visitor's own file (see below).

## Flow

1. **Browser check** - automatic: WebMIDI / Web Serial / File System Access /
   WebCrypto and the secure context.
2. **Connect your TX-6** - one press: MIDI permission prompt, a Universal Device
   Inquiry sent to every output, port auto-picked from the reply, info-query
   handshake. (No separate "test" button.) Manual port override in Plan B.
3. **Load the official firmware** - drop the official `tx-6_firmware_1_3_3.tfw`
   (download link inline) or click to choose. SHA-256 verified automatically;
   the wizard advances on success.
4. **Install the patch** - one press: switches the unit to update-disk mode over
   MIDI, opens the volume picker *immediately* (so browser user-activation is
   still valid), writes `tx6_force.tfw`, then asks you to eject (Cmd+E) and polls
   MIDI until the unit reboots and answers again. Fallbacks: "Pick the TX-6 disk"
   (activation expired) and "Continue" (skip the polling).
5. **Read the key** - one press: console mode over MIDI, serial port reused from
   a previous grant if possible (first time only: port dialog), msg `0x1f` sent
   with retries. The OTP key appears immediately; the built-in key is then
   derived from the verified file (see below).
6. **Return to normal mode** - one press: reboot-normal over serial (`0x0d 0x18`).
   Once the unit is back, the page **recommends re-flashing the factory firmware**
   (one click: update mode -> write the official file -> eject) to overwrite the
   patched bootloader - don't leave the unit on the patched build. The same flow
   stays available in Plan B.

## The two keys

| key | where it comes from | decrypts |
|---|---|---|
| **OTP key** | read live from the TX-6 (console `0x1f` -> OTP rows 3\|4) | every TX-6 `.tfw` |
| **Built-in key** | derived in-browser from the visitor's own file: decrypt the container with the OTP key -> `firmware/blackfin/bin/bootloader.ldr` (deflate via `DecompressionStream`) -> 32 bytes at `0x1F748` | OP-Z `.zfw`, OP-1 Field <= 1.1.5; **not** TX-6 `.tfw` |

Offset `0x1F748` is deterministic because the official 1.3.3 file is SHA-pinned.
The page ships only the **SHA-256 of the expected built-in key** - not the key -
and refuses to show a result that doesn't match it. Verification notes for the
key itself live in the private reverse-engineering workspace.

Extras: a decrypt drawer (auto-filled with the OTP key), Plan B (every step as a
manual button - connect MIDI, choose file, mode switches, write patched `.tfw`,
read OTP key, derive built-in key, reboot), and a live log.

## How the patch works

The visitor downloads the official `tx-6_firmware_1_3_3.tfw` themselves (the page
links to archive.org). The stream inside is `AES-256-CBC` with TE's product key and
holds `firmware_secure.zip`. The page:

1. verifies the file's **SHA-256** against the pinned value
   (`9c3a13c5...d36db0`) - anything else is refused;
2. appends a ciphertext tail, encrypted with the same key and CBC-chained to the
   official file's last block, so it decrypts *as if it had always been there*;
3. fixes the container length word and the two CRC-16s.

The appended plaintext is a second zip central directory carrying exactly **one**
member: `firmware/blackfin/bin/bootloader.ldr`, patched so that console message
`0x1f` calls the ROM's `otp_get` and returns the full 32-byte key. The installer
reads the *last* EOCD, so it sees just that one member and installs it as an
ordinary bootloader update.

Net effect: the visitor's own official firmware + a 34-byte code patch, which is
inert on its own.

## Notes / caveats

- Only **Chrome/Edge desktop** support all three APIs (WebMIDI, Web Serial, File
  System Access). Mobile browsers don't - the browser check says so.
- No keys are stored in the site, and nothing is sent to a server. The page
  writes only to the visitor's own TX-6 (via its update disk, over USB) and to
  their downloads folder; the official file is read locally.
- The install is **reversible**: it's an ordinary firmware update, and the
  bootloader falls back to the previous one on CRC failure.
- The *displaced* code block is byte-identical in bootloader `1000.2.8` (firmware
  1.0.8-1.2.5) and `1000.3.2+0` (1.3.3), so the builder locates it by fingerprint
  rather than a fixed offset - but the **address it calls is per-build** (1.3.3+1,
  bootloader `1000.3.3`, moves it to `0x08037e58`).
