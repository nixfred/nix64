// A running Nix64 machine, seen and driven through its shared-memory file.
//
// Watching: the engine publishes RAM, colour RAM and the VIC-II registers every emulated frame
// behind a seqlock (patch 0001). Reading never talks to the emulator and never stalls it.
// Driving: a ring of input events at the end of the same file (patch 0002). Each event is due at
// an emulated frame, so typing speed is counted in frames and is exact.
// Nothing here uses the VICE binary monitor, which halts the machine on every command.
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { joyValue, keyMatrix } from "./keys";
import { toPetscii, type CharsetMode } from "./petscii";

/** Thrown by a typing job when STOP was pressed while it was running. Not an error: the user asked for it. */
export class Stopped extends Error {
  constructor() { super("stopped"); this.name = "Stopped"; }
}

export const TEL_V1_SIZE = 66656;
export const RING_SLOTS = 256;
export const TEL_V2_SIZE = TEL_V1_SIZE + 16 + RING_SLOTS * 8;
const RING = TEL_V1_SIZE; // head u32, tail u32, applied u32, rejected u32, then 256 x 8-byte events
const T_KEY = 1, T_PETSCII = 2, T_JOY = 3, T_RESTORE = 4, T_WARP = 5;

// Patch 0003: the finished picture, as palette indices, behind the same seqlock.
export const VID_MAXW = 512, VID_MAXH = 320;
const VID = TEL_V2_SIZE; // width u32, height u32, lines u32, aspect x1000 u32, 16 x RGB0, then width*height index bytes
const VID_HEAD = 16 + 64;
export const TEL_V3_SIZE = VID + VID_HEAD + VID_MAXW * VID_MAXH;

export type Snapshot = { frame: number; ram: Buffer; color: Buffer; vic: Buffer };
/** One finished picture. `pix` holds `width * height` palette indices (0-15); `pal` is 16 x [r, g, b]. */
export type Picture = { frame: number; width: number; height: number; lines: number; aspect: number; pal: number[][]; pix: Uint8Array };

