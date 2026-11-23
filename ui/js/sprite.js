// Sprite data, as the VIC-II reads it: 63 bytes, 21 rows of 3 bytes. In hires a bit is a pixel (24 wide); in multicolour two bits
// are one double-wide pixel (12 wide) chosen from four slots. Plain functions, no page needed, so tests can run them.

export const W = 24, H = 21, BYTES = 63;

/** bytes (63) -> pixels[y][x], each 0..3. Hires: 0 or 1. Multicolour: 0 transparent, 1 = shared colour 0, 2 = the sprite's own colour, 3 = shared colour 1. */
export function decode(bytes, multi) {
  const rows = [];
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < W; x++) {
      const b = bytes[y * 3 + (x >> 3)] ?? 0;
      row.push(multi ? (b >> (6 - (x & 6))) & 3 : (b >> (7 - (x & 7))) & 1);
    }
    rows.push(row);
  }
  return rows;
}

/** pixels[y][x] -> 63 bytes. In multicolour both pixels of a pair must agree; the left one decides. */
export function encode(rows, multi) {
  const out = new Uint8Array(BYTES);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = rows[y][x] & (multi ? 3 : 1);
      if (multi) { if ((x & 1) === 0) out[y * 3 + (x >> 3)] |= v << (6 - (x & 6)); }
      else out[y * 3 + (x >> 3)] |= v << (7 - (x & 7));
    }
  }
  return out;
}

/** Set one pixel (in multicolour, the double-wide pair it belongs to). Returns a new grid. */
export function paint(rows, x, y, value, multi) {
  if (x < 0 || x >= W || y < 0 || y >= H) return rows;
  const next = rows.map((r) => r.slice());
  if (multi) { const x0 = x & ~1; next[y][x0] = value & 3; next[y][x0 + 1] = value & 3; }
  else next[y][x] = value & 1;
  return next;
}

/** Switching modes keeps the picture as close as it can: hires to multicolour pairs up pixels (set if either is), multicolour to hires keeps any non-transparent pixel. */
export function convert(rows, toMulti) {
  return rows.map((r) => {
    const out = r.slice();
    if (toMulti) for (let x = 0; x < W; x += 2) { const v = r[x] | r[x + 1] ? 2 : 0; out[x] = v; out[x + 1] = v; }
    else for (let x = 0; x < W; x++) out[x] = r[x] ? 1 : 0;
    return out;
  });
}

/** BASIC DATA lines for the 63 bytes (plus the 64th, a spare), ready to type into a C64: 8 bytes a line, numbered from `first` in steps of 10. */
export function toData(bytes, first = 1000) {
  const all = [...bytes, 0];
  const lines = [];
  for (let i = 0; i < all.length; i += 8) lines.push(`${first + (i / 8) * 10} DATA ${all.slice(i, i + 8).join(",")}`);
  return lines.join("\n");
}
