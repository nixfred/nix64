// ASCII text to the PETSCII bytes a C64 keyboard produces, plus {TOKENS} for the keys that have
// no ASCII spelling (cursor keys, colours, function keys).
//
// The KERNAL keyboard buffer holds what the key produced, not how it will be drawn. In the
// default uppercase/graphics mode an unshifted letter is $41-$5A. In lowercase mode the same
// unshifted key is drawn lowercase and the shifted one ($C1-$DA) is drawn uppercase.

export type CharsetMode = "upper" | "lower";

const TOKENS: Record<string, number> = {
  RETURN: 13, HOME: 19, CLR: 147, DEL: 20, INST: 148,
  UP: 145, DOWN: 17, LEFT: 157, RIGHT: 29,
  F1: 133, F2: 137, F3: 134, F4: 138, F5: 135, F6: 139, F7: 136, F8: 140,
  RVS: 18, RVSOFF: 146,
  BLK: 144, WHT: 5, RED: 28, CYN: 159, PUR: 156, GRN: 30, BLU: 31, YEL: 158,
  ORG: 129, BRN: 149, LRED: 150, GR1: 151, GR2: 152, LGRN: 153, LBLU: 154, GR3: 155,
  POUND: 0x5c, UPARROW: 0x5e, LEFTARROW: 0x5f,
};

export const TOKEN_NAMES = Object.keys(TOKENS);

/** Convert text to PETSCII bytes. Throws on a character the keyboard cannot type. */
export function toPetscii(text: string, mode: CharsetMode = "upper"): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      const end = text.indexOf("}", i);
      if (end < 0) throw new Error(`unclosed { at position ${i}`);
      const name = text.slice(i + 1, end).toUpperCase();
      const repeat = /^(\d+)\*([A-Z0-9]+)$/.exec(name); // {3*DOWN}
      const count = repeat ? Number(repeat[1]) : 1;
      const key = repeat ? repeat[2] : name;
      if (!(key in TOKENS)) throw new Error(`unknown token {${name}}. Known: ${TOKEN_NAMES.join(", ")}`);
      if (count < 1 || count > 255) throw new Error(`bad repeat in {${name}}`);
      for (let n = 0; n < count; n++) out.push(TOKENS[key]);
      i = end;
      continue;
    }
    const c = ch.charCodeAt(0);
    if (ch === "\n") out.push(13);
    else if (ch === "\r") continue;
    else if (c >= 0x61 && c <= 0x7a) out.push(c - 0x20); // a-z: the unshifted letter key
    else if (c >= 0x41 && c <= 0x5a) out.push(mode === "upper" ? c : c + 0x80); // A-Z: shifted in lower mode
    else if (c >= 0x20 && c <= 0x40) out.push(c); // space ! " # $ % & ' ( ) * + , - . / 0-9 : ; < = > ? @
    else if (ch === "[") out.push(0x5b);
    else if (ch === "]") out.push(0x5d);
    else if (ch === "£") out.push(0x5c);
    else throw new Error(`cannot type ${JSON.stringify(ch)} on a C64 keyboard (use a {TOKEN} for special keys)`);
  }
  return out;
}
