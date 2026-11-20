// Unit tests that need no emulator: the keyboard matrix, joystick values and PETSCII conversion.
// Run: bun test tests/keys.test.ts
import { describe, expect, test } from "bun:test";
import { JOY, joyValue, keyMatrix, keyNames } from "../src/keys";
import { toPetscii } from "../src/petscii";

describe("keyboard matrix", () => {
  // Expected (row, col) copied from VICE 3.10's own data/C64/gtk3_sym.vkm, not from this code.
  const vice: Record<string, [number, number]> = {
    DEL: [0, 0], RETURN: [0, 1], CRSR_RIGHT: [0, 2], F7: [0, 3], F1: [0, 4], F3: [0, 5], F5: [0, 6], CRSR_DOWN: [0, 7],
    "3": [1, 0], W: [1, 1], A: [1, 2], LSHIFT: [1, 7], R: [2, 1], Y: [3, 1], I: [4, 1], P: [5, 1], "*": [6, 1],
    D: [2, 2], G: [3, 2], J: [4, 2], L: [5, 2], ";": [6, 2], CTRL: [7, 2], HOME: [6, 3], "-": [5, 3], ".": [5, 4],
    RSHIFT: [6, 4], SPACE: [7, 4], ":": [5, 5], "=": [6, 5], CBM: [7, 5], "@": [5, 6], UPARROW: [6, 6],
    ",": [5, 7], "/": [6, 7], STOP: [7, 7], "+": [5, 0], POUND: [6, 0], "1": [7, 0],
  };
  for (const [name, [row, col]] of Object.entries(vice)) {
    test(`${name} is row ${row} col ${col}`, () => {
      expect(keyMatrix(name)).toEqual({ row, col });
    });
  }
  test("every key has a unique position and there are 64 of them", () => {
    const seen = new Set(keyNames().map((n) => JSON.stringify(keyMatrix(n))));
    expect(keyNames().length).toBe(64);
    expect(seen.size).toBe(64);
  });
  test("aliases and case", () => {
    expect(keyMatrix("enter")).toEqual(keyMatrix("RETURN"));
    expect(keyMatrix("run/stop")).toEqual(keyMatrix("STOP"));
    expect(keyMatrix("shift")).toEqual(keyMatrix("LSHIFT"));
    expect(keyMatrix("a")).toEqual(keyMatrix("A"));
    expect(keyMatrix("banana")).toBeNull();
  });
});

describe("joystick", () => {
  test("bits", () => {
    expect(JOY).toEqual({ up: 1, down: 2, left: 4, right: 8, fire: 16 });
    expect(joyValue("up+fire")).toBe(17);
    expect(joyValue("none")).toBe(0);
    expect(joyValue("left, fire")).toBe(20);
  });
  test("rejects nonsense", () => {
    expect(() => joyValue("sideways")).toThrow();
  });
});

describe("PETSCII", () => {
  test("letters in the default mode are the unshifted key", () => {
    expect(toPetscii("Ab")).toEqual([0x41, 0x42]);
  });
  test("lowercase mode: capitals are the shifted key", () => {
    expect(toPetscii("Ab", "lower")).toEqual([0xc1, 0x42]);
  });
  test("digits and punctuation pass through", () => {
    expect(toPetscii('10 PRINT "A";B')).toEqual([...'10 PRINT "A";B'].map((c) => c.toUpperCase().charCodeAt(0)));
  });
  test("newline is RETURN", () => {
    expect(toPetscii("A\n")).toEqual([0x41, 13]);
  });
  test("tokens and repeats", () => {
    expect(toPetscii("{HOME}{CLR}")).toEqual([19, 147]);
    expect(toPetscii("{3*DOWN}")).toEqual([17, 17, 17]);
    expect(toPetscii("{red}{BLU}")).toEqual([28, 31]);
    expect(toPetscii("{F1}{F2}{F3}{F7}")).toEqual([133, 137, 134, 136]);
  });
  test("refuses what the keyboard cannot type", () => {
    expect(() => toPetscii("é")).toThrow();
    expect(() => toPetscii("{NOPE}")).toThrow();
    expect(() => toPetscii("{HOME")).toThrow();
    expect(() => toPetscii("{0*DOWN}")).toThrow();
  });
});
