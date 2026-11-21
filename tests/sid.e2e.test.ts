// A SID tune played on a real engine, judged by what the emulated SID chip received. Skipped unless an engine is named:
//   NIX64_X64SC=<x64sc> NIX64_VICE_DATA=<dir> bun test tests/sid.e2e.test.ts
// The machine runs with VICE's "dump" sound device, which writes every SID register write with its cycle time. That is
// proof the tune ran on the chip, with no audio hardware needed (the heard-by-ear part is tests/sid.audio.test.ts, opt-in).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toneSid } from "./sidfixture";

const X64SC = process.env.NIX64_X64SC;
const home = mkdtempSync(join(tmpdir(), "nix64-sidsrv-"));
mkdirSync(join(home, "ui"), { recursive: true });
writeFileSync(join(home, "ui/index.html"), "ok");
process.env.NIX64_HOME = home;
process.env.NIX64_NO_SYSTEMD = "1";
process.env.NIX64_UI = join(home, "ui");
const suite = X64SC ? describe : describe.skip;
const { createHub } = await import("../src/server");
const { machineFile } = await import("../src/paths");

suite("a SID tune on a real machine", () => {
  let hub: Awaited<ReturnType<typeof createHub>>;
  let base = "", cookie = "";
  const dump = join(home, "sid.dump");
  const api = (path: string, body?: object, method = "POST") =>
    fetch(base + path, { method, headers: { cookie, "x-nix64": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  /** register writes seen so far: [reg, value] */
  const until = async (f: () => boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await Bun.sleep(100); } return false; };
  const writes = () => readFileSync(dump, "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => l.split(" ").map(Number)).map(([, reg, val]) => [reg, val] as [number, number]);
  const freq = (w: [number, number][]) => { const lo = w.findLast(([r]) => r === 0), hi = w.findLast(([r]) => r === 1); return lo && hi ? lo[1] | (hi[1] << 8) : -1; };

  beforeAll(async () => {
    hub = await createHub();
    const server = hub.start(0);
    base = `http://127.0.0.1:${server.port}`;
    cookie = (await fetch(`${base}/?t=${hub.token}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
    expect((await api("/api/machines", { name: "sid" })).status).toBe(200);
    // sound on, with the register-dump device in place of a sound card
    const t = readFileSync(machineFile("sid"), "utf8").replace("extra_args = []", `extra_args = ["-sounddev", "dump", "-soundarg", ${JSON.stringify(dump)}]`);
    writeFileSync(machineFile("sid"), t);
    expect((await api("/api/machines/sid/start")).status).toBe(200);
    expect(await hub.lives.get("sid")!.machine.waitForText("READY.", 25000)).not.toBeNull();
    // put the tune on the shelf through the real import route
    const imp = await fetch(`${base}/api/shelf/import`, { method: "POST", headers: { cookie, "x-nix64": "1", "x-filename": "tone.sid" }, body: toneSid(2) });
    expect(imp.status).toBe(200);
  }, 90000);

  afterAll(async () => {
    await api("/api/machines/sid/stop").catch(() => {});
    hub.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("the shelf lists the tune with its details", async () => {
    const items = (await (await api("/api/shelf", undefined, "GET")).json() as any).items;
    const t = items.find((i: any) => i.name === "tone.sid");
    expect(t.kind).toBe("sid");
    expect(t.sid.title).toBe("Nix64 test tone");
    expect(t.sid.songs).toBe(2);
  });

  const ram = () => hub.lives.get("sid")!.machine.snapshot().ram;
  const plays = () => { const r = ram(); return r[0x1102] | (r[0x1103] << 8); }; // the tune counts its own play calls at $1102 (RAM there starts as whatever the C64 powered up with, so only differences mean anything)
  const since = (a: number) => (plays() - a + 65536) % 65536;

  test("a BASIC program in memory is never thrown away without asking", async () => {
    const live = hub.lives.get("sid")!;
    await live.machine.type('10 PRINT "MINE"\n');
    await live.machine.waitFrames(10);
    const r = await api("/api/machines/sid/sid", { shelf: "tone.sid", song: 1 });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).needsConfirm).toBe(true);
    expect(live.machine.programLines()).toEqual([10]); // still there
    expect(ram()[0x314]).toBe(0x31); // the KERNAL's own interrupt: nothing was started
  }, 30000);

  test("Play: the tune's own code runs every frame and writes the machine's SID chip (440 Hz, triangle, gate on)", async () => {
    const r = await (await api("/api/machines/sid/sid", { shelf: "tone.sid", song: 1, force: true })).json() as any;
    expect(r.error ?? r.ok).toBe(true);
    expect(r.playing.song).toBe(1);
    const a = plays();
    await Bun.sleep(1500);
    expect(since(a)).toBeGreaterThan(40); // about 50 a second on a PAL machine: play is called once per frame
    expect(ram()[0x314]).toBe(0x40); // the frame interrupt goes through Nix64's driver
    expect(await until(() => freq(writes()) === 0x1d45, 10000)).toBe(true); // the chip got 440 Hz on the PAL clock (the dump file is buffered in 4 KB pieces)
    const w = writes();
    expect(w.findLast(([r]) => r === 4)?.[1]).toBe(0x11); // triangle wave, gate on
    expect(w.findLast(([r]) => r === 24)?.[1]).toBe(15); // volume
    expect(((await (await api("/api/machines/sid/sid", undefined, "GET")).json()) as any).playing.title).toBe("Nix64 test tone");
    expect(hub.lives.get("sid")!.machine.programLines()).toEqual([]); // the machine was reset: the tune had it
  }, 60000);

  test("another song of the same file is a different tone (880 Hz)", async () => {
    const before = writes().length;
    const r = await (await api("/api/machines/sid/sid", { shelf: "tone.sid", song: 2 })).json() as any;
    expect(r.playing.song).toBe(2);
    expect(await until(() => freq(writes().slice(before)) === 0x3a8a, 10000)).toBe(true);
  }, 60000);

  test("a song that does not exist, a missing file and a tune under the ROMs are refused, and the running tune is not disturbed", async () => {
    const n = plays();
    expect((await api("/api/machines/sid/sid", { shelf: "tone.sid", song: 3 })).status).toBeGreaterThanOrEqual(400);
    expect((await api("/api/machines/sid/sid", { shelf: "nothing.sid" })).status).toBeGreaterThanOrEqual(400);
    const under = toneSid(2); under.writeUInt16LE(0xa000, 0x7c); // the data's own load address: $A000, under the BASIC ROM
    const imp = await fetch(`${base}/api/shelf/import`, { method: "POST", headers: { cookie, "x-nix64": "1", "x-filename": "rom.sid" }, body: under });
    expect(imp.status).toBe(200);
    const r = await api("/api/machines/sid/sid", { shelf: "rom.sid" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await r.json())).toContain("under the ROMs");
    await Bun.sleep(500);
    expect(since(n)).toBeGreaterThan(10); // the tune carried on
  }, 30000);

  test("Stop puts the KERNAL's interrupt back, the tune goes quiet, and the machine is at READY.", async () => {
    expect((await api("/api/machines/sid/sid/stop")).status).toBe(200);
    expect(await hub.lives.get("sid")!.machine.waitForText("READY.", 15000)).not.toBeNull();
    const a = plays();
    await Bun.sleep(1000);
    expect(plays()).toBe(a); // play is no longer called
    expect(ram()[0x314]).toBe(0x31); // $EA31 again
    expect(ram()[0x315]).toBe(0xea);
    expect(((await (await api("/api/machines/sid/sid", undefined, "GET")).json()) as any).playing).toBeNull();
    expect((await api("/api/machines/sid/sid/stop")).status).toBe(409); // nothing playing now
  }, 30000);
});
