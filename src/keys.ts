// The C64 keyboard matrix, and joystick bits.
//
// Laid out the way the hardware is: one line per port-A column (PA0..PA7), eight keys across,
// PB0..PB7. VICE names a key (row, col) with row = the port-B bit and col = the port-A bit, so
// RETURN (PA1, PB0) is row 0 col 1. Spot-checked against VICE 3.10's own data/C64/gtk3_sym.vkm
// (see tests/keys-test.ts).
const GRID: string[][] = [
  /* PA0 */ ["DEL", "3", "5", "7", "9", "+", "POUND", "1"],
  /* PA1 */ ["RETURN", "W", "R", "Y", "I", "P", "*", "LEFTARROW"],
  /* PA2 */ ["CRSR_RIGHT", "A", "D", "G", "J", "L", ";", "CTRL"],
  /* PA3 */ ["F7", "4", "6", "8", "0", "-", "HOME", "2"],
  /* PA4 */ ["F1", "Z", "C", "B", "M", ".", "RSHIFT", "SPACE"],
  /* PA5 */ ["F3", "S", "F", "H", "K", ":", "=", "CBM"],
  /* PA6 */ ["F5", "E", "T", "U", "O", "@", "UPARROW", "Q"],
  /* PA7 */ ["CRSR_DOWN", "LSHIFT", "X", "V", "N", ",", "/", "STOP"],
];

export type Key = { row: number; col: number };
const MATRIX = new Map<string, Key>();
GRID.forEach((keys, col) => keys.forEach((name, row) => MATRIX.set(name, { row, col })));

// Friendly aliases an agent is likely to use.
const ALIAS: Record<string, string> = {
  ENTER: "RETURN", RUNSTOP: "STOP", "RUN/STOP": "STOP", ESC: "STOP", SHIFT: "LSHIFT",
  COMMODORE: "CBM", "C=": "CBM", DELETE: "DEL", INST: "DEL", BACKSPACE: "DEL",
  RIGHT: "CRSR_RIGHT", DOWN: "CRSR_DOWN", " ": "SPACE", "£": "POUND",
};

export function keyNames(): string[] {
  return [...MATRIX.keys()];
}

/** Look a key up by name ("a", "RETURN", "stop", "shift"). Returns null if the C64 has no such key. */
export function keyMatrix(name: string): Key | null {
  const n = name.length === 1 ? name.toUpperCase() : name.toUpperCase().replace(/[\s-]/g, "_");
  return MATRIX.get(ALIAS[n] ?? n) ?? null;
}

export const JOY: Record<string, number> = { up: 1, down: 2, left: 4, right: 8, fire: 16 };

/** "up+fire" to the joystick value the CIA sees. */
export function joyValue(spec: string): number {
  let v = 0;
  for (const part of spec.toLowerCase().split(/[+,\s]+/).filter(Boolean)) {
    if (part === "none" || part === "center" || part === "release") continue;
    if (!(part in JOY)) throw new Error(`unknown joystick direction ${JSON.stringify(part)} (up, down, left, right, fire)`);
    v |= JOY[part];
  }
  return v;
}
