// Reader for the Nix64 telemetry shared-memory file (throwaway test, scratchpad only).
// Verifies: header, seqlock-consistent copy, screen+cursor decode, and that reading at high rate
// does NOT disturb the emulated clock (jiffies vs wall) or the frame counter.
import { readFileSync, openSync, readSync, closeSync } from "node:fs";

const path = process.argv[2];
const HDR = 32, VIC = 32, COLOR = 96, RAM = 1120, SIZE = 1120 + 65536;
const fd = openSync(path, "r");
const buf = Buffer.alloc(SIZE);

function snapshot(): { ram: Buffer; frame: number; vic: Buffer; retries: number } {
  let retries = 0;
  for (;;) {
    readSync(fd, buf, 0, 24, 0);
    const s1 = buf.readUInt32LE(16);
    if (s1 & 1) { retries++; continue; }
    readSync(fd, buf, 0, SIZE, 0);
    const s2 = buf.readUInt32LE(16);
    if (s1 === s2 && !(s2 & 1)) {
      return { ram: Buffer.from(buf.subarray(RAM, RAM + 65536)), frame: buf.readUInt32LE(20), vic: Buffer.from(buf.subarray(VIC, VIC + 64)), retries };
    }
    retries++;
  }
}
const sc = (c: number) => { c &= 0x7f; return c <= 31 ? String.fromCharCode(c + 64) : c <= 63 ? String.fromCharCode(c) : "."; };
function screenText(ram: Buffer): string[] {
  const base = ram[0x0288] << 8;
  const rows: string[] = [];
  for (let r = 0; r < 25; r++) rows.push(Array.from(ram.subarray(base + r * 40, base + r * 40 + 40)).map(sc).join("").trimEnd());
  return rows;
}
const jiffies = (ram: Buffer) => (ram[0xa0] << 16) | (ram[0xa1] << 8) | ram[0xa2];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  readSync(fd, buf, 0, 32, 0);
  console.log("magic:", buf.subarray(0, 8).toString(), "version:", buf.readUInt32LE(8), "size:", buf.readUInt32LE(12), "(expect", SIZE + ")");

  let s = snapshot();
  for (let i = 0; i < 80 && !screenText(s.ram).some((r) => r.includes("READY.")); i++) { await sleep(100); s = snapshot(); }
  const rows = screenText(s.ram);
  console.log("---- SCREEN (from shared memory, no monitor) ----");
  console.log(rows.filter((r) => r.length).join("\n"));
  console.log(`cursor row=${s.ram[0xd6]} col=${s.ram[0xd3]}  border=$${s.vic[0x20].toString(16)} bg=$${s.vic[0x21].toString(16)}  frame=${s.frame}`);

  async function arm(label: string, hz: number, secs: number) {
    const a = snapshot(), t0 = performance.now();
    let n = 0, retries = 0;
    if (hz === 0) await sleep(secs * 1000);
    else {
      const period = 1000 / hz;
      while (performance.now() - t0 < secs * 1000) {
        const x = performance.now(); const sn = snapshot(); retries += sn.retries; n++;
        const w = period - (performance.now() - x); if (w > 0) await sleep(w);
      }
    }
    const b = snapshot(), dt = (performance.now() - t0) / 1000;
    console.log(`${label.padEnd(16)} jiffies/s=${((jiffies(b.ram) - jiffies(a.ram)) / dt).toFixed(2)}  frames/s=${((b.frame - a.frame) / dt).toFixed(2)}  reads=${n}  seqlock retries=${retries}`);
  }
  console.log("---- CLOCK vs READ RATE (8 s each; real NTSC = 60 jiffies/s) ----");
  await arm("control", 0, 8);
  await arm("read 10 Hz", 10, 8);
  await arm("read 100 Hz", 100, 8);
  await arm("read ~max Hz", 2000, 8);
  await arm("control again", 0, 8);
  closeSync(fd);
  process.exit(0);
})();
