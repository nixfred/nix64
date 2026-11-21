// The shell server end to end, through its real doors: HTTP with the token, a WebSocket, a real engine.
// Skipped unless an engine is named:  NIX64_X64SC=<x64sc> NIX64_VICE_DATA=<dir> bun test tests/server.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const X64SC = process.env.NIX64_X64SC;
const home = mkdtempSync(join(tmpdir(), "nix64-srv-"));
const ui = join(home, "ui");
mkdirSync(ui, { recursive: true });
writeFileSync(join(ui, "index.html"), "<!doctype html><title>t</title>ok");
process.env.NIX64_HOME = home;
process.env.NIX64_NO_SYSTEMD = "1";
process.env.NIX64_UI = ui;

const suite = X64SC ? describe : describe.skip;
const { createHub } = await import("../src/server");

suite("the shell server", () => {
  let hub: Awaited<ReturnType<typeof createHub>>;
  let base = "", cookie = "";
  let ws: WebSocket;
  const frames: Buffer[] = [];
  const texts: any[] = [];

  const api = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { cookie, "x-nix64": "1", "content-type": "application/json", ...(init.headers as object) } });
  const until = async (f: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await Bun.sleep(25); } return false; };
  const send = (o: object) => ws.send(JSON.stringify(o));

  beforeAll(async () => {
    hub = await createHub();
    const server = hub.start(0);
    base = `http://127.0.0.1:${server.port}`;
    const r = await fetch(`${base}/?t=${hub.token}`, { redirect: "manual" });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
    await api("/api/machines", { method: "POST", body: JSON.stringify({ name: "srv" }) });
    const st = await api("/api/machines/srv/start", { method: "POST" });
    expect(st.status).toBe(200);
    expect(hub.lives.has("srv")).toBe(true);
    expect(await hub.lives.get("srv")!.machine.waitForText("READY.", 25000)).not.toBeNull(); // it has booted
    ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie, origin: base } } as any);
    ws.binaryType = "nodebuffer" as any;
    ws.onmessage = (e) => { if (typeof e.data === "string") texts.push(JSON.parse(e.data)); else frames.push(Buffer.from(e.data as ArrayBuffer)); };
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws failed")); });
    send({ t: "sub", subs: { srv: 30 } });
  }, 90000);

  afterAll(async () => {
    ws?.close();
    await api("/api/machines/srv/stop", { method: "POST" }).catch(() => {});
    hub.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("no cookie, wrong host and wrong origin are refused", async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(403);
    expect((await fetch(`${base}/api/state`, { headers: { host: "evil.example", cookie } })).status).toBe(421);
    expect((await fetch(`${base}/api/machines`, { method: "POST", headers: { cookie }, body: "{}" })).status).toBe(403); // no X-Nix64
    const bad = new WebSocket(`ws://127.0.0.1:${hub.server.port}/ws`, { headers: { cookie, origin: "http://evil.example" } } as any);
    const outcome = await new Promise<string>((res) => { bad.onopen = () => res("open"); bad.onerror = () => res("refused"); bad.onclose = () => res("refused"); });
    expect(outcome).toBe("refused");
  });

  test("the token opens a session and the UI is served", async () => {
    const r = await api("/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("ok");
    expect((await api("/../../etc/passwd")).status).toBe(404);
  });

  test("hello lists the machine as running, and frames arrive with the real picture", async () => {
    expect(await until(() => texts.some((t) => t.t === "hello"))).toBe(true);
    const hello = texts.find((t) => t.t === "hello");
    expect(hello.machines.find((m: any) => m.name === "srv").running).toBe(true);
    expect(await until(() => frames.length > 0)).toBe(true);
    const f = frames.at(-1)!;
    expect(f[0]).toBe(1);
    const w = f.readUInt16LE(2), h = f.readUInt16LE(4);
    expect(w).toBeGreaterThanOrEqual(320);
    expect(h).toBeGreaterThanOrEqual(200);
    expect(f.length).toBe(64 + w * h);
    const counts = new Map<number, number>();
    for (const px of f.subarray(64)) counts.set(px, (counts.get(px) ?? 0) + 1);
    expect(counts.get(14)).toBeGreaterThan(5000); // light blue border
  });

  test("a screen that does not change sends no frames at all", async () => {
    await Bun.sleep(300);
    const n = frames.length;
    await Bun.sleep(1200);
    // the BASIC cursor blinks about twice a second, so a handful of frames; never one per frame
    expect(frames.length - n).toBeLessThan(12);
  });

  test("host keys go through the symbolic map: PRINT 2*3 with a PC shift for the asterisk", async () => {
    const type = (code: string, key: string, shift = false) => { send({ t: "kd", name: "srv", code, key, shift }); send({ t: "ku", name: "srv", code }); };
    type("KeyP", "p"); type("KeyR", "r"); type("KeyI", "i"); type("KeyN", "n"); type("KeyT", "t"); type("Space", " ");
    type("Digit2", "2");
    send({ t: "shift", name: "srv", down: true });
    send({ t: "kd", name: "srv", code: "Digit8", key: "*", shift: true }); send({ t: "ku", name: "srv", code: "Digit8" });
    send({ t: "shift", name: "srv", down: false });
    type("Digit3", "3");
    await Bun.sleep(300);
    type("Enter", "Enter");
    const live = hub.lives.get("srv")!;
    const got = await until(() => live.machine.screen().some((r) => r.trim() === "6")); if (!got) console.log(JSON.stringify(live.machine.screen().filter(Boolean)), JSON.stringify(live.machine.ring()));
    expect(got).toBe(true);
    expect(live.machine.screen().some((r) => r.trim() === "PRINT 2*3")).toBe(true);
  }, 20000);

  test("paste types text into the machine, and Stop throws queued typing away", async () => {
    const live = hub.lives.get("srv")!;
    send({ t: "paste", name: "srv", text: "10 PRINT 7*7\nRUN\n" });
    expect(await until(() => live.machine.screen().some((r) => r.trim() === "49"))).toBe(true);
    send({ t: "paste", name: "srv", text: "REM " + "Z".repeat(300) });
    await Bun.sleep(500);
    send({ t: "stop", name: "srv" });
    await Bun.sleep(400);
    const len = live.machine.screen().join("").length;
    await Bun.sleep(1200);
    expect(live.machine.screen().join("").length).toBe(len);
    expect(live.feed.at(-1)?.text).toContain("Stop");
  }, 30000);

  test("status messages carry the screen text and a real frame rate", async () => {
    expect(await until(() => texts.some((t) => t.t === "status" && t.fps > 30))).toBe(true);
    const s = texts.findLast((t) => t.t === "status");
    expect(s.screen.length).toBe(25);
    expect(s.ring.free).toBeGreaterThan(200);
  });

  test("the machine file can be read, a bad edit is refused with every problem, a good one is a new generation", async () => {
    const file = await (await api("/api/machines/srv/file")).json() as any;
    expect(file.text).toContain('model  = "c64c"');
    const bad = await api("/api/machines/srv/file", { method: "PUT", body: JSON.stringify({ text: file.text.replace('"c64c"', '"zx81"').replace('"pal"', '"secam"') }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).problems.length).toBe(2);
    const good = await (await api("/api/machines/srv/file", { method: "PUT", body: JSON.stringify({ text: file.text.replace('"6581"', '"8580"'), apply: true }) })).json() as any;
    expect(good.changed).toBe(true);
    expect(good.gen).toBe(2);
    expect(good.note).toContain("Restart");
  });

  test("a bad address is a 400, and a WebSocket message that is not an object is ignored (2026-11-21 sweep)", async () => {
    expect((await api("/%zz")).status).toBe(400);
    ws.send("null"); ws.send("5"); ws.send("[1]");
    await Bun.sleep(200);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const before = texts.length;
    send({ t: "sub", subs: { srv: 30 } });
    expect(await until(() => texts.length > before)).toBe(true); // the server still answers
  });

  test("a settings value outside its list, or an endpoint that is not http(s), is put back to the default", async () => {
    const r = await (await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { assist: "x", choice: "???", localEndpoint: "javascript:alert(1)" }, display: { reducedMotion: "zz" } }) })).json() as any;
    expect(r.agent.assist).toBe("eager");
    expect(r.agent.choice).toBe("auto");
    expect(r.agent.localEndpoint).toBe("");
    expect(r.display.reducedMotion).toBe("auto");
    const ok = await (await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { assist: "quiet", localEndpoint: "http://127.0.0.1:11434" } }) })).json() as any;
    expect(ok.agent.assist).toBe("quiet");
    expect(ok.agent.localEndpoint).toBe("http://127.0.0.1:11434");
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { assist: "eager", localEndpoint: "" } }) });
  });

  test("a slow window still ends up with the newest picture when a fast window is also watching", async () => {
    const m = hub.lives.get("srv")!.machine;
    const port = new URL(base).port;
    const slowFrames: Buffer[] = [];
    const slow = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base } } as any);
    slow.binaryType = "nodebuffer" as any;
    slow.onmessage = (e) => { if (typeof e.data !== "string") slowFrames.push(Buffer.from(e.data as ArrayBuffer)); };
    await new Promise<void>((res, rej) => { slow.onopen = () => res(); slow.onerror = () => rej(new Error("ws failed")); });
    slow.send(JSON.stringify({ t: "sub", subs: { srv: 2 } })); // 2 pictures a second, while the other window takes 30
    await Bun.sleep(1200);
    // a program that holds the picture perfectly still (a running program shows no blinking cursor), with a new border colour
    for (const line of ["POKE 53280,2", "10 GOTO 10", "RUN"]) await m.type(line + "\n");
    await Bun.sleep(4000);
    const px = (b?: Buffer) => b ? Buffer.from(b.subarray(64)).toString("base64") : "";
    const fast = px(frames.at(-1)), slowest = px(slowFrames.at(-1));
    slow.close();
    expect(fast).not.toBe("");
    expect(slowest).toBe(fast); // the slow window shows the same picture, not one from before the colour change
  }, 30000);
});
