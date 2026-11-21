// Playing a .sid tune on the machine's own SID chip, the way people did it on a real C64: put the tune in RAM, then have the
// machine call its "init" routine once and its "play" routine every frame. Nix64 does that with a small driver of its own that
// hooks the KERNAL's frame interrupt ($0314). The engine plays nothing itself: every note is the emulated chip being written to
// by the tune's own 6502 code. (VICE's x64sc has no PSID support, only its separate vsid player does, so this is Nix64's own.)
//
// What it can play: tunes that sit in the plain RAM a C64 has under BASIC ($0800 to $9FFF) or above it ($C000 to $CFFF) and
// need the normal ROM layout. Tunes that live under the ROMs or I/O ($A000 to $BFFF, $D000 up) need the memory switched around
// by a driver that runs outside the interrupt: not done, and said so plainly instead of playing wrong.

import { parseSid } from "./psid";

/** Where the driver lives: the cassette buffer, free unless you use the tape. 48 bytes, the last one is the "init done" flag. */
export const DRIVER_AT = 0x0340;
const FLAG_AT = 0x036f;

export type SidPlan = {
  /** memory to write, in order: the tune, then the driver, then the interrupt vector that switches it on */
  writes: { addr: number; data: Buffer }[];
  warnings: string[];
  loadAddress: number;
  endAddress: number;
  initAddress: number;
  playAddress: number;
  /** the song asked for ran at the 60 Hz CIA timer rather than the frame interrupt */
  cia60: boolean;
};

const USABLE: [number, number][] = [[0x0800, 0x9fff], [0xc000, 0xcfff]];
const inUsable = (a: number) => USABLE.some(([lo, hi]) => a >= lo && a <= hi);

/** Work out what to write into the machine to play `song` (1-based) of this file. Throws a plain-words error if it cannot. */
export function planSid(file: Buffer, song: number, region: "pal" | "ntsc"): SidPlan {
  const info = parseSid(file); // the format, the song count and the rest are checked there
  if (song < 1 || song > info.songs) throw new Error(`this tune has songs 1 to ${info.songs}, not ${song}`);
  const dataOffset = file.readUInt16BE(6);
  if (dataOffset < 0x76 || dataOffset >= file.length) throw new Error("the SID file's data offset is wrong");
  let load = file.readUInt16BE(8), init = file.readUInt16BE(10), play = file.readUInt16BE(12);
  let data = file.subarray(dataOffset);
  if (load === 0) {
    if (data.length < 2) throw new Error("the SID file has no data");
    load = data[0] | (data[1] << 8);
    data = data.subarray(2);
  }
  if (!data.length) throw new Error("the SID file has no data");
  if (init === 0) init = load;
  const end = load + data.length - 1;
  const where = `$${load.toString(16).toUpperCase().padStart(4, "0")} to $${Math.min(end, 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
  if (end > 0xffff) throw new Error(`the tune's data runs past the end of memory (${where})`);
  const zone = USABLE.find(([lo, hi]) => load >= lo && end <= hi);
  if (!zone) {
    throw new Error(
      `this tune sits at ${where}, which is under the ROMs or I/O or outside the free RAM. Nix64's player handles tunes in $0800 to $9FFF and $C000 to $CFFF only, so it will not play it wrongly`,
    );
  }
  if (!inUsable(init) || (play !== 0 && !inUsable(play))) throw new Error("the tune's init or play routine is outside the memory Nix64's player can use");

  const warnings: string[] = [];
  const speedBit = (file.readUInt32BE(18) >>> Math.min(song - 1, 31)) & 1;
  // PSID speed: 0 = once per frame (50 Hz PAL, 60 Hz NTSC), 1 = the CIA timer, 60 Hz. A PAL KERNAL ticks at 50 Hz.
  const cia60 = speedBit === 1 && region === "pal";
  if (info.needsRealC64) warnings.push("This is an RSID tune: it expects a real C64 start-up and may not play correctly here.");
  if (info.sids > 1) warnings.push(`The tune uses ${info.sids} SID chips and this machine has one: the other chip's voices are missing.`);
  if (play === 0) warnings.push("The tune sets up its own interrupt, so Nix64 only calls its init routine.");

  // The driver, called by the KERNAL's frame interrupt through $0314 (A, X and Y are already saved by the KERNAL):
  //   first time: optionally set the CIA timer to 60 Hz, call init with A = song - 1, carry on
  //   every later time: call play, carry on
  const jsr = (a: number) => [0x20, a & 255, a >> 8];
  const nops = (n: number) => Array<number>(n).fill(0xea);
  const code = [
    0xad, FLAG_AT & 255, FLAG_AT >> 8, //          LDA flag
    0xd0, 0x15, //                                  BNE play
    0xee, FLAG_AT & 255, FLAG_AT >> 8, //          INC flag
    ...(cia60 ? [0xa9, 0x25, 0x8d, 0x04, 0xdc, 0xa9, 0x40, 0x8d, 0x05, 0xdc] : nops(10)), // CIA 1 timer A latch = 16421 = 60 Hz on PAL
    0xa9, (song - 1) & 255, //                      LDA #song-1
    ...jsr(init), //                                JSR init
    0x4c, 0x31, 0xea, //                            JMP $EA31 (the KERNAL's own interrupt work: the keyboard, the clock)
    ...(play === 0 ? nops(3) : jsr(play)), //       play: JSR play
    0x4c, 0x31, 0xea, //                            JMP $EA31
  ];
  const block = Buffer.alloc(FLAG_AT - DRIVER_AT + 1);
  Buffer.from(code).copy(block, 0);
  return {
    writes: [
      { addr: load, data: Buffer.from(data) },
      { addr: DRIVER_AT, data: block }, // with the flag byte at the end already 0
      { addr: 0x0314, data: Buffer.from([DRIVER_AT & 255, DRIVER_AT >> 8]) }, // last, in one write, so the interrupt never sees half a vector
    ],
    warnings,
    loadAddress: load,
    endAddress: end,
    initAddress: init,
    playAddress: play,
    cia60,
  };
}
