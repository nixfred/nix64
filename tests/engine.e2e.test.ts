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
const { Machine } = await import("../src/machine");
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
