// From a key on your keyboard to keys on the C64's.
//
// The C64 keyboard is not a PC keyboard with different legends: SHIFT+2 is `"` on both, but SHIFT+7 is
// `&` on a PC and `'` on a C64, `(` is SHIFT+9 here and SHIFT+8 there, and `*` `+` `:` `=` `@` are
// plain keys on the C64. So this is SYMBOLIC: what you type is what appears, as in VICE's own
// "symbolic" keymap. (With a Keyrah or similar the keys are positional by hardware, and this is not used.)
//
// A host key goes down and up as an event pair. On down we work out which C64 keys to hold and whether
// the C64's shift must be forced on or forced off for the moment; on up we let go of exactly those,
// whatever the modifiers have become since. Shared keys (SHIFT) are reference counted.
import { keyMatrix } from "./keys";

type Shift = "pass" | "yes" | "no"; // pass: follow the host Shift key; yes: C64 SHIFT held; no: C64 SHIFT off
export type Chord = { keys: string[]; shift: Shift; restore?: boolean };

// What the key's own character is, when that is not what the C64 puts on the same key.
const BY_CHAR: Record<string, Chord> = {
  "!": { keys: ["1"], shift: "yes" }, '"': { keys: ["2"], shift: "yes" }, "#": { keys: ["3"], shift: "yes" },
  $: { keys: ["4"], shift: "yes" }, "%": { keys: ["5"], shift: "yes" }, "&": { keys: ["6"], shift: "yes" },
  "'": { keys: ["7"], shift: "yes" }, "(": { keys: ["8"], shift: "yes" }, ")": { keys: ["9"], shift: "yes" },
  "@": { keys: ["@"], shift: "no" }, "*": { keys: ["*"], shift: "no" }, "+": { keys: ["+"], shift: "no" },
  "-": { keys: ["-"], shift: "no" }, "=": { keys: ["="], shift: "no" }, ":": { keys: [":"], shift: "no" },
  ";": { keys: [";"], shift: "no" }, ",": { keys: [","], shift: "no" }, ".": { keys: ["."], shift: "no" },
  "/": { keys: ["/"], shift: "no" }, "<": { keys: [","], shift: "yes" }, ">": { keys: ["."], shift: "yes" },
  "?": { keys: ["/"], shift: "yes" }, "[": { keys: [":"], shift: "yes" }, "]": { keys: [";"], shift: "yes" },
  "^": { keys: ["UPARROW"], shift: "no" }, _: { keys: ["LEFTARROW"], shift: "no" }, "`": { keys: ["LEFTARROW"], shift: "no" },
  "£": { keys: ["POUND"], shift: "no" }, "\\": { keys: ["POUND"], shift: "no" }, " ": { keys: ["SPACE"], shift: "pass" },
};

// Keys that have no useful character: found by physical key (KeyboardEvent.code).
const BY_CODE: Record<string, Chord> = {
  Enter: { keys: ["RETURN"], shift: "pass" }, NumpadEnter: { keys: ["RETURN"], shift: "pass" },
  Backspace: { keys: ["DEL"], shift: "pass" }, Delete: { keys: ["DEL"], shift: "yes" }, Insert: { keys: ["DEL"], shift: "yes" },
  Escape: { keys: ["STOP"], shift: "pass" }, Tab: { keys: ["CTRL"], shift: "pass" },
  ControlLeft: { keys: ["CTRL"], shift: "pass" }, ControlRight: { keys: ["CTRL"], shift: "pass" },
  AltLeft: { keys: ["CBM"], shift: "pass" }, AltRight: { keys: ["CBM"], shift: "pass" },
  Space: { keys: ["SPACE"], shift: "pass" },
  ArrowRight: { keys: ["CRSR_RIGHT"], shift: "no" }, ArrowLeft: { keys: ["CRSR_RIGHT"], shift: "yes" },
  ArrowDown: { keys: ["CRSR_DOWN"], shift: "no" }, ArrowUp: { keys: ["CRSR_DOWN"], shift: "yes" },
  Home: { keys: ["HOME"], shift: "pass" }, End: { keys: ["HOME"], shift: "yes" },
  PageUp: { keys: [], shift: "pass", restore: true },
  F1: { keys: ["F1"], shift: "no" }, F2: { keys: ["F1"], shift: "yes" }, F3: { keys: ["F3"], shift: "no" }, F4: { keys: ["F3"], shift: "yes" },
  F5: { keys: ["F5"], shift: "no" }, F6: { keys: ["F5"], shift: "yes" }, F7: { keys: ["F7"], shift: "no" }, F8: { keys: ["F7"], shift: "yes" },
  NumpadAdd: { keys: ["+"], shift: "no" }, NumpadSubtract: { keys: ["-"], shift: "no" }, NumpadMultiply: { keys: ["*"], shift: "no" },
  NumpadDivide: { keys: ["/"], shift: "no" }, NumpadDecimal: { keys: ["."], shift: "no" },
};

