// A 1541 disk image (.d64) without the drive: make a blank one, read the directory.
// 35 tracks, 683 sectors of 256 bytes = 174848 bytes. Track 18 holds the BAM (sector 0) and the
// directory (from sector 1). This is the real layout, so the images this writes load on a real drive.

export const D64_SIZE = 174848;
const sectorsOnTrack = (t: number) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);

function offset(track: number, sector: number): number {
  let o = 0;
  for (let t = 1; t < track; t++) o += sectorsOnTrack(t) * 256;
  return o + sector * 256;
}

const asPetscii = (s: string, len: number) => {
  const out = Buffer.alloc(len, 0xa0);
  for (let i = 0; i < Math.min(len, s.length); i++) {
    const c = s.charCodeAt(i);
    out[i] = c >= 97 && c <= 122 ? c - 32 : c < 128 ? c : 0x3f;
  }
  return out;
};

/** A freshly formatted, empty disk. */
export function createD64(name = "NIX64", id = "64"): Buffer {
  const d = Buffer.alloc(D64_SIZE);
  const bam = offset(18, 0);
  d[bam] = 18; d[bam + 1] = 1; d[bam + 2] = 0x41; d[bam + 3] = 0;
  for (let t = 1; t <= 35; t++) {
    const n = sectorsOnTrack(t), e = bam + 4 * t;
    let bits = 0;
    for (let s = 0; s < n; s++) bits |= 1 << s;
    let free = n;
    if (t === 18) { bits &= ~0b11; free -= 2; } // BAM and first directory sector are in use
    d[e] = free; d[e + 1] = bits & 0xff; d[e + 2] = (bits >> 8) & 0xff; d[e + 3] = (bits >> 16) & 0xff;
  }
  asPetscii(name.toUpperCase(), 16).copy(d, bam + 0x90);
  d[bam + 0xa0] = 0xa0; d[bam + 0xa1] = 0xa0;
  asPetscii(id.toUpperCase(), 2).copy(d, bam + 0xa2);
  d[bam + 0xa4] = 0xa0; d[bam + 0xa5] = 0x32; d[bam + 0xa6] = 0x41; // "2A"
  for (let i = 0xa7; i <= 0xaa; i++) d[bam + i] = 0xa0;
  d[offset(18, 1) + 1] = 0xff; // end of the directory chain
  return d;
}

const fromPetscii = (b: Buffer) =>
  Array.from(b, (c) => (c === 0xa0 ? 0 : c >= 0xc1 && c <= 0xda ? c - 0x80 : c >= 0x20 && c < 0x7f ? c : 0x3f)).filter(Boolean)
    .map((c) => String.fromCharCode(c)).join("");

export type DirEntry = { name: string; type: string; blocks: number; closed: boolean; locked: boolean };
export type DiskDir = { name: string; id: string; entries: DirEntry[]; blocksFree: number };

const TYPES = ["DEL", "SEQ", "PRG", "USR", "REL"];

/** The disk name and the directory, as LOAD"$",8 would list it. Returns null if this is not a D64. */
export function readDir(d: Buffer): DiskDir | null {
  if (d.length < D64_SIZE) return null;
  const bam = offset(18, 0);
  if (d[bam] !== 18) return null;
  const entries: DirEntry[] = [];
  let t = 18, s = 1;
  for (let guard = 0; t !== 0 && guard < 40; guard++) {
    const o = offset(t, s);
    for (let i = 0; i < 8; i++) {
      const e = o + i * 32;
      const type = d[e + 2];
      if (!type) continue;
      entries.push({
        name: fromPetscii(d.subarray(e + 5, e + 21)),
        type: TYPES[type & 7] ?? "???",
        blocks: d[e + 30] | (d[e + 31] << 8),
        closed: (type & 0x80) !== 0,
        locked: (type & 0x40) !== 0,
      });
    }
    t = d[o]; s = d[o + 1];
    if (t > 35) break;
  }
  let free = 0;
  for (let tr = 1; tr <= 35; tr++) if (tr !== 18) free += d[bam + 4 * tr];
  return { name: fromPetscii(d.subarray(bam + 0x90, bam + 0xa0)), id: fromPetscii(d.subarray(bam + 0xa2, bam + 0xa4)), entries, blocksFree: free };
}
