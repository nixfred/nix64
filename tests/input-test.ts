// Nix64 patch 0002 test: drive a running C64 through the shared-memory input ring.
//
// Usage: bun tests/input-test.ts <telemetry shm path>
// Start the machine first:  NIX64_TELEMETRY=<path> x64sc +logcolorize -ntsc +sound
//
// Every check looks at what the machine itself did, not at what was sent:
//   1. typed text      PETSCII events reach the screen through the KERNAL keyboard buffer
//   2. matrix keys     a raw key-down/key-up on row 1 col 2 types "A"; Return runs it
//   3. joystick        the C64 reads the stick back through the CIA ports ($DC00, $DC01)
//   4. bad events      an invalid event is counted as rejected, never applied
// The machine is never touched through the binary monitor, so it is never stopped.
import { closeSync, openSync, readSync, writeSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun tests/input-test.ts <telemetry shm path>");
  process.exit(2);
}

const TEL_SIZE = 66656; // version 1 size: header + VIC + colour + RAM
const IN = TEL_SIZE; // input ring starts here (version 2)
const SLOTS = 256;
const T_KEY = 1, T_PETSCII = 2, T_JOY = 3;

const fd = openSync(path, "r+");
const buf = Buffer.alloc(TEL_SIZE);
const u32 = (off: number) => {
  const b = Buffer.alloc(4);
  readSync(fd, b, 0, 4, off);
  return b.readUInt32LE(0);
};

function snapshot(): { ram: Buffer; frame: number } {
  for (;;) {
    readSync(fd, buf, 0, 24, 0);
    const s1 = buf.readUInt32LE(16);
    if (s1 & 1) continue;
    readSync(fd, buf, 0, TEL_SIZE, 0);
    const s2 = buf.readUInt32LE(16);
    if (s1 === s2) return { ram: Buffer.from(buf.subarray(1120, 1120 + 65536)), frame: buf.readUInt32LE(20) };
  }
}
const sc = (c: number) => ((c &= 0x7f), c <= 31 ? String.fromCharCode(c + 64) : c <= 63 ? String.fromCharCode(c) : ".");
function screen(): string[] {
  const { ram } = snapshot();
  const base = ram[0x0288] << 8;
  const rows: string[] = [];
  for (let r = 0; r < 25; r++) rows.push(Array.from(ram.subarray(base + r * 40, base + r * 40 + 40)).map(sc).join("").trimEnd());
  return rows;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => snapshot().frame;

function push(at: number, type: number, a: number, b = 0, c = 0) {
  const head = u32(IN), tail = u32(IN + 4);
  if (tail - head >= SLOTS) throw new Error("input ring full");
  const ev = Buffer.alloc(8);
  ev.writeUInt32LE(at, 0);
  ev[4] = type; ev[5] = a; ev[6] = b; ev[7] = c;
  writeSync(fd, ev, 0, 8, IN + 16 + (tail % SLOTS) * 8); // the event first ...
  const t = Buffer.alloc(4);
  t.writeUInt32LE(tail + 1, 0);
  writeSync(fd, t, 0, 4, IN + 4); // ... then the tail that publishes it
}
async function drained() {
  while (u32(IN) !== u32(IN + 4)) await sleep(10);
}
async function waitFrames(n: number) {
  const f = frame();
  while (frame() < f + n) await sleep(10);
}
/** Type a line at `framesPerKey` emulated frames per key (2 = 30 keys a second), then press Return. */
async function typeLine(line: string, framesPerKey = 2) {
  let at = frame() + 6;
  for (const ch of line) { push(at, T_PETSCII, ch.charCodeAt(0)); at += framesPerKey; }
  push(at, T_PETSCII, 13);
  await drained();
  await waitFrames(framesPerKey * 4 + 90); // let BASIC run the line
}

let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  if (!ok) failed++;
};

