# Nix64

A real Commodore 64 platform for Omarchy by nixfred.

VICE `x64sc` is the engine. Machines are single declarative files, several can run at
once, a real AI agent can drive the C64 while you watch, and real internet and real
hardware (drives, SID chips, keyboards, joysticks) connect like they would on a VM.

Status: foundation work. Private until v1.

- `patches/` changes to VICE 3.10 (GPL-2.0-or-later), applied by the package build
- `tests/` checks for those patches

Credits: see `CREDITS.md`.
