// End to end: a machine file becomes a running engine, the picture and the disk drive are real,
// and the monitor doors do their jobs. Skipped unless you say which engine to use:
//   NIX64_X64SC=<x64sc> NIX64_VICE_DATA=<vice data dir> bun test tests/engine.e2e.test.ts
// Everything runs under a throwaway NIX64_HOME, with no systemd units, and cleans up after itself.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const X64SC = process.env.NIX64_X64SC;
const home = mkdtempSync(join(tmpdir(), "nix64-e2e-"));
process.env.NIX64_HOME = home;
process.env.NIX64_NO_SYSTEMD = "1";

const suite = X64SC ? describe : describe.skip;
const { createMachine, switchMachine, listGenerations, rollback } = await import("../src/machinefile");
const { startMachine, stopMachine, runningMachines, diskPath, diskHistory } = await import("../src/engine");
const { Machine, Stopped } = await import("../src/machine");
const { attach, detach, getResource, setResource, saveSnapshot, loadSnapshot, reset } = await import("../src/monitor");
const { createD64, readDir } = await import("../src/d64");
const { paths, ensureDirs, machineFile } = await import("../src/paths");

suite("a machine from a file", () => {
  let m: InstanceType<typeof Machine>;
  let st: Awaited<ReturnType<typeof startMachine>>;

  beforeAll(async () => {
    ensureDirs();
    createMachine("e2e", "end to end");
    writeFileSync(join(paths.shelf, "tester.d64"), createD64("TESTER", "ab"));
    st = await startMachine("e2e");
    m = Machine.open(st.shm);
    expect(await m.waitForText("READY.", 20000)).not.toBeNull();
  }, 60000);

  afterAll(async () => {
    m?.close();
    await stopMachine("e2e");
    rmSync(home, { recursive: true, force: true });
  });

  test("the file became generation 1 and the engine is listed as running", () => {
    expect(listGenerations("e2e").length).toBe(1);
    expect(runningMachines().map((r) => r.name)).toEqual(["e2e"]);
    expect(m.version).toBe(4);
  });

  test("the engine publishes the real picture: borders, the palette, and the BASIC screen in it", () => {
    const p = m.picture()!;
    expect(p).not.toBeNull();
    expect(p.width).toBeGreaterThanOrEqual(320);
    expect(p.height).toBeGreaterThanOrEqual(200);
    expect(p.pal.length).toBe(16);
    // C64C boots to light blue border (index 14) around a blue screen (index 6)
    const counts = new Map<number, number>();
    for (const px of p.pix) counts.set(px, (counts.get(px) ?? 0) + 1);
    expect(counts.get(14)).toBeGreaterThan(5000);
    expect(counts.get(6)).toBeGreaterThan(20000);
    expect(p.pal[14][2]).toBeGreaterThan(p.pal[14][0]); // light blue is bluer than red
  });

  test("a disk attached through the text monitor is really there: the drive lists it", async () => {
    await attach(st.monitorPort, join(paths.shelf, "tester.d64"), 8);
    await m.type('LOAD"$",8\n');
    await m.type("LIST\n");
    expect(await m.waitForText("TESTER", 15000)).not.toBeNull();
    const rows = await m.waitForText("BLOCKS FREE", 15000);
    expect(rows).not.toBeNull();
    expect(rows!.some((r) => r.includes('"TESTER') && r.includes("AB 2A"))).toBe(true);
  }, 40000);

  test("warp is real: much faster than real time, and normal speed comes back", async () => {
    const rate = async () => { const f0 = m.frame(), t0 = performance.now(); await Bun.sleep(1000); return (m.frame() - f0) / ((performance.now() - t0) / 1000); };
    const normal = await rate();
    m.setWarp(true);
    const fast = await rate();
    m.setWarp(false);
    const back = await rate();
    expect(normal).toBeGreaterThan(40);
    expect(normal).toBeLessThan(75);
    expect(fast).toBeGreaterThan(normal * 2);
    expect(back).toBeLessThan(75);
  }, 30000);

  test("a resource set through the binary monitor sticks, and the machine carries on afterwards", async () => {
    await setResource(st.binaryPort, "SoundVolume", "37");
    expect(await getResource(st.binaryPort, "SoundVolume")).toBe(37);
    const f = m.frame();
    await m.waitFrames(10);
    expect(m.frame()).toBeGreaterThan(f);
  }, 20000);

  test("flush throws away queued typing at once and lets go of the keys", async () => {
    await m.type("NEW\n");
    const marker = () => m.screen().filter((r) => r.includes("QQQQQQQQQQQQQQQQQQQQ")).length;
    const queued = m.type("REM " + "Q".repeat(200), { framesPerKey: 2 }); // about 7 seconds of typing
    await Bun.sleep(600);
    m.flush();
    await queued.catch(() => {});
    const at = m.screen().join("").length;
    await Bun.sleep(1200);
    expect(m.ring().head).toBe(m.ring().tail); // nothing left in the ring
    expect(m.screen().join("").length).toBe(at); // and the machine typed no more
    expect(marker()).toBe(0); // it never got to 20 Q in a row: stopped well short of 200
  }, 30000);

  test("STOP also cancels a long job that is still feeding the ring (more than 256 keys)", async () => {
    await m.type("NEW\n");
    const marker = () => m.screen().filter((r) => r.includes("Q".repeat(40))).length;
    const queued = m.type("REM " + "Q".repeat(600), { framesPerKey: 1 }); // more than the ring holds: the job is still pushing when STOP comes
    const outcome = queued.then(() => "finished", (e) => (e instanceof Stopped ? "stopped" : `error: ${e.message}`));
    await Bun.sleep(700);
    m.flush();
    expect(await outcome).toBe("stopped"); // the job quit, it did not carry on
    await Bun.sleep(500);
    const at = m.screen().join("").length;
    await Bun.sleep(1500);
    expect(m.ring().head).toBe(m.ring().tail);
    expect(m.screen().join("").length).toBe(at); // nothing more was typed after STOP
    expect(marker()).toBe(0); // 600 were asked for; it never reached 40 in a row
  }, 40000);

  test("STOP also empties the C64's own keyboard buffer, not only the ring", async () => {
    await m.type("NEW\n");
    await m.type("10 GOTO 10\n");
    await m.type("RUN\n"); // a running program does not read the keyboard, so typed keys pile up in the buffer
    await m.waitFrames(20);
    await m.type("ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ", { framesPerKey: 1 });
    m.flush();
    await m.waitFrames(10);
    await m.press(["RUN/STOP"], 6);
    expect(await m.waitForText("READY.", 8000)).not.toBeNull();
    await m.waitFrames(30);
    const text = m.screen().join("\n");
    expect(text).toContain("BREAK IN 10");
    expect(text).not.toMatch(/BCDEF|FGHIJ|KLMNO/); // the queued letters were thrown away, not delivered after the break
  }, 40000);

  test("attaching something the engine cannot read is an error, not a silent success", async () => {
    const junk = join(home, "junk.d64");
    writeFileSync(junk, Buffer.from("this is not a disk image"));
    await expect(attach(st.monitorPort, junk, 8)).rejects.toThrow(/could not attach/);
    await detach(st.monitorPort, 8).catch(() => {});
  }, 20000);

  test("two Starts at once (a double click) start one engine, not two on one shared-memory file", async () => {
    createMachine("dbl", "double start");
    switchMachine("dbl");
    const [a, b] = await Promise.all([startMachine("dbl"), startMachine("dbl")]);
    try {
      expect(b.pid).toBe(a.pid);
      expect(runningMachines().filter((r) => r.name === "dbl").length).toBe(1);
      const m2 = await Machine.open(a.shm);
      expect(m2.frame()).toBeGreaterThan(0);
      m2.close();
    } finally {
      await stopMachine("dbl");
    }
  }, 90000);

  test("a snapshot restores the machine as it was", async () => {
    const zebras = () => m.screen().filter((r) => r.includes("ZEBRA42")).length;
    await m.type("NEW\n");
    await m.type("10 REM ZEBRA42\n");
    const snap = join(home, "t.vsf");
    await saveSnapshot(st.binaryPort, snap, false);
    expect(existsSync(snap)).toBe(true);
    await m.type("NEW\n");
    await m.type("LIST\n");
    await m.waitFrames(10);
    expect(zebras()).toBe(1); // only the line as typed: the program is gone
    await loadSnapshot(st.binaryPort, snap);
    await m.type("LIST\n");
    await m.waitFrames(10);
    expect(zebras()).toBe(2); // typed line, and the program is back and lists
  }, 60000);

  test("a soft reset puts READY. back", async () => {
    await m.type('PRINT "NOT READY YET"\n');
    await reset(st.binaryPort, false);
    await m.waitFrames(120);
    expect(m.screen().some((r) => r.includes("BASIC BYTES FREE"))).toBe(true);
  }, 30000);

  test("ejecting works, and a change to the file is a new generation that can be rolled back", async () => {
    await detach(st.monitorPort, 8);
    const before = listGenerations("e2e").length;
    const text = (await Bun.file(machineFile("e2e")).text()).replace('model  = "c64c"', 'model  = "c64"');
    writeFileSync(machineFile("e2e"), text);
    expect(switchMachine("e2e").changed).toBe(true);
    expect(listGenerations("e2e").length).toBe(before + 1);
    rollback("e2e", 1);
    expect((await Bun.file(machineFile("e2e")).text())).toContain('model  = "c64c"');
    expect(switchMachine("e2e").changed).toBe(false);
  });

  test("stopping keeps the disk history", async () => {
    await stopMachine("e2e");
    expect(runningMachines().length).toBe(0);
    expect(existsSync(diskPath("e2e", "8"))).toBe(true);
    expect(diskHistory("e2e", "8").length).toBeGreaterThanOrEqual(1);
    expect(readDir(await Bun.file(diskPath("e2e", "8")).bytes().then(Buffer.from))?.name).toBe("E2E");
  });
});
