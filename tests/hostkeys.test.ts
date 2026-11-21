// The host keyboard to C64 keyboard mapping, checked by what the C64 would see: which matrix keys are
// held, in order. No emulator needed. Run: bun test tests/hostkeys.test.ts
import { describe, expect, test } from "bun:test";
import { HostKeyboard, chordFor } from "../src/hostkeys";
import { keyMatrix } from "../src/keys";

function rig() {
  const log: string[] = [];
  const held = new Set<string>();
  const names = new Map<string, string>();
  for (const n of ["LSHIFT", "A", "1", "2", "7", "8", "9", "@", "*", "+", "RETURN", "DEL", "CRSR_RIGHT", "CRSR_DOWN", "F1", "F3", "HOME", "STOP", "CTRL", "CBM", "SPACE", ",", ".", "/", ":", ";", "="]) {
    const k = keyMatrix(n)!;
    names.set(`${k.row},${k.col}`, n);
  }
  const kb = new HostKeyboard(
    (row, col, down) => { const n = names.get(`${row},${col}`) ?? `?${row},${col}`; log.push(`${down ? "+" : "-"}${n}`); down ? held.add(n) : held.delete(n); },
    (down) => log.push(`${down ? "+" : "-"}RESTORE`),
  );
  return { kb, log, held };
}

describe("symbolic mapping", () => {
  test("a letter is the letter; with host shift it is the shifted letter", () => {
    const { kb, log } = rig();
    kb.down({ code: "KeyA", key: "a", shift: false }); kb.up("KeyA");
    expect(log).toEqual(["+A", "-A"]);
    log.length = 0;
    kb.setShift(true); kb.down({ code: "KeyA", key: "A", shift: true }); kb.up("KeyA"); kb.setShift(false);
    expect(log).toEqual(["+LSHIFT", "+A", "-A", "-LSHIFT"]);
  });

  test("( is SHIFT+9 on a PC and SHIFT+8 on the C64: the C64 sees SHIFT 8", () => {
    const { kb, log } = rig();
    kb.setShift(true); kb.down({ code: "Digit9", key: "(", shift: true });
    expect(log).toEqual(["+LSHIFT", "+8"]);
    kb.up("Digit9"); kb.setShift(false);
    expect(log).toEqual(["+LSHIFT", "+8", "-8", "-LSHIFT"]);
  });

  test("* is SHIFT+8 on a PC but a plain key on the C64: the C64 shift is taken OFF while it is held", () => {
    const { kb, log, held } = rig();
    kb.setShift(true);
    expect(held.has("LSHIFT")).toBe(true);
    kb.down({ code: "Digit8", key: "*", shift: true });
    expect(log.at(-2)).toBe("-LSHIFT");
    expect(log.at(-1)).toBe("+*");
    expect(held.has("LSHIFT")).toBe(false);
    kb.up("Digit8");
    expect(held.has("LSHIFT")).toBe(true); // host shift is still down, so C64 shift comes back
    kb.setShift(false);
    expect(held.size).toBe(0);
  });

  test('" is SHIFT+2 on both, @ is a plain key on the C64, + is a plain key', () => {
    expect(chordFor({ code: "Quote", key: '"', shift: true })).toEqual({ keys: ["2"], shift: "yes" });
    expect(chordFor({ code: "Digit2", key: "@", shift: true })).toEqual({ keys: ["@"], shift: "no" });
    expect(chordFor({ code: "Equal", key: "+", shift: true })).toEqual({ keys: ["+"], shift: "no" });
    expect(chordFor({ code: "Equal", key: "=", shift: false })).toEqual({ keys: ["="], shift: "no" });
  });

  test("cursor keys: right is plain, left is SHIFT+right; F2 is SHIFT+F1", () => {
    const { kb, log } = rig();
    kb.down({ code: "ArrowLeft", key: "ArrowLeft", shift: false });
    expect(log).toEqual(["+LSHIFT", "+CRSR_RIGHT"]);
    kb.up("ArrowLeft");
    log.length = 0;
    kb.down({ code: "F2", key: "F2", shift: false }); kb.up("F2");
    expect(log).toEqual(["+LSHIFT", "+F1", "-F1", "-LSHIFT"]);
  });

  test("Esc is RUN/STOP, Backspace is DEL, Tab is CTRL, Alt is the Commodore key, PageUp is RESTORE", () => {
    const { kb, log } = rig();
    for (const [code, name] of [["Escape", "STOP"], ["Backspace", "DEL"], ["Tab", "CTRL"], ["AltLeft", "CBM"]] as const) {
      log.length = 0;
      kb.down({ code, key: code, shift: false }); kb.up(code);
      expect(log).toEqual([`+${name}`, `-${name}`]);
    }
    log.length = 0;
    kb.down({ code: "PageUp", key: "PageUp", shift: false }); kb.up("PageUp");
    expect(log).toEqual(["+RESTORE", "-RESTORE"]);
  });

  test("auto-repeat does not press again, and unknown keys mean nothing", () => {
    const { kb, log } = rig();
    kb.down({ code: "KeyA", key: "a", shift: false });
    kb.down({ code: "KeyA", key: "a", shift: false });
    expect(log).toEqual(["+A"]);
    expect(kb.down({ code: "MediaPlayPause", key: "MediaPlayPause", shift: false })).toBe(false);
  });

  test("releasing a key lets go of what it pressed even if the modifiers changed in between", () => {
    const { kb, held } = rig();
    kb.setShift(true);
    kb.down({ code: "Digit8", key: "*", shift: true }); // C64 shift off, * held
    kb.setShift(false);
    kb.up("Digit8");
    expect(held.size).toBe(0);
  });

  test("releaseAll lets go of everything", () => {
    const { kb, held } = rig();
    kb.setShift(true);
    kb.down({ code: "KeyA", key: "A", shift: true });
    kb.down({ code: "Enter", key: "Enter", shift: true });
    expect(held.size).toBeGreaterThan(1);
    kb.releaseAll();
    expect(held.size).toBe(0);
  });
});

describe("other keyboard layouts (2026-11-21 sweep)", () => {
  test("what you typed is what appears: Dvorak and AZERTY letters and punctuation", () => {
    expect(chordFor({ code: "KeyS", key: "o", shift: false })?.keys).toEqual(["O"]); // Dvorak: the physical S key types "o"
    expect(chordFor({ code: "KeyQ", key: "a", shift: false })?.keys).toEqual(["A"]); // AZERTY: the physical Q key types "a"
    expect(chordFor({ code: "KeyW", key: ",", shift: false })).toEqual(chordFor({ code: "Comma", key: ",", shift: false })); // Dvorak "," sits on W
    expect(chordFor({ code: "KeyA", key: "A", shift: true })?.keys).toEqual(["A"]); // shifted letters are still the letter, shift passes through
  });
  test("a key that makes no Latin letter falls back to the physical key", () => {
    expect(chordFor({ code: "KeyA", key: "ф", shift: false })?.keys).toEqual(["A"]); // Cyrillic layout
    expect(chordFor({ code: "ArrowLeft", key: "ArrowLeft", shift: false })).not.toBeNull();
  });
});
