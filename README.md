# Ferret

**[bagofwaffles.github.io/ferret](https://bagofwaffles.github.io/ferret/)**

Bag of Waffles' browser tools for Teenage Engineering hardware. Everything runs
client-side: no server, no build step, nothing uploaded. The root page is a
device picker; each device lives in its own sibling folder.

| device | tool | what it does |
|---|---|---|
| **TX-6** | [tx-6/](tx-6/) | Reads the unit's AES-256 keys in the browser - no server, no build step |
| **OP-XY** | [op-xy/](op-xy/) | Walks you through enabling the hidden dev menu in te-boot, over the unit's USB MIDI interface |

More devices will land as sibling folders next to `tx-6/` and `op-xy/`, with a
card on the root page.

## Ferret - TX-6 key reader

Ferret reads the two AES-256 keys that matter around TE firmware:

- **OTP key** - read live from your TX-6 over its USB console (msg `0x1f` -> OTP
  rows 3 and 4). Decrypts every TX-6 `.tfw`.
- **Built-in key** - derived at runtime from your own official firmware file and
  verified against a pinned SHA-256. Decrypts OP-Z `.zfw` and OP-1 field <= 1.1.5
  firmware.

**This repository contains no keys and no TE firmware.** The OTP key is read from
the connected unit; the built-in key is computed from the visitor's own
`tx-6_firmware_1_3_3.tfw` in their browser. Nothing is ever sent to a server.

> ** Flashing modifies your unit's firmware - use at your own risk. ** 
> It goes in as a normal firmware update, and when you're done the page has you
> **re-flash the factory firmware** so the patched build doesn't stay on your unit.

## Ferret - OP-XY dev mode

Turns on te-boot's hidden dev mode (`3. dev menu`) on an OP-XY, entirely in the
browser. It finds the unit's te-boot USB MIDI interface, talks to it with TE
SysEx messages, and sends the documented `0xAC` dev-marker command - whose
challenge value is read live from the unit (`0x1F` returns OTP field `0x13`).

No firmware and no keys are involved: te-boot writes its own `bootloader.dev`
marker, and Plan B can turn the mode back off. Full write-up in
[`op-xy/README.md`](op-xy/README.md).

Run it locally:

```bash
python3 -m http.server 8000      # serve the repo root -> http://localhost:8000/
```

All styling (one stylesheet shared by the picker and every tool) and the shared
images live in `assets/`; each device folder keeps only its page and its
JavaScript. Serve the repo root so `../assets/` resolves.

Requires **Chrome or Edge on a desktop** (the tools use File System Access, Web
Serial and WebMIDI, which all need a secure context). Per-tool technical
write-ups: [`tx-6/README.md`](tx-6/README.md) and [`op-xy/README.md`](op-xy/README.md).

## Disclaimers

- Not affiliated with Teenage Engineering.

## License

[MIT](LICENSE)