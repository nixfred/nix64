// Commands that other BASICs have and the C64's BASIC V2 does not, and how a C64 really does the same thing.
// This is the deterministic, free tier of the assistant: no model, no network, no delay. Each answer is
// a plain list of lines the user can type (or have typed), so "guide me" can light the keys for them.
export type Hint = {
  /** what the user was probably after, in plain words */
  intent: string;
  /** one sentence on why the command they typed does not work here */
  why: string;
  /** lines to type, uppercase, each at most 40 characters so it stays on one screen row */
  lines: string[];
};

const H = (intent: string, why: string, lines: string[]): Hint => ({ intent, why, lines });

export const DIALECT: Record<string, Hint> = {
  SOUND: H("make a sound", "BASIC V2 has no SOUND command. On the C64 you program the SID chip yourself with POKEs.", ["POKE 54296,15", "POKE 54277,9", "POKE 54278,0", "POKE 54273,40", "POKE 54272,0", "POKE 54276,17"]),
  BEEP: H("make a beep", "BASIC V2 has no BEEP. A short note on the SID chip does it.", ["POKE 54296,15", "POKE 54277,9", "POKE 54273,40", "POKE 54276,17"]),
  CLS: H("clear the screen", "There is no CLS. PRINT the clear-screen character instead.", ['PRINT CHR$(147)']),
  CLEAR: H("clear the screen", "CLEAR wipes variables on the C64, not the screen. PRINT the clear-screen character.", ['PRINT CHR$(147)']),
  COLOR: H("change colours", "BASIC V2 has no COLOR. Colours are POKEd into the video chip: border at 53280, background at 53281.", ["POKE 53280,2", "POKE 53281,0"]),
  GRAPHICS: H("draw graphics", "BASIC V2 has no GRAPHICS, PLOT, DRAW or CIRCLE. You draw with characters and sprites, or POKE the screen.", ["POKE 1024,1", "POKE 55296,1"]),
  PLOT: H("put something at a place on screen", "There is no PLOT. The screen is memory at 1024, so POKE a character there (and its colour at 55296).", ["POKE 1024+40*10+20,81", "POKE 55296+40*10+20,1"]),
  DRAW: H("draw a line", "There is no DRAW. Characters are the C64's drawing tool: PRINT a row of graphics characters.", ["PRINT CHR$(192);CHR$(192);CHR$(192)"]),
  CIRCLE: H("draw a circle", "There is no CIRCLE. Use PRINT with graphics characters, or sprites.", ['PRINT CHR$(81)']),
  LOCATE: H("move the cursor", "There is no LOCATE. Home the cursor and move it with the cursor-down character.", ['PRINT CHR$(19);CHR$(17);CHR$(17);"HI"']),
  SPRITE: H("use a sprite", "BASIC V2 has no SPRITE command. Sprites are switched on with POKEs to the video chip.", ["POKE 53269,1", "POKE 2040,13", "POKE 53248,100", "POKE 53249,100"]),
  RENUMBER: H("renumber the program", "BASIC V2 has no RENUMBER, AUTO or DELETE. Line numbers are yours to keep tidy; leave gaps of 10.", []),
  AUTO: H("auto-number lines", "BASIC V2 has no AUTO. Type line numbers yourself, and leave gaps of 10 so you can insert lines later.", []),
  ELSE: H("do something otherwise", "BASIC V2 has no ELSE. Test the opposite condition on the next line, or jump with GOTO.", ['10 IF A=1 THEN PRINT "YES":GOTO 30', '20 PRINT "NO"', "30 END"]),
  WHILE: H("loop while something is true", "BASIC V2 has no WHILE or WEND. Use IF with GOTO.", ["10 A=A+1", '20 IF A<10 THEN PRINT A:GOTO 10']),
  PRINTUSING: H("format numbers", "There is no PRINT USING in BASIC V2. Use INT and STR$ to shape numbers yourself.", ["PRINT INT(3.14159*100)/100"]),
  INPUTBOX: H("ask for input", "Use INPUT, which prints a prompt and waits for you.", ['10 INPUT "YOUR NAME";N$', '20 PRINT "HELLO ";N$']),
  SCREEN: H("set the screen mode", "There is no SCREEN command. The video chip is set by POKEs, e.g. the border and background colours.", ["POKE 53280,0", "POKE 53281,0"]),
};

