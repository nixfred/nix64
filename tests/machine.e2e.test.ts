// End to end: start a real Nix64 engine and drive it through src/machine.ts, judging every step by
// what the machine itself shows. Skipped unless you say which engine to use:
//
//   NIX64_X64SC=/usr/lib/nix64/bin/x64sc bun test tests/machine.e2e.test.ts
//   NIX64_X64SC=<vice tree>/src/x64sc NIX64_VICE_DATA=<vice tree>/data bun test tests/machine.e2e.test.ts
//
// On a machine with no display, add SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy for the SDL2 build.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "../src/machine";

const X64SC = process.env.NIX64_X64SC;
const suite = X64SC ? describe : describe.skip;

suite("a driven machine", () => {
  let dir: string, proc: ReturnType<typeof Bun.spawn>, m: Machine;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "nix64-e2e-"));
    const path = join(dir, "t.shm");
    const data = process.env.NIX64_VICE_DATA ? ["-directory", process.env.NIX64_VICE_DATA] : [];
    proc = Bun.spawn([X64SC!, "+logcolorize", ...data, "-ntsc", "+sound"], {
      env: { ...process.env, NIX64_TELEMETRY: path },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 200; i++) {
      try { m = Machine.open(path); break; } catch { await Bun.sleep(50); }
    }
    expect(m).toBeDefined();
    expect(await m.waitForText("READY.", 20000)).not.toBeNull();
  }, 30000);

  afterAll(() => {
    m?.close();
    proc?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the engine speaks telemetry version 2 and can be driven", () => {
    expect(m.version).toBeGreaterThanOrEqual(2); // 4 with patches 0003 and 0004; the input ring is from version 2
    expect(m.canDrive).toBe(true);
    expect(m.screen().some((r) => r.includes("BASIC BYTES FREE"))).toBe(true);
  });

  test("types a program, runs it, and the machine prints the answer", async () => {
    await m.type("10 PRINT 6*7\n");
    await m.type("RUN\n");
    const rows = await m.waitForText(" 42", 8000);
    expect(rows).not.toBeNull();
    expect(rows!.some((r) => r.trim() === "42")).toBe(true);
  }, 20000);

  test("RUN/STOP, pressed through the keyboard matrix, breaks a running program", async () => {
    await m.type("NEW\n");
    await m.type("10 GOTO 10\n");
    await m.type("RUN\n");
    await m.waitFrames(30); // it is spinning now
    await m.press(["stop"], 6);
    const rows = await m.waitForText("BREAK IN 10", 8000);
    expect(rows).not.toBeNull();
  }, 30000);

  test("a stick is read back by the C64 itself (port 2 up = 126, port 1 fire = 239)", async () => {
    await m.type("NEW\n");
    await m.type("10 A=PEEK(56320):IF A=127 THEN 10\n"); // wait for the stick to move
    await m.type("20 PRINT A;PEEK(56321)\n");
    await m.type("RUN\n");
    m.setJoystick(2, "up");
    m.setJoystick(1, "fire");
    const rows = await m.waitForText("126  239", 8000);
    m.setJoystick(2, "none");
    m.setJoystick(1, "none");
    await m.drained();
    expect(rows).not.toBeNull();
  }, 30000);

  test("wait times out cleanly, and an unknown key is refused", async () => {
    expect(await m.waitForText("THIS NEVER APPEARS", 300)).toBeNull();
    await expect(m.press(["banana"])).rejects.toThrow(/no key/);
  });

  test("typing is counted in emulated frames", async () => {
    await m.type("NEW\n");
    const text = "REM FRAME PACED TYPING";
    const f0 = m.frame();
    await m.type(text, { framesPerKey: 3 });
    const used = m.frame() - f0;
    // 22 keys at 3 frames each, plus a short lead-in before the first one
    expect(used).toBeGreaterThanOrEqual(text.length * 3 - 3);
    expect(used).toBeLessThan(text.length * 3 + 30);
  }, 20000);
});
