// The assistant's other triggers, with a scripted screen and a fake clock: no engine, no model, no waiting.
// (The dialect trigger, Do it for me and Guide me are tested against a real engine in assist.e2e.test.ts.)
// Run: bun test tests/assist.rules.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Assist, type Card } from "../src/assist";

let now = 1_000_000;
const realNow = Date.now;
beforeEach(() => { now = 1_000_000; Date.now = () => now; });
afterEach(() => { Date.now = realNow; });

const pad = (rows: string[], n = 25) => [...rows, ...Array(Math.max(0, n - rows.length)).fill("")];
const BOOT = ["", "    **** COMMODORE 64 BASIC V2 ****", "", " 64K RAM SYSTEM  38911 BASIC BYTES FREE", "", "READY."];

function rig(initial = BOOT, cursor = { row: 6, col: 0 }) {
  let rows = pad(initial), cur = cursor;
  const cards: Card[][] = [];
  const feed: string[] = [];
  const live: any = { machine: { snapshot: () => ({}), screen: () => rows, cursor: () => cur }, say: (_k: string, t: string) => feed.push(t) };
  const a = new Assist(live, (c) => cards.push(c));
  return { a, cards, feed, show: (r: string[], c = cur) => { rows = pad(r); cur = c; }, titles: () => (cards.at(-1) ?? []).map((c) => c.title) };
}

describe("repeated errors", () => {
  test("the same error twice in a row gets a card that names it", () => {
    const { a, show, titles } = rig();
    show([...BOOT, "FOO", "", "?SYNTAX  ERROR", "READY."], { row: 10, col: 0 }); a.tick();
    expect(titles()).toEqual([]); // once is just a typo
    now += 5000;
    show([...BOOT, "FOO", "", "?SYNTAX  ERROR", "READY.", "BAR", "", "?SYNTAX  ERROR", "READY."], { row: 14, col: 0 }); a.tick();
    expect(titles()[0]).toContain("syntax error again");
  });
});

describe("stuck on an error", () => {
  test("20 seconds of nothing after an error offers help, and not before", () => {
    const { a, show, titles } = rig();
    show([...BOOT, "FOO", "", "?SYNTAX  ERROR", "READY."], { row: 10, col: 0 }); a.tick();
    now += 15_000; a.tick();
    expect(titles()).toEqual([]);
    now += 6_000; a.tick();
    expect(titles()[0]).toContain("Stuck on ?SYNTAX ERROR");
  });
  test("touching the screen resets the wait", () => {
    const { a, show, titles } = rig();
    show([...BOOT, "FOO", "", "?SYNTAX  ERROR", "READY."], { row: 10, col: 0 }); a.tick();
    now += 15_000;
    show([...BOOT, "FOO", "", "?SYNTAX  ERROR", "READY.", "PRIN"], { row: 11, col: 4 }); a.tick();
    now += 15_000; a.tick();
    expect(titles()).toEqual([]);
  });
});

describe("typed and cleared", () => {
  test("a long line wiped twice without running it", () => {
    const { a, show, titles } = rig();
    for (let i = 0; i < 2; i++) {
      show([...BOOT, "10 PRINT CHR$(147)"], { row: 6, col: 18 }); a.tick(); now += 1000;
      show([...BOOT], { row: 6, col: 0 }); a.tick(); now += 1000;
    }
    expect(titles()[0]).toContain("typing a line and clearing it");
  });
  test("a line that was RUN (the cursor moved down) is not 'cleared'", () => {
    const { a, show, titles } = rig();
    for (let i = 0; i < 3; i++) {
      show([...BOOT, "PRINT 12345678"], { row: 6, col: 14 }); a.tick(); now += 1000;
      show([...BOOT, "PRINT 12345678", "12345678", "", "READY."], { row: 10, col: 0 }); a.tick(); now += 1000;
      show([...BOOT], { row: 6, col: 0 }); a.tick(); now += 1000;
    }
    expect(titles()).toEqual([]);
  });
});

describe("a brand new machine", () => {
  test("40 seconds of an untouched boot screen offers the first lesson, a busy screen does not", () => {
    const quiet = rig();
    quiet.a.tick(); now += 41_000; quiet.a.tick();
    expect(quiet.titles()[0]).toContain("New to the C64");
    const busy = rig([...BOOT, "10 PRINT 1", "20 PRINT 2", "30 END", "RUN", " 1"]);
    busy.a.tick(); now += 41_000; busy.a.tick();
    expect(busy.titles()).toEqual([]);
  });
});

describe("eager, learning, quiet", () => {
  const dialect = (r: ReturnType<typeof rig>, n: number) => { r.show([...BOOT, "SOUND 1", "", "?SYNTAX  ERROR", "READY."], { row: 10, col: 0 }); r.a.tick(); };
  test("quiet and off never speak", () => {
    for (const mode of ["quiet", "off"] as const) {
      const r = rig(); r.a.mode = mode; dialect(r, 1);
      expect(r.cards.filter((c) => c.length).length).toBe(0);
    }
  });
  test("a dismissed card makes the next one wait longer; using one does not", () => {
    const wave = (use: boolean) => {
      const r = rig(); dialect(r, 1);
      r.a.act(r.a.cards[0].id, use ? "do" : "dismiss");
      r.show([...BOOT, "FOO", "", "?SYNTAX  ERROR", "READY."], { row: 10, col: 0 }); r.a.tick(); // something to be stuck on
      now += 25_000; r.a.tick();
      const early = r.a.cards.some((c) => /Stuck/.test(c.title));
      now += 110_000; r.a.tick();
      const late = r.a.cards.some((c) => /Stuck/.test(c.title));
      return { early, late };
    };
    expect(wave(false)).toEqual({ early: false, late: true }); // dismissed: still quiet at 25 s, speaks again after about 2 minutes
    expect(wave(true).early).toBe(true); // used: the normal 20 s wait, no extra
  });
});