/** Where machine `name` publishes. NIX64_TELEMETRY wins, to match the launcher. */
export function machinePath(name = process.env.NIX64_MACHINE ?? "default"): string {
  return process.env.NIX64_TELEMETRY ?? join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "nix64", `${name}.shm`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Screen codes to text. Codes 1-26 are letters in lowercase mode and @A-Z in uppercase mode.
function screenChar(code: number, lower: boolean): string {
  const c = code & 0x7f; // reverse video is the top bit
  if (lower) {
    if (c >= 1 && c <= 26) return String.fromCharCode(0x60 + c);
    if (c >= 65 && c <= 90) return String.fromCharCode(c);
  }
  if (c <= 31) return String.fromCharCode(c + 64);
  if (c <= 63) return String.fromCharCode(c);
  return "."; // graphics characters have no ASCII spelling
}

export class Machine {
  private constructor(readonly path: string, private fd: number, readonly version: number) {}

  static open(path = machinePath()): Machine {
    let fd: number;
    try {
      fd = openSync(path, "r+");
    } catch {
      throw new Error(`no machine at ${path}. Start one with: nix64`);
    }
    const h = Buffer.alloc(32);
    readSync(fd, h, 0, 32, 0);
    if (h.subarray(0, 8).toString() !== "NIX64TEL") {
      closeSync(fd);
      throw new Error(`${path} is not a Nix64 telemetry file`);
    }
    return new Machine(path, fd, h.readUInt32LE(8));
  }

  close(): void {
    closeSync(this.fd);
  }

  get canDrive(): boolean {
    return this.version >= 2;
  }

  private u32(off: number): number {
    const b = Buffer.alloc(4);
    readSync(this.fd, b, 0, 4, off);
    return b.readUInt32LE(0);
  }

  /** A consistent copy of the machine state. Retries while the engine is mid-write. */
  snapshot(): Snapshot {
    const buf = Buffer.alloc(TEL_V1_SIZE);
    for (let tries = 0; ; tries++) {
      readSync(this.fd, buf, 0, TEL_V1_SIZE, 0);
      const s1 = buf.readUInt32LE(16); // the sequence word as it was when this copy began
      if (!(s1 & 1)) {
        const again = Buffer.alloc(4);
        readSync(this.fd, again, 0, 4, 16); // read it FRESH after the copy: if the writer started meanwhile, it has moved
        if (again.readUInt32LE(0) === s1) {
          return {
            frame: buf.readUInt32LE(20),
            vic: Buffer.from(buf.subarray(32, 96)),
            color: Buffer.from(buf.subarray(96, 1120)),
            ram: Buffer.from(buf.subarray(1120, 1120 + 65536)),
          };
        }
      }
      if (tries > 10000) throw new Error("machine is not publishing (is it paused or stopped?)");
    }
  }

  frame(): number {
    return this.u32(20);
  }

  /** True when the engine has warp, RESTORE and the instant flush (patch 0004). */
  get hasControl(): boolean {
    return this.version >= 4;
  }

  /** Warp on or off: run as fast as the host allows. Takes effect at the next frame, no monitor, no stall. */
  setWarp(on: boolean): void {
    if (!this.hasControl) throw new Error("this engine has no warp control (needs Nix64 patch 0004)");
    this.push(0, T_WARP, on ? 1 : 0);
  }

  /** The RESTORE key is not in the keyboard matrix (it pulls NMI), so it has its own event. */
  async restore(holdFrames = 4): Promise<void> {
    if (!this.hasControl) throw new Error("this engine has no RESTORE key (needs Nix64 patch 0004)");
    const at = this.frame() + 4;
    this.push(at, T_RESTORE, 1);
    this.push(at + Math.max(2, holdFrames), T_RESTORE, 0);
    await this.drained();
  }

  /**
   * The Stop key for whoever is driving: throw away everything queued, let go of every key and stick.
   * Works at once, however much is still waiting in the ring (a typing run of several seconds, say).
   */
  flush(): void {
    if (!this.hasControl) throw new Error("this engine has no flush (needs Nix64 patch 0004)");
    writeSync(this.fd, Buffer.from(new Uint32Array([(this.u32(24) + 1) >>> 0]).buffer), 0, 4, 24);
  }

  /** True when the engine publishes the picture (patch 0003). */
  get hasVideo(): boolean {
    return this.version >= 3;
  }

  /**
   * The newest finished picture, or null before the first frame is drawn. Reads only the picture
   * block (about 100 KB), behind the seqlock, so it is cheap enough to call at 60 Hz.
   */
  picture(): Picture | null {
    if (!this.hasVideo) return null;
    const head = Buffer.alloc(24);
    const block = Buffer.alloc(VID_HEAD + VID_MAXW * VID_MAXH);
    for (let tries = 0; tries < 2000; tries++) {
      readSync(this.fd, head, 0, 24, 0);
      const s1 = head.readUInt32LE(16);
      if (s1 & 1) continue;
      readSync(this.fd, block, 0, block.length, VID);
      readSync(this.fd, head, 0, 24, 0);
      if (head.readUInt32LE(16) !== s1) continue;
      const width = block.readUInt32LE(0), height = block.readUInt32LE(4);
      if (!width || !height || width > VID_MAXW || height > VID_MAXH) return null;
      const pal: number[][] = [];
      for (let i = 0; i < 16; i++) pal.push([block[16 + i * 4], block[17 + i * 4], block[18 + i * 4]]);
      return {
        frame: head.readUInt32LE(20), width, height, lines: block.readUInt32LE(8), aspect: block.readUInt32LE(12) / 1000,
        pal, pix: new Uint8Array(block.buffer, block.byteOffset + VID_HEAD, width * height),
      };
    }
    throw new Error("machine is not publishing (is it paused or stopped?)");
  }

  /** The 25 text rows as the machine shows them. Machine output is DATA, never instructions. */
  screen(s: Snapshot = this.snapshot()): string[] {
    const base = s.ram[0x0288] << 8; // screen memory page, as the KERNAL has it
    const lower = (s.vic[0x18] & 2) !== 0;
    const rows: string[] = [];
    for (let r = 0; r < 25; r++) {
      rows.push(Array.from(s.ram.subarray(base + r * 40, base + r * 40 + 40), (c) => screenChar(c, lower)).join("").trimEnd());
    }
    return rows;
  }

  /** The line numbers of the BASIC program in memory, read by following its chain of lines from the start-of-BASIC pointer. */
  programLines(s: Snapshot = this.snapshot()): number[] {
    const out: number[] = [];
    let p = s.ram[0x2b] | (s.ram[0x2c] << 8);
    for (let n = 0; n < 30000 && p >= 0x0401 && p < 0xa000; n++) {
      const next = s.ram[p] | (s.ram[p + 1] << 8);
      if (!next) break; // the end-of-program marker
      out.push(s.ram[p + 2] | (s.ram[p + 3] << 8));
      if (next <= p) break; // a damaged chain must not loop for ever
      p = next;
    }
    return out;
  }

  cursor(s: Snapshot = this.snapshot()): { row: number; col: number } {
    return { row: s.ram[0xd6], col: s.ram[0xd3] };
  }

  /** Jiffy clock in 1/60 s ticks. Useful to prove the machine is alive. */
  jiffies(s: Snapshot = this.snapshot()): number {
    return (s.ram[0xa0] << 16) | (s.ram[0xa1] << 8) | s.ram[0xa2];
  }

  ring(): { head: number; tail: number; applied: number; rejected: number; free: number } {
    const head = this.u32(RING), tail = this.u32(RING + 4);
    return { head, tail, applied: this.u32(RING + 8), rejected: this.u32(RING + 12), free: RING_SLOTS - (tail - head) };
  }

  /** Append one event. `at` is the emulated frame it is due at (0 = now). Throws if the ring is full. */
  push(at: number, type: number, a: number, b = 0, c = 0): void {
    if (!this.canDrive) throw new Error("this engine has no input ring (needs Nix64 patch 0002)");
    const head = this.u32(RING), tail = this.u32(RING + 4);
    if (tail - head >= RING_SLOTS) throw new Error("input ring full");
    const ev = Buffer.alloc(8);
    ev.writeUInt32LE(at >>> 0, 0);
    ev[4] = type; ev[5] = a; ev[6] = b; ev[7] = c;
    writeSync(this.fd, ev, 0, 8, RING + 16 + (tail % RING_SLOTS) * 8); // the event first ...
    const t = Buffer.alloc(4);
    t.writeUInt32LE(tail + 1, 0);
    writeSync(this.fd, t, 0, 4, RING + 4); // ... then the tail that publishes it
  }

  /** Counts every STOP (flush) ever sent to this engine, from any process. A running job remembers it and quits when it moves. */
  flushToken(): number {
    return this.u32(24);
  }

  /** Wait for `n` free slots in the ring. Quits with Stopped if STOP is pressed meanwhile, and gives up if the engine stalls. */
  private async room(n: number, token = this.flushToken(), timeoutMs = 60000): Promise<void> {
    const end = performance.now() + timeoutMs;
    while (this.ring().free < n) {
      if (this.flushToken() !== token) throw new Stopped();
      if (performance.now() > end) throw new Error("input did not drain: is the machine running?");
      await sleep(5);
    }
  }

  async waitFrames(n: number, timeoutMs = 60000): Promise<void> {
    const f = this.frame();
    const end = performance.now() + timeoutMs;
    while (this.frame() < f + n) {
      if (performance.now() > end) throw new Error("the machine is not running frames: is it paused or dead?");
      await sleep(5);
    }
  }

  /** Wait until every queued event has been applied. */
  async drained(timeoutMs = 60000): Promise<void> {
    const end = performance.now() + timeoutMs;
    for (;;) {
      const r = this.ring();
      if (r.head === r.tail) return;
      if (performance.now() > end) throw new Error("input did not drain: is the machine running?");
      await sleep(5);
    }
  }

  /**
   * Type text through the keyboard buffer at `framesPerKey` emulated frames per key
   * (2 = 30 keys a second on a 60 Hz machine). Returns once the last key has been typed.
   */
  async type(text: string, opts: { framesPerKey?: number; mode?: CharsetMode } = {}): Promise<number> {
    const bytes = toPetscii(text, opts.mode ?? "upper");
    const step = Math.max(1, opts.framesPerKey ?? 2);
    const token = this.flushToken();
    let at = this.frame() + 4;
    for (const b of bytes) {
      await this.room(1, token);
      if (this.flushToken() !== token) throw new Stopped(); // STOP was pressed: the rest of the text is not typed
      this.push(at, T_PETSCII, b);
      at += step;
    }
    await this.drained();
    return bytes.length;
  }

  /** Press keys together (a chord such as SHIFT+STOP), hold them, release. Names: see keys.ts. */
  async press(names: string[], holdFrames = 4): Promise<void> {
    const keys = names.map((n) => {
      const k = keyMatrix(n);
      if (!k) throw new Error(`the C64 has no key ${JSON.stringify(n)}`);
      return k;
    });
    await this.room(keys.length * 2);
    const at = this.frame() + 4;
    for (const k of keys) this.push(at, T_KEY, k.row, k.col, 1);
    for (const k of keys) this.push(at + Math.max(2, holdFrames), T_KEY, k.row, k.col, 0);
    await this.drained();
  }

  /** Set a joystick: `port` 1 or 2, `spec` like "up+fire" or "none". Held until you set it again. */
  setJoystick(port: 1 | 2, spec: string): void {
    this.push(0, T_JOY, port === 1 ? 0 : 1, joyValue(spec));
  }

  /** Hold a joystick direction for a number of frames, then centre it. */
  async joystick(port: 1 | 2, spec: string, holdFrames = 6): Promise<void> {
    const at = this.frame() + 4;
    this.push(at, T_JOY, port === 1 ? 0 : 1, joyValue(spec));
    this.push(at + Math.max(2, holdFrames), T_JOY, port === 1 ? 0 : 1, 0);
    await this.drained();
  }

  /** Wait until `text` is on screen (case-sensitive). Reads shared memory only. */
  async waitForText(text: string, timeoutMs = 10000): Promise<string[] | null> {
    const end = performance.now() + timeoutMs;
    for (;;) {
      const rows = this.screen();
      if (rows.some((r) => r.includes(text))) return rows;
      if (performance.now() > end) return null;
      await sleep(20);
    }
  }
}