(async () => {
  readSync(fd, buf, 0, 32, 0);
  const version = buf.readUInt32LE(8), size = buf.readUInt32LE(12);
  console.log(`magic=${buf.subarray(0, 8).toString()} version=${version} size=${size}`);
  check("layout", version === 2 && size === TEL_SIZE + 16 + SLOTS * 8, `version ${version}, size ${size} (want 2, ${TEL_SIZE + 16 + SLOTS * 8})`);

  for (let i = 0; i < 120 && !screen().some((r) => r.includes("READY.")); i++) await sleep(100);
  const applied0 = u32(IN + 8), rejected0 = u32(IN + 12);

  // 1. typed text
  const t0 = performance.now();
  await typeLine('PRINT "NIX64 INPUT OK"');
  const rows1 = screen();
  const out = rows1.findIndex((r) => r === "NIX64 INPUT OK");
  check("typed text", out > 0 && rows1[out - 1].startsWith('PRINT "NIX64 INPUT OK"'), `output row ${out}: ${JSON.stringify(rows1[out] ?? null)}`);

  // 2. raw matrix key: row 1 col 2 is the A key, row 0 col 1 is Return
  let at = frame() + 6;
  push(at, T_KEY, 1, 2, 1); push(at + 4, T_KEY, 1, 2, 0);
  push(at + 12, T_KEY, 0, 1, 1); push(at + 16, T_KEY, 0, 1, 0);
  await drained();
  await waitFrames(60);
  const rows2 = screen();
  const a = rows2.findIndex((r, i) => r === "A" && i > out);
  check("matrix key", a > 0 && rows2.slice(a + 1).some((r) => r.startsWith("?SYNTAX")), `"A" at row ${a}, then ${JSON.stringify(rows2.slice(a + 1).find((r) => r.startsWith("?SYNTAX")) ?? null)}`);

  // 3. joystick, read back through the CIA ports by the C64 itself.
  // A stick in port 2 shares its CIA lines with the keyboard, so on a real C64 (and here) a held
  // stick makes phantom keypresses. So the program is typed first and the stick is pressed while
  // it runs. Line 10 waits for the stick to move, line 20 prints both ports.
  await typeLine("10 A=PEEK(56320):IF A=127 THEN 10");
  await typeLine("20 PRINT A;PEEK(56321)");
  await typeLine("RUN");
  at = frame() + 6;
  push(at, T_JOY, 1, 1);          // port 2: up       -> $DC00 bit 0 low (126)
  push(at, T_JOY, 0, 16);         // port 1: fire     -> $DC01 bit 4 low (239)
  await drained(); await waitFrames(40);
  push(frame() + 2, T_JOY, 1, 0); // release both
  push(frame() + 2, T_JOY, 0, 0);
  await drained(); await waitFrames(20);
  const pressed = screen().some((r) => r.trim() === "126  239");
  check("joystick pressed", pressed, `want "126  239" (port 2 up, port 1 fire); rows: ${JSON.stringify(screen().filter((r) => /^ ?\d+ +\d+$/.test(r)))}`);
  await typeLine("PRINT PEEK(56320);PEEK(56321)");
  const released = screen().filter((r) => r.trim() === "127  255").length > 0;
  check("joystick released", released, `want "127  255" (both sticks at rest)`);

  // 4. an invalid event is rejected, not applied
  const before = u32(IN + 12);
  push(0, 99, 1);
  await drained(); await waitFrames(4);
  check("bad event rejected", u32(IN + 12) === before + 1, `rejected ${before} -> ${u32(IN + 12)}`);

  console.log(`applied ${u32(IN + 8) - applied0}, rejected ${u32(IN + 12) - rejected0}, ring head=${u32(IN)} tail=${u32(IN + 4)}, ${(performance.now() - t0) / 1000 | 0}s`);
  console.log("---- SCREEN ----");
  console.log(screen().filter((r) => r.length).join("\n"));
  closeSync(fd);
  console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
