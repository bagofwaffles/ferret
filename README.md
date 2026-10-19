# Ferret

Bag of Waffles' browser tools for Teenage Engineering hardware. First one up:

| device | tool | what it does |
|---|---|---|
| **TX-6** | [Ferret](tx-6/) | Reads the unit's AES-256 keys in the browser - no server, no build step |

More devices will land as sibling folders next to `tx-6/`.

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

Run it locally:

```bash
cd tx-6
python3 -m http.server 8000      # -> http://localhost:8000/
```

Requires **Chrome or Edge on a desktop** (WebMIDI + Web Serial + File System
Access all need a secure context). Full technical write-up:
[`tx-6/README.md`](tx-6/README.md).

## Disclaimers

- Not affiliated with Teenage Engineering.

## License

[MIT](LICENSE)
