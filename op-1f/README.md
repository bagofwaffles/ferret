# Ferret - OP-1 Field dev mode | a **Bag of Waffles** tool

Turns on the hidden **dev menu** in a Teenage Engineering OP-1 Field's te-boot -
entirely in the browser, no server, no build step, nothing uploaded.

```
index.html     the guided wizard (UI + instructions)
app.js         all logic (WebMIDI + the te-boot protocol)
```

No firmware and no keys are involved anywhere on this page: it only sends
te-boot console commands over USB MIDI, and te-boot itself writes its own
`bootloader.dev` marker. The dev-mode command is checked against a value the
unit reports live over the same interface.



## Flow

1. **Browser check** - automatic: WebMIDI (SysEx) + the secure context.
2. **Enter te-boot** - power the OP-1 Field off, hold **COM** while powering on,
   connect USB. Stay on the te-boot menu: that is where the unit's MIDI
   interface comes up.
3. **Find my OP-1 Field** - one press: MIDI permission prompt, then the page
   identifies the unit (Universal Device Inquiry + TE-MIDI `0x01` greet) and
   probes the packed te-serial headers with the read-only `0x09` metadata
   query. The unit's serial + versions are shown as confirmation.
4. **Enable or disable dev mode** - one press each: read OTP field `0x13`
   (`0x1F`), compute the `0xAC` response, send the command (write or delete).
   te-boot only redraws its menu when you navigate, so leave the menu and come
   back to make the hidden dev entry appear or disappear. (No readback exists,
   so that screen check is the confirmation.) After that, power-cycle whenever
   you like: dev mode persists until `bootloader.dev` is removed.

Plan B has the same actions as individual buttons, plus: pick the MIDI port by
hand, read metadata / OTP field, probe headers again, reboot to normal
(`0x0d 0x18`), and show the exact `0x1F` / `0xAC` bytes for a pasted OTP field
(no device needed).

## What the commands are

te-boot's console speaks TE's serial framing (`COBS + CRC-8`, `route 0x21`,
`crc8` poly `0x4D` reflected):

```
te-serial wire : COBS([0x21][seq][cmd][len][payload][crc8]) + 0x00
MIDI message   : F0 00 20 76 02 66 <wire, 7-bit packed> F7
```

The header is the OP-1 Field's own: its `MidiCommandHandler` compares
`F0 00 20 76 02 66` and its reply builder emits the same envelope. The OP-XY
uses `F0 00 20 76 21 66` instead, so the page probes both (OP-1 Field first).

## Why the MIDI path works (evidence)

Recovered from the decrypted OP-1 Field 1.1.4 bootloader (te-boot `1000.0.34`):

- SysEx dispatcher `FUN_889e2a08`: after the identity-request branch it checks
  `F0 00 20 76 02 66` (bytes 0..5) and hands `buf+6`, `len-7` to the 7-bit
  unpacker. That is the packed te-serial path, not the DFU path.
- Reply builder `FUN_889e2410` writes `F0 00 20 76 02 66 ... F7`, so replies use
  the same header.
- Serial command table at `0x889e1950` contains
  `01 03 04 05 06 07 09 0b 0d 1f ac b0`; the MIDI route table at `0x889e31d4`
  contains `06 01 02 09 0d 1f ac`.
- `FUN_889e1ed0` is the usual TE 7-bit unpacker (one MSB byte followed by up to
  seven data bytes), so the payload is exactly the COBS + CRC-8 te-serial frame.

The earlier live probe in the RE workspace tried `21 66`, `00 66`, `01 66`,
`40 66` and `7f 66` - but not `02 66` - which is why it concluded the OP-1
field's MIDI was DFU-only. It is not; the header is device-specific.

| cmd | what it does |
|---|---|
| `0x01` | TE-MIDI greet (separate 7-bit dialect, used for identification/metadata) |
| `0x09` | reply metadata (mode, serial, versions) - used to find/verify te-boot |
| `0x1f` | read **OTP field `0x13`**, 16 bytes - the dev-mode "challenge" |
| `0xac` | dev marker: payload `99 4A F3 ED \| otp13 ^ 994AF3ED \| marker \| op` |
| `0x0d` | control - sub `0x18` reboots to the normal OS |

The `0xAC` payload: `sig[i] = otp13[i] ^ {99,4A,F3,ED}[i % 4]`; marker `0xBA`
writes **`bootloader.dev`** (the dev menu), `0xBE` writes `op1.dev`; op `0xA7`
writes, anything else deletes. On success te-boot also sets its runtime dev flag
unconditionally - which is why the menu entry shows up without a reboot, after a
menu round-trip (the entry is only consulted when the menu re-renders).

## Notes / caveats

- Only **Chrome/Edge desktop** have WebMIDI with SysEx. Mobile browsers don't -
  the check says so.
- The unit must be running **te-boot** (COM held at power-on). In normal OS mode
  the OS owns the MIDI port and does not answer these commands.
- The MIDI interface is only present while the te-boot *menu* is up. If you
  switch to disk/DFU mode the port disappears - power-cycle with COM held.

- **There is no way to read dev mode back.** te-boot's command set has no state
  query, the dev flag is only ever consumed to render the menu, and `0xAC`
  deliberately sends no reply - even on success. That is why the wizard points
  you at the OP-1 Field screen: it is the one and only confirmation, for both
  enabling and disabling.
- What the page *does* verify: the 16-byte response it sends is derived from a
  live `0x1F` read of your unit (so it cannot be stale or mistyped), and after
  the command it pings the unit again to confirm the session survived.
- The page never touches firmware, SPI or the OS partitions, and never reads key
  material. Entering the dev menu and using its items is where things get
  destructive - read the warnings if you go on.
- Turning dev mode off: re-enter te-boot and use **Disable dev mode** - te-boot
  deletes `bootloader.dev` and clears the flag.
