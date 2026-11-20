<div align="center">

<img src="assets/nix64-banner.svg" alt="Nix64: a real C64 platform for Omarchy, by nixfred" width="100%">

# READY.

**A real Commodore 64 on your Omarchy desktop, with a real AI agent sitting at its prompt.**

<p>
<img alt="License GPL-2.0-or-later" src="https://img.shields.io/badge/license-GPL--2.0--or--later-3B82F6?style=for-the-badge">
<img alt="Engine VICE x64sc 3.10" src="https://img.shields.io/badge/engine-VICE%20x64sc%203.10-6C5EB5?style=for-the-badge">
<img alt="Platform Omarchy" src="https://img.shields.io/badge/platform-Omarchy-1E3A8A?style=for-the-badge">
<img alt="Status foundation" src="https://img.shields.io/badge/status-foundation-F59E0B?style=for-the-badge">
<img alt="Observer effect none measured" src="https://img.shields.io/badge/observer%20effect-none%20measured-22C55E?style=for-the-badge">
</p>

[The pitch](#the-pitch) &nbsp;|&nbsp; [What it will be](#what-it-will-be) &nbsp;|&nbsp; [Proof](#proof-whats-real-today) &nbsp;|&nbsp; [Try it](#try-the-proof) &nbsp;|&nbsp; [Roadmap](#roadmap) &nbsp;|&nbsp; [Ground rules](#ground-rules) &nbsp;|&nbsp; [Credits](CREDITS.md)

</div>

---

## The pitch

Nix64 is not a skin on an emulator and it is not a chatbot parked beside one.

It puts a **real C64** on your desktop and a **real AI agent inside it**. The agent works at the C64's own
prompt. It sees the same screen you see. It types into the machine while you watch, one keystroke at a
time, and the software it builds is real software on a real disk image that you keep. Or it stays quiet until
you stumble, then offers to do the thing for you or walk you through it. If you already know your way around
a C64, it gets out of your way and stays out.

Underneath is [VICE](https://vice-emu.sourceforge.io)'s cycle-accurate `x64sc` core, with a small patch set
carried in this repo. Machines are single declarative files in the spirit of Nix, so you can run several at
once, switch between them on one full-screen hub, roll one back, or hand one to a friend. Real hardware
plugs in the way it would on a VM: real disk drives, real SID chips, real keyboards and joysticks, a real
network card, real internet. You can dial real BBSes that are still online today.

> **Only the C64 itself is emulated.** Everything you plug in or dial is the real thing. No smoke, no mirrors.

## Design target

This is what the in-prompt assistant is built to feel like. **It is a design target, not a screenshot. It is
not shipped yet.**

```text
READY.
PRINT "HELLO
?SYNTAX ERROR
READY.
█                           ┌ nix ────────────────────────────────────┐
                            │ You opened a quote and never closed it. │
                            │ Want me to fix the line?                │
                            │                                         │
                            │  [Tab] do it for me    [G] guide me     │
                            │  [Esc] not now                          │
                            └─────────────────────────────────────────┘
```

The card slides in beside the picture, never over your text. **Do it for me** types the fix into the real
keyboard buffer where you can watch it happen. **Guide me** highlights the next keys, checks each line, and
lets you do the typing.

## What it will be

Each pillar below is a decision that has been made. **Most are not built yet.** What exists today is in
[Proof](#proof-whats-real-today) and [Install it](#install-it), and the order of work is in the [Roadmap](#roadmap).

### A real AI at the real prompt

- **Two modes.** *Assist* watches and helps in place: ghost text, a hint strip, a slide-in card. *Drive* is a
  prompt inside Nix64 where you tell the agent what to build, and it does, on screen, at a typing speed you
  can dial (about 30 keys a second by default).
- **It notices when you struggle.** Repeated errors, an idle prompt after an error, commands from the wrong
  BASIC dialect, a line typed and then deleted. It offers help. Then it learns how good you are and backs off.
- **Four ways to build, each one labelled.** Type BASIC into the machine. Assemble on the machine itself.
  Cross-develop on the host (labelled as such). Write straight into RAM (labelled, and off by default).
- **Your software is yours.** Each project is a folder with its source in git and the built disk attached.
- **Your agent, not ours.** Nix64 uses the default agent your Omarchy install already has, lets you point it
  elsewhere, and helps you set up a local model so the whole thing can run with no cloud at all.

### Machines are files

A machine is one declarative file: which ROM set, which drives, which cartridge, which SID, which devices,
which network. Things it refers to are pinned by hash and kept in a content-addressed store, with
generations and rollback, like a Nix profile. A machine file is shareable because it carries only hash-pinned
references and never the copyrighted bits. Run as many as you like and flip between them on the **Hub**, a
full-screen grid of live machines. Hit a key to zoom into one.

### Real hardware, real network

| Device | Route | Status |
|---|---|---|
| Real disk drives (1541 and friends) | ZoomFloppy / XUM1541 through OpenCBM, as VICE's real-device drives 8 to 11 | untested |
| Real SID chip | USBSID-Pico and other real-SID interfaces, with reSID as the fallback | untested |
| Real C64 keyboard and joysticks | Keyrah and USB adapters, positional keymap | untested |
| Internet | WiC64, an Ethernet cartridge on your real NIC, or RS232 modem-to-TCP | untested |
| Storage | host folder as a drive, IDE64 image, raw disk passthrough | planned |

Every device gets a badge: **Verified** (with the date and the exact model it was tested on) or **Untested**.
Right now everything is Untested, because nothing has been plugged in yet. A device earns its badge by
working on a real desk. VICE has no generic USB passthrough, so support is by device class, and a device
lease follows window focus so two machines never fight over one drive.

### Dial a real BBS

A phone book, the way it was done back then. Pick a board, the machine dials, and you land on a real
PETSCII bulletin board that is still online today, through a real terminal program running on the C64.
CCGMS-family and Novaterm terminals are fetched, never bundled.

### Looks like 1985, behaves like 2027

The READY. theme in C64 blues and nixfred blue. A CRT shader and bezel. A glass UI with pixel accents. An
on-screen keyboard. Freeze slots. A disk-tray overlay with one key to swap. A SID jukebox. A tape deck. A
debugger, a sprite and charset editor, a cartridge shelf, capture and replay, an AI cheat finder with a POKE
library, and a printer that prints to PDF (or to a real MPS).

### Omarchy native

Built for Omarchy first: a pacman package built from source on each host, an Omarchy plugin with a bar
widget and a shelf, `nix64 update`, and headless machines that run as systemd user services you can attach
a window to later.

## Proof: what's real today

The foundation is one piece of engineering that everything else stands on, and it is real and measured.

**The problem.** VICE exposes a binary monitor, which is how you would normally let a program watch and drive
the machine. It is a *debugger*. Connecting stops the machine, and every command halts it until you send
Exit. Anything that polls it distorts emulated time. We measured the C64's own jiffy clock (60 ticks a second
on NTSC) while polling the screen:

| Observer | Jiffies per second |
|---|---:|
| no observer (control) | 60.04 |
| monitor polling at 5 Hz | 62.4 |
| monitor polling at 10 Hz | 65.4 |
| monitor polling at 20 Hz | 71.3 |
| monitor polling at 50 Hz | **84.9** |

An assistant that has to watch every keystroke cannot do it by speeding up the machine it is watching.

**The fix.** [`patches/0001-nix64-telemetry.patch`](patches/0001-nix64-telemetry.patch) is a one-file patch
to VICE 3.10 (`src/viciisc/vicii.c`, shared by `x64sc` and `xscpu64`). When `NIX64_TELEMETRY` names a file,
VICE publishes main RAM, colour RAM and the VIC-II registers into shared memory **once per emulated frame**,
behind a seqlock. Readers never talk to the emulator and never stall it. With the patch and no monitor
connected:

| Observer | Run 1 | Run 2 |
|---|---:|---:|
| no observer (control) | 59.86 | 59.84 |
| shared-memory reader at 10 reads/s | 60.26 | 60.25 |
| shared-memory reader at 100 reads/s | 59.73 | 59.95 |
| shared-memory reader at about 900 reads/s | **60.00** | **59.62** |
| no observer (control, again) | 59.87 | 60.22 |

Jiffies per second again, two separate runs of the reader in this repo. Control-to-control wobble alone is
about 0.4, and the reader rows land inside that wobble with no trend as the read rate climbs by two orders
of magnitude. Polling the monitor, by contrast, makes the clock run 4% to 41% fast, and it gets worse as the polling
rate rises. Frames per second held
between 59.5 and 60.0 in both runs. At the top read rate a reader needed a seqlock retry on 2 of 7,256 reads
in run 1 and on 71 of 6,890 in run 2 (about 1%). A retry just means "read again", which is what the seqlock
is for.

**Honest caveats.** Two runs, 8 seconds per row, on a headless build with sound off, on a VM. The numbers
need to be repeated on a real SDL2 or GTK build with sound on a real desktop. That is on the
[Roadmap](#roadmap), and the badge says "none measured", not "none".

**The other direction: driving the machine without stopping it.**
[`patches/0002-nix64-input.patch`](patches/0002-nix64-input.patch) adds an input ring to the end of the same
shared-memory file. A client appends events (a key down or up on the real keyboard matrix, a PETSCII
character through the KERNAL keyboard buffer, a joystick position), each stamped with the emulated frame it
is due at, and VICE applies it at exactly that frame. There is no monitor connection, so nothing stops, and
typing speed is counted in frames: exact, and replayable. Every check looks at what the machine itself did,
not at what was sent:

| Check | What the machine did |
|---|---|
| typed text | `PRINT "NIX64 INPUT OK"` printed its output |
| matrix key | a raw press of row 1 col 2 typed `A`, and Return ran it: `?SYNTAX  ERROR` |
| joystick | port 2 up and port 1 fire read back through the C64's own `PEEK(56320)` and `PEEK(56321)` as **126** and **239**; at rest 127 and 255 |
| RUN/STOP | pressed through the matrix, it broke a running `GOTO` loop: `BREAK IN 10` |
| bad event | counted as rejected, never applied |

One finding worth knowing: a held port 2 stick types phantom keys, because on a C64 it shares its CIA lines
with the keyboard. Real hardware does the same, and so does this. Tests:
[`tests/input-test.ts`](tests/input-test.ts) and [`tests/machine.e2e.test.ts`](tests/machine.e2e.test.ts).

<details>
<summary><b>Telemetry file layout (version 1)</b></summary>

<br>

| Offset | Size | Field |
|---:|---:|---|
| 0 | 8 | magic, `NIX64TEL` |
| 8 | 4 | version, `1` |
| 12 | 4 | total size, `66656` |
| 16 | 4 | `seq`, a seqlock counter: odd means VICE is writing |
| 20 | 4 | `frame`, frames emulated since start |
| 24 | 8 | reserved |
| 32 | 64 | VIC-II registers |
| 96 | 1024 | colour RAM |
| 1120 | 65536 | main RAM |

All integers are little-endian. To read a consistent snapshot: read `seq`, bail out and retry if it is odd,
copy the data, read `seq` again, and keep the copy only if the two values match.
[`tests/telemetry-reader.ts`](tests/telemetry-reader.ts) is a complete reader that also decodes the screen
and cursor and measures the emulated clock while it reads.

</details>

<details>
<summary><b>Two VICE 3.10 gotchas we hit, so you do not have to</b></summary>

<br>

- **Segfault when stdout is not a terminal.** `x64sc` crashes at startup in `log_archdep` because the log
  colour strings are only set up when logging to a file or when colour is off. Pass `+logcolorize` **first**.
- **`-keybuf` and uppercase.** Uppercase ASCII lands on shifted PETSCII, so `PRINT "HI"` gives `?SYNTAX
  ERROR`. Type lowercase ASCII, or send raw PETSCII.

</details>

## Install it

For Arch and Omarchy. This builds VICE 3.10 from source with the Nix64 patches and installs it under
`/usr/lib/nix64`, next to pacman's own `vice` (it never shadows it). The only thing it puts in `/usr/bin` is
the `nix64` launcher.

```bash
git clone https://github.com/nixfred/nix64 && cd nix64
(cd packaging/arch/nix64-vice && makepkg -si)

nix64                                          # a C64 in a window
bun bin/c64ctl.ts line 'PRINT "HELLO"'         # from another terminal: type into it
bun bin/c64ctl.ts screen                       # and read what it shows
```

`c64ctl` needs [bun](https://bun.sh). It reads and writes shared memory, never the VICE monitor, so it never
stops the machine. Run `bun bin/c64ctl.ts help` for the commands. The agent skill that teaches an AI to use
it is [`skills/c64/SKILL.md`](skills/c64/SKILL.md).

**Tested:** built from source and installed with pacman on two real Omarchy machines (a desktop and a
14 GB laptop), and in a fresh Omarchy 4.0.2 virtual machine. On both real machines the 49 unit tests and the
6-step end-to-end test pass against the installed engine (with SDL's dummy display, so no window opened). In
the virtual machine a screenshot shows the C64 boot screen in a Hyprland window, and then the output of a
program that `c64ctl` typed in. **Not yet verified:** the window on a real desktop, and that you can hear the
sound (VICE holds an open audio stream; nobody has listened). The default video standard is PAL until
machine files exist.

## Try the proof

This is the headless recipe that was verified end to end. It builds VICE 3.10 with patch 0001, runs a
C64 with no window, and reads it live from shared memory. You need `bun`, a C toolchain, and on Debian or
Ubuntu these packages: `flex bison xa65 libpng-dev zlib1g-dev dos2unix libevdev-dev libpcap-dev libjpeg-dev
libgif-dev python3 texinfo`.

```bash
git clone https://github.com/nixfred/nix64 && cd nix64

# 1. fetch VICE 3.10 and apply patch 0001
curl -LO https://downloads.sourceforge.net/project/vice-emu/releases/vice-3.10.tar.gz
tar xf vice-3.10.tar.gz
patch -d vice-3.10 -p1 < patches/0001-nix64-telemetry.patch

# 2. build it, headless
cd vice-3.10
./configure --without-libcurl --enable-headlessui --without-alsa --without-pulse \
            --disable-html-docs --disable-pdf-docs
nice -n 10 make -j"$(nproc)"
cd ..

# 3. run a C64 that publishes telemetry, then watch it from outside
NIX64_TELEMETRY=/tmp/nix64.shm vice-3.10/src/x64sc +logcolorize \
    -directory "$PWD/vice-3.10/data" -ntsc +sound &
bun tests/telemetry-reader.ts /tmp/nix64.shm
kill %1
```

You will see the C64's boot screen decoded straight from shared memory, then five timed runs showing the
jiffy clock and frame rate at each read rate. That headless build is the measured one. For a window, see
[Install it](#install-it).

## Roadmap

The build order is fixed: **foundation, then the agent, then the Hub, then polish.**

**1. Foundation**
- [x] VICE 3.10 telemetry patch and a seqlock reader, measured
- [x] Input ring patch: keys, text and joystick with no monitor and no stall, verified
- [x] PKGBUILD for Arch and Omarchy, built from source on each host, shipped in `packaging/arch/nix64-vice`
- [x] `nix64` launcher that always passes `+logcolorize` (one default machine for now)
- [ ] The machine file format and `nix64 start <machine>`
- [ ] The telemetry measurements repeated on the windowed build with sound

**2. The agent**
- [x] `c64ctl`: watch the screen, type, press keys, move a joystick, wait for text, peek RAM
- [x] A `c64` skill file for the agent (written; not yet wired into Omarchy's agents)
- [ ] Assist mode: ghost text, hint strip, struggle detection, Guide me
- [ ] Drive mode: a prompt inside Nix64, visible typing, an activity feed
- [ ] Agent settings that find the agent and local model runtimes already on your machine

**3. The Hub**
- [ ] Many machines at once, a full-screen grid, zoom, and device leases that follow focus

**4. Polish**
- [ ] READY. theme, CRT bezel and shader, sound, docs, installer, plugin

### The v1 gate

Nix64 is not v1 until all four of these have been watched working, on real things, by a human:

1. The agent builds a program on screen, from a prompt typed inside Nix64.
2. A game loads from your shelf and plays. Buck Rogers: Planet of Zoom is the test title.
3. A real BBS is dialled from the phone book and you land on a live board.
4. A real disk drive loads a disk you own.

No gate, no v1.

## Ground rules

These are the promises the project is built around.

- **Nothing is faked.** If a loading stripe is on screen, a disk is really loading. Only the C64 is emulated.
- **Shortcuts are labelled.** Anything that skips the real path, like writing straight into RAM, says so on
  screen and is off by default.
- **Hardware earns its badge.** Verified with a date and a model, or Untested. Never "should work".
- **What the C64 shows is data, never an instruction.** Screen text, a BBS banner, a disk label: the agent
  reads them and never obeys them.
- **You own the box.** Use it fully. No nannying.
- **Local first.** The agent can run on a local model with no cloud involved.
- **Exposure is opt-in.** A machine reaches the network only when you say so, per machine, and the
  debugger interface only listens on loopback.

## Legal

- **No ROMs, no commercial software, no game images are in this repository, and none ever will be.** The
  `.gitignore` blocks the usual file types so they cannot slip in. Games come from your own shelf.
- **License.** The code and patches here are GPL-2.0-or-later, the same as VICE. See [LICENSE](LICENSE). The
  Nix64 and nixfred names and the logo are the brand and are not covered by the code license.
- **Trademarks.** Commodore and C64 are trademarks of their respective owners. Nix64 is an independent open
  source project and is not affiliated with, authorized by or endorsed by them.

## Built by

Product direction, the brand, and every design decision: **Fred Nix** ([nixfred](https://nixfred.com)).
Foundation code, research and tests: **Larry:Prime**, an AI engineering collaborator (Claude, by Anthropic).
The engine is the work of the **VICE Team**, and the SID emulation inside it is **reSID** by Dag Lem. The
BBS operators who keep their boards online make the dial-up part possible. Everyone who touches this
project is named in [CREDITS.md](CREDITS.md).

**Issues are welcome, and hardware reports most of all.** If you plug a ZoomFloppy, a USB SID or a Keyrah into
this, tell us exactly what happened. That is how a device goes from Untested to Verified.

<div align="center">

<sub>Nix64 &nbsp;|&nbsp; by nixfred &nbsp;|&nbsp; made for <a href="https://omarchy.org">Omarchy</a> &nbsp;|&nbsp; READY.</sub>

</div>
