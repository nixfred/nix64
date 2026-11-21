// A disk is a disk: the real 1541 emulation writes a file, the shell reads the directory from the image, and
// "load and run" types LOAD for you and the program runs. Judged by what the machine and the image show.
//   NIX64_X64SC=<x64sc> NIX64_VICE_DATA=<dir> bun test tests/disk.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const X64SC = process.env.NIX64_X64SC;
const home = mkdtempSync(join(tmpdir(), "nix64-disk-"));
mkdirSync(join(home, "ui"), { recursive: true });
writeFileSync(join(home, "ui/index.html"), "ok");
process.env.NIX64_HOME = home;
process.env.NIX64_NO_SYSTEMD = "1";
process.env.NIX64_UI = join(home, "ui");
const suite = X64SC ? describe : describe.skip;
const { createHub } = await import("../src/server");
const { readDir } = await import("../src/d64");
const { paths, diskPath: _ } = { ...(await import("../src/paths")), diskPath: null };
const { diskPath, diskHistory } = await import("../src/engine");

suite("disks", () => {
  let hub: Awaited<ReturnType<typeof createHub>>;
  let base = "", cookie = "";
  const api = (p: string, b?: object, method = "POST") => fetch(base + p, { method, headers: { cookie, "x-nix64": "1", "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  const live = () => hub.lives.get("dk")!;

  beforeAll(async () => {
    hub = await createHub();
    const server = hub.start(0);
    base = `http://127.0.0.1:${server.port}`;
    cookie = (await fetch(`${base}/?t=${hub.token}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
    await api("/api/machines", { name: "dk" });
    expect((await api("/api/machines/dk/start")).status).toBe(200);
    expect(await live().machine.waitForText("READY.", 25000)).not.toBeNull();
  }, 90000);

  afterAll(async () => {
    await (await import("../src/engine")).stopMachine("dk");
    hub.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("the machine SAVEs a program with the real drive, and the image shows it in its directory", async () => {
    const m = live().machine;
    await m.type('10 PRINT "DISK WORKS"\n');
    await m.type('SAVE"HELLO",8\n');
    expect(await m.waitForText("SAVING HELLO", 15000)).not.toBeNull();
    await m.waitFrames(400); // the 1541 takes a few seconds
    const rows = m.screen();
    expect(rows.some((r) => r.startsWith("?"))).toBe(false);
    await api("/api/machines/dk/drives/8/export", { name: "first" }); // flushes the drive to the image
    const dir = readDir(readFileSync(diskPath("dk", "8")));
    expect(dir).not.toBeNull();
    expect(dir!.entries.map((e) => `${e.name}.${e.type}`)).toContain("HELLO.PRG");
    expect(dir!.entries.find((e) => e.name === "HELLO")!.blocks).toBe(1);
    expect(dir!.blocksFree).toBe(664 - 1); // a blank 1541 disk has 664 blocks free
  }, 60000);

  test("a copy goes to the shelf, and the drive info reads its name", async () => {
    const r = await (await api("/api/machines/dk/drives/8/export", { name: "mine" })).json() as any;
    expect(r.name).toBe("mine.d64");
    const d = await (await api("/api/machines/dk/drives", undefined, "GET")).json() as any;
    expect(d.drives[0].disk.entries.some((e: any) => e.name === "HELLO")).toBe(true);
    const shelf = await (await api("/api/shelf", undefined, "GET")).json() as any;
    expect(shelf.items.find((i: any) => i.name === "mine.d64").title).toContain("1 files");
  });

  test("a blank disk replaces it, and the old one is kept in the history", async () => {
    const before = diskHistory("dk", "8").length;
    await api("/api/machines/dk/drives/8/insert", { blank: "EMPTY" });
    expect(readDir(readFileSync(diskPath("dk", "8")))!.entries.length).toBe(0);
    const h = diskHistory("dk", "8");
    expect(h.length).toBeGreaterThan(before);
    // put the first state back through the API and the program is on the disk again
    const withProgram = (await Promise.all(h.map(async (x) => ({ x, d: readDir(readFileSync(join(home, "data/machines/dk/history/8", x.file))) })))).find((y) => y.d?.entries.some((e) => e.name === "HELLO"));
    expect(withProgram).toBeDefined();
    expect((await api("/api/machines/dk/drives/8/restore", { file: withProgram!.x.file })).status).toBe(200);
    expect(readDir(readFileSync(diskPath("dk", "8")))!.entries.some((e) => e.name === "HELLO")).toBe(true);
  }, 30000);

  test("load and run from the shelf: LOAD is typed for you, warp goes on and off, and the program runs", async () => {
    const m = live().machine;
    await api("/api/machines/dk/drives/8/insert", { blank: "SCRATCH" });
    await m.type("NEW\n");
    await m.type("{CLR}"); // an empty screen, so what shows up later is the program's own output
    expect((await api("/api/machines/dk/run", { shelf: "mine.d64" })).status).toBe(200);
    // the typing is visible, in order, on the real keyboard
    expect(await m.waitForText('LOAD"*",8,1', 15000)).not.toBeNull();
    const end = Date.now() + 90000;
    while (Date.now() < end && !m.screen().some((r) => r.trim() === "DISK WORKS")) await Bun.sleep(200); // printed by the program: nobody typed that
    expect(m.screen().some((r) => r.trim() === "DISK WORKS")).toBe(true);
    expect(live().warp).toBe(false); // warp switched itself off again
    const said = live().feed.map((f) => f.text).join("\n");
    expect(said).toContain("Warp is on while it loads");
    expect(said).toContain("`RUN`");
  }, 150000);
});
