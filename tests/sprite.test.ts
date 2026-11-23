// The sprite editor's data handling (ui/js/sprite.js), with no browser: bits, pairs, conversion, DATA lines.
import { describe, expect, test } from "bun:test";
import { BYTES, H, W, convert, decode, encode, paint, toData } from "../ui/js/sprite.js";

const blank = () => Array.from({ length: H }, () => Array(W).fill(0));

describe("sprite data", () => {
  test("hires: a bit is a pixel, leftmost pixel is the top bit", () => {
    const b = new Uint8Array(BYTES); b[0] = 0b10000001; b[1] = 0b00010000; b[62] = 0xff;
    const r = decode(b, false);
    expect(r[0].slice(0, 8)).toEqual([1, 0, 0, 0, 0, 0, 0, 1]);
    expect(r[0][8 + 3]).toBe(1); // byte 1, bit 4 = pixel 11
    expect(r[20].slice(16, 24)).toEqual(Array(8).fill(1)); // the last byte is the last row's right third
  });
  test("multicolour: two bits are a double-wide pixel", () => {
    const b = new Uint8Array(BYTES); b[0] = 0b01101100;
    const r = decode(b, true);
    expect(r[0].slice(0, 8)).toEqual([1, 1, 2, 2, 3, 3, 0, 0]);
  });
  test("encode undoes decode, in both modes", () => {
    const b = Uint8Array.from({ length: BYTES }, (_, i) => (i * 37 + 11) & 255);
    expect([...encode(decode(b, false), false)]).toEqual([...b]);
    expect([...encode(decode(b, true), true)]).toEqual([...b]);
  });
  test("painting one pixel changes exactly that bit; in multicolour it paints the whole pair", () => {
    const g = paint(blank(), 3, 7, 1, false);
    const b = encode(g, false);
    expect(b[7 * 3]).toBe(0b00010000);
    expect([...b].filter((x) => x).length).toBe(1);
    const m = paint(blank(), 5, 0, 3, true); // pixel 5 belongs to the pair 4-5
    expect(encode(m, true)[0]).toBe(0b00001100); // the pair at pixels 4-5 sits at shift 2 of the first byte
    expect(m[0].slice(4, 6)).toEqual([3, 3]);
    expect(paint(blank(), 24, 0, 1, false)).toEqual(blank()); // outside: nothing
  });
  test("converting between modes keeps the picture", () => {
    const g = paint(blank(), 6, 2, 1, false);
    const m = convert(g, true);
    expect(m[2].slice(6, 8)).toEqual([2, 2]); // the sprite's own colour, double wide
    const back = convert(m, false);
    expect(back[2].slice(6, 8)).toEqual([1, 1]);
  });
  test("DATA lines: 64 numbers, 8 to a line, numbered in tens", () => {
    const b = Uint8Array.from({ length: BYTES }, (_, i) => i);
    const lines = toData(b, 1000).split("\n");
    expect(lines.length).toBe(8);
    expect(lines[0]).toBe("1000 DATA 0,1,2,3,4,5,6,7");
    expect(lines[7]).toBe("1070 DATA 56,57,58,59,60,61,62,0");
  });
});
