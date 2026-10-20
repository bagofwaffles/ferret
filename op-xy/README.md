# Ferret - OP-XY dev mode | a **Bag of Waffles** tool

Turns on the hidden **dev menu** in a Teenage Engineering OP-XY's te-boot -
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
2. **Enter te-boot** - power the OP-XY off, hold **COM** while powering on,
   connect USB. Stay on the te-boot menu: that is where the unit's MIDI
   interface comes up.
3. **Find my OP-XY** - one press: MIDI permission prompt, then the page probes
   every MIDI output with a te-boot metadata request and locks onto the port
   that answers. The unit's serial + versions are shown as confirmation.
4. **Enable or disable dev mode** - one press each: read OTP field `0x13`
   (`0x1F`), compute the `0xAC` response, send the command (write or delete).
   te-boot only redraws its menu when you navigate, so press **8** (system
   menu) then **8** (back) to make the **3. dev menu** entry appear or
   disappear. (No readback exists over MIDI, so that screen check is the
   confirmation - the wizard shows you exactly what to look for; see the notes
   below.) After that, power-cycle whenever you like: dev mode persists until
   `bootloader.dev` is removed.

Plan B has the same actions as individual buttons, plus: turn dev mode **off**,
read the metadata/OTP field, pick the MIDI port by hand, reboot to the normal
OS, and show the exact `0x1F` / `0xAC` bytes for a pasted OTP field (no device
needed).

## What the commands are

te-boot's console speaks TE's serial framing (`COBS + CRC-8`, `route 0x21`,
`crc8` poly `0x4D` reflected):

```
te-serial wire : COBS([0x21][seq][cmd][len][payload][crc8]) + 0x00
MIDI message   : F0 00 20 76 21 66 <wire, 7-bit packed> F7
```

| cmd | what it does |
|---|---|
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
- While the te-boot *menu* is up, the unit's USB MIDI interface ("OP-XY Midi")
  is present. Pressing **track 1** ("upload firmware") switches the unit to its
  disk personality and the MIDI port disappears - stay on the menu, or
  power-cycle with COM held.
- **There is no way to read dev mode back.** te-boot's command set (console:
  `01/03/04/05/06/07/09/0b/0c/0d/1f/ac/b0`; MIDI side: `01/02/09/0d/1f/ac`;
  control subs: `02/03/05/18/aa/ab/ee`) has no state query, the dev flag is only
  ever consumed to render the menu, and `0xAC` deliberately sends no reply -
  even on success. That is why the wizard points you at the OP-XY screen
  ("3. dev menu", after **8** -> system menu -> **8** back to re-render it): it
  is the one and only confirmation, for both enabling and disabling.
- What the page *does* verify: the 16-byte response it sends is derived from a
  live `0x1F` read of your unit (so it cannot be stale or mistyped), and after
  the command it pings the unit again to confirm the session survived. If the
  screen does not change, "send again" is offered.
- The page never touches firmware, SPI or the OS partitions, and never reads key
  material. Entering the dev menu and using its items (MTP transfer, factory
  reset, "write os to boot partition") is where things get destructive - read
  the warnings if you go on.
- Turning dev mode off: re-enter te-boot and use **Plan B -> Turn dev mode off**
  - te-boot deletes `bootloader.dev` and clears the flag.