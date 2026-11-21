// The NIX64 pixel logo: NIX in nixfred blue, 64 in C64 lavender, built from 5x7 pixel glyphs.
const G = {
  N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  6: ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  4: ["00110", "01010", "10010", "10010", "11111", "00010", "00010"],
};
let n = 0;
export function logo(height = 22) {
  const id = `lg${n++}`, px = 4, gap = 1.5, pitch = 5 * px + 7;
  let x = 0, rects = "";
  const glyph = (ch, fill) => {
    G[ch].forEach((row, y) => [...row].forEach((c, i) => { if (c === "1") rects += `<rect x="${x + i * px}" y="${y * px}" width="${px - gap / 3}" height="${px - gap / 3}" rx=".5" fill="${fill}"/>`; }));
    x += pitch;
  };
  for (const ch of "NIX") glyph(ch, `url(#${id}a)`);
  x += 6;
  for (const ch of "64") glyph(ch, `url(#${id}b)`);
  const W = x - 7, H = 7 * px;
  return `<svg viewBox="0 0 ${W} ${H}" height="${height}" role="img" aria-label="Nix64"><defs>
<linearGradient id="${id}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dbeafe"/><stop offset=".55" stop-color="#93c5fd"/><stop offset="1" stop-color="#3b82f6"/></linearGradient>
<linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e0dcff"/><stop offset=".55" stop-color="#a79ef5"/><stop offset="1" stop-color="#6c5eb5"/></linearGradient></defs>${rects}</svg>`;
}