export type HostKey = { code: string; key: string; shift: boolean };

/** Which C64 keys should be held for this host key, or null if the key means nothing to the C64. */
export function chordFor(ev: HostKey): Chord | null {
  if (ev.code === "ShiftLeft" || ev.code === "ShiftRight") return null; // handled as the shift state itself
  // What you typed is what appears, on any layout: a letter is that letter (Dvorak's "o" sits on the physical S key),
  // and punctuation and shifted digits go by their character. Only a key that makes no Latin character (a Cyrillic
  // layout, say) or is not a character at all falls back to the physical key below.
  if (ev.key.length === 1 && /^[a-z]$/i.test(ev.key)) return { keys: [ev.key.toUpperCase()], shift: "pass" };
  const byChar = ev.key.length === 1 ? BY_CHAR[ev.key] : undefined;
  if (byChar) return byChar;
  const byCode = BY_CODE[ev.code];
  if (byCode) return byCode;
  let m = /^Key([A-Z])$/.exec(ev.code);
  if (m) return { keys: [m[1]], shift: "pass" };
  m = /^(?:Digit|Numpad)(\d)$/.exec(ev.code);
  if (m) return { keys: [m[1]], shift: "pass" };
  return null;
}

type Press = (row: number, col: number, down: boolean) => void;

/** Holds the reference counts and the shift state for one machine's keyboard. */
export class HostKeyboard {
  private counts = new Map<string, number>();
  private pressed = new Map<string, Chord>();
  private hostShift = false;
  private suppress = 0; // keys held that need the C64 shift OFF
  private force = 0; // keys held that need the C64 shift ON
  private shiftOn = false;
  constructor(private press: Press, private restore: (down: boolean) => void) {}

  private set(name: string, down: boolean): void {
    const n = (this.counts.get(name) ?? 0) + (down ? 1 : -1);
    if (n < 0) return;
    this.counts.set(name, n);
    if ((down && n === 1) || (!down && n === 0)) {
      const k = keyMatrix(name);
      if (k) this.press(k.row, k.col, down);
    }
  }

  private syncShift(): void {
    const want = this.force > 0 || (this.hostShift && this.suppress === 0);
    if (want === this.shiftOn) return;
    this.shiftOn = want;
    const k = keyMatrix("LSHIFT");
    if (k) this.press(k.row, k.col, want);
  }

  /** Host Shift went down or up. */
  setShift(down: boolean): void {
    this.hostShift = down;
    this.syncShift();
  }

  down(ev: HostKey): boolean {
    if (this.pressed.has(ev.code)) return true; // auto-repeat: the C64 has its own
    const chord = chordFor(ev);
    if (!chord) return false;
    this.pressed.set(ev.code, chord);
    if (chord.shift === "yes") this.force++;
    if (chord.shift === "no") this.suppress++;
    this.syncShift();
    for (const k of chord.keys) this.set(k, true);
    if (chord.restore) this.restore(true);
    return true;
  }

  up(code: string): void {
    const chord = this.pressed.get(code);
    if (!chord) return;
    this.pressed.delete(code);
    for (const k of chord.keys) this.set(k, false);
    if (chord.restore) this.restore(false);
    if (chord.shift === "yes") this.force--;
    if (chord.shift === "no") this.suppress--;
    this.syncShift();
  }

  /** Let go of everything: focus left the screen, the agent took over, the Stop key was pressed. */
  releaseAll(): void {
    for (const code of [...this.pressed.keys()]) this.up(code);
    this.hostShift = false;
    this.syncShift();
    for (const [name, n] of this.counts) if (n > 0) { const k = keyMatrix(name); if (k) this.press(k.row, k.col, false); }
    this.counts.clear();
    if (this.shiftOn) { const k = keyMatrix("LSHIFT"); if (k) this.press(k.row, k.col, false); }
    this.shiftOn = false; this.force = 0; this.suppress = 0;
  }
}

/**
 * The C64 keys to press to type one character at the BASIC prompt (uppercase/graphics mode), shift
 * included, or null if the keyboard cannot type it. This is what "guide me" lights up on the on-screen
 * keyboard, and it is the same mapping the host keyboard uses, so what is lit is what produces the letter.
 */
export function keysForChar(ch: string): string[] | null {
  if (ch === "\n") return ["RETURN"];
  if (ch === " ") return ["SPACE"];
  const up = ch.toUpperCase();
  if (/^[A-Z0-9]$/.test(up)) return [up];
  const c = BY_CHAR[ch];
  if (!c) return null;
  return c.shift === "yes" ? ["LSHIFT", ...c.keys] : [...c.keys];
}