/** Find a command from another dialect at the start of a typed line (after an optional line number). */
export function dialectHint(line: string): { word: string; hint: Hint } | null {
  const m = /^\s*(?:\d+\s*)?(PRINT\s+USING|[A-Z]+)/i.exec(line);
  if (!m) return null;
  const word = m[1].toUpperCase().replace(/\s+/g, "");
  const hint = DIALECT[word];
  return hint ? { word, hint } : null;
}

/** Steps for a first lesson: what to type first on a brand new machine. */
export const FIRST_LESSON: Hint = H(
  "type a first program",
  "A C64 turns on straight into BASIC. A line that starts with a number is stored as a program line; without one it runs at once.",
  ['PRINT "HELLO, NIX64"', '10 PRINT "HELLO, NIX64"', "20 GOTO 10", "RUN"],
);

/** Fixes for the errors the C64 reports, in plain words. */
export const ERRORS: Record<string, string> = {
  "SYNTAX": "The C64 did not understand the line: a word is misspelled, a quote or bracket is missing, or the command does not exist in BASIC V2.",
  "OUT OF DATA": "A READ asked for more DATA than there is.",
  "TYPE MISMATCH": "A number was used where text was expected, or the other way round (a variable ending in $ holds text).",
  "ILLEGAL QUANTITY": "A number is out of range, e.g. a POKE value above 255 or a negative index.",
  "UNDEF'D STATEMENT": "A GOTO or GOSUB points at a line number that does not exist.",
  "OUT OF MEMORY": "The program and its variables no longer fit.",
  "NEXT WITHOUT FOR": "A NEXT has no matching FOR.",
  "RETURN WITHOUT GOSUB": "A RETURN ran without a GOSUB before it.",
  "BAD SUBSCRIPT": "An array index is bigger than the DIM, or the array was never DIMensioned.",
  "DIVISION BY ZERO": "Something was divided by zero.",
  "FILE NOT FOUND": "The disk has no file by that name. LOAD\"$\",8 then LIST shows what is on it.",
  "DEVICE NOT PRESENT": "Nothing answered at that device number: no disk in drive 8, or the drive is off.",
};

/**
 * Keep a hint from overwriting the user's program. Hint lines that carry line numbers (10, 20, 30 ...) would replace any
 * line of the same number already in memory, and the user would lose their work without a word. If any number is in use,
 * the whole block moves to free numbers above the program (GOTO/GOSUB/THEN targets inside it follow), in steps of 10.
 * Returns null when there is no room (or the moved lines would not fit on one 40 column row): then nothing should be typed.
 */
export function placeLines(lines: string[], used: number[]): { lines: string[]; moved: boolean; from: number[]; to: number[] } | null {
  const num = (l: string) => /^(\d+)\s/.exec(l)?.[1];
  const nums = lines.map(num).filter((n): n is string => !!n).map(Number);
  const taken = new Set(used);
  if (!nums.length || !nums.some((n) => taken.has(n))) return { lines, moved: false, from: [], to: [] };
  const top = Math.max(...used);
  const base = (Math.floor(top / 10) + 1) * 10;
  if (base + 10 * (nums.length - 1) > 63990) return null;
  const map = new Map<number, number>();
  nums.forEach((n, i) => { if (!map.has(n)) map.set(n, base + 10 * map.size); });
  const out = lines.map((l) => {
    const n = num(l);
    if (!n) return l;
    const body = l.slice(n.length).replace(/\b(GOTO|GOSUB|THEN)(\s*)(\d+)/g, (m, kw, sp, t) => (map.has(Number(t)) ? `${kw}${sp}${map.get(Number(t))}` : m));
    return `${map.get(Number(n))}${body}`;
  });
  if (out.some((l) => l.length > 40)) return null;
  return { lines: out, moved: true, from: [...map.keys()], to: [...map.values()] };
}
