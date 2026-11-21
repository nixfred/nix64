// What the agent's words and calls mean, and the free local rules: no engine, no network, no model.
// Run: bun test tests/agent.test.ts
import { describe, expect, test } from "bun:test";
import { describeCall, words } from "../src/agent";
import { DIALECT, dialectHint } from "../src/dialect";
import { keysForChar } from "../src/hostkeys";

describe("reading the agent's shell calls", () => {
  test("words keeps quoted text together", () => {
    expect(words(`bun /x/c64ctl.ts --path /run/a.shm line 'PRINT "HI"'`)).toEqual(["bun", "/x/c64ctl.ts", "--path", "/run/a.shm", "line", 'PRINT "HI"']);
    expect(words('a "b c" d\\ e')).toEqual(["a", "b c", "d\\", "e"]);
  });
  test("a typed line is ON THE C64, via the keyboard", () => {
    const d = describeCall(`bun /opt/nix64/bin/c64ctl.ts --path /run/x.shm line '10 PRINT "A"'`);
    expect(d).toEqual([{ kind: "machine", text: 'Typed `10 PRINT "A"` and pressed RETURN.', via: "keyboard" }]);
  });
  test("looking at the screen is a note, not an action", () => {
    expect(describeCall("bun /o/c64ctl.ts --path /r.shm screen")[0].kind).toBe("note");
    expect(describeCall("bun /o/c64ctl.ts wait 'READY.' --timeout 20")[0].text).toContain("READY.");
  });
  test("anything that is not c64ctl is labelled as refused", () => {
    const d = describeCall("rm -rf ~ && bun /o/c64ctl.ts screen");
    expect(d[0].kind).toBe("host");
    expect(d[0].text).toContain("not allowed");
    expect(d[1].kind).toBe("note");
  });
  test("flags are not mistaken for the command", () => {
    expect(describeCall("bun c64ctl.ts --cps 10 --path /r.shm key stop")[0].text).toBe("Pressed STOP.");
  });
});

describe("other BASICs' commands", () => {
  test("SOUND, CLS, COLOR, ELSE and PRINT USING are found at the start of a line, with or without a line number", () => {
    for (const [line, word] of [["SOUND 1,2,3", "SOUND"], ["10 CLS", "CLS"], ["  color 2", "COLOR"], ["20 ELSE PRINT 1", "ELSE"], ["PRINT USING \"##\";A", "PRINTUSING"]] as const) {
      expect(dialectHint(line)?.word).toBe(word);
    }
  });
  test("real BASIC V2 commands are never flagged", () => {
    for (const line of ["PRINT 1", "10 FOR I=1 TO 9", "POKE 53280,0", "GOTO 10", "LIST", "RUN", "10 IF A THEN B=1"]) expect(dialectHint(line)).toBeNull();
  });
  test("every suggested line fits on one screen row and can be typed on the C64 keyboard", () => {
    for (const [word, hint] of Object.entries(DIALECT)) for (const line of hint.lines) {
      expect(line.length, `${word}: ${line}`).toBeLessThanOrEqual(40);
      for (const ch of line) expect(keysForChar(ch), `${word} can't type ${JSON.stringify(ch)} in ${line}`).not.toBeNull();
    }
  });
});

describe("which keys to light for a character", () => {
  test("letters, digits, space, return", () => {
    expect(keysForChar("p")).toEqual(["P"]);
    expect(keysForChar("7")).toEqual(["7"]);
    expect(keysForChar(" ")).toEqual(["SPACE"]);
    expect(keysForChar("\n")).toEqual(["RETURN"]);
  });
  test("punctuation that needs the C64's shift lights it too", () => {
    expect(keysForChar('"')).toEqual(["LSHIFT", "2"]);
    expect(keysForChar("(")).toEqual(["LSHIFT", "8"]);
    expect(keysForChar("$")).toEqual(["LSHIFT", "4"]);
    expect(keysForChar("*")).toEqual(["*"]);
    expect(keysForChar(":")).toEqual([":"]);
  });
  test("what the C64 keyboard cannot type is null", () => {
    expect(keysForChar("é")).toBeNull();
    expect(keysForChar("{")).toBeNull();
  });
});
