// A REAL agent drives a REAL machine. Costs a few cents of model use, so it only runs when asked:
//   NIX64_LIVE_AGENT=haiku NIX64_X64SC=<x64sc> NIX64_VICE_DATA=<dir> bun test tests/agent.live.test.ts
// The model name is passed to the agent; "haiku" keeps it cheap. Judged only by what the machine shows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = process.env.NIX64_LIVE_AGENT;
const X64SC = process.env.NIX64_X64SC;
const home = mkdtempSync(join(tmpdir(), "nix64-live-"));
mkdirSync(join(home, "ui"), { recursive: true });
writeFileSync(join(home, "ui/index.html"), "ok");
process.env.NIX64_HOME = home;
process.env.NIX64_NO_SYSTEMD = "1";
process.env.NIX64_UI = join(home, "ui");
const suite = MODEL && X64SC ? describe : describe.skip;
const { createHub } = await import("../src/server");
const { attachAgent } = await import("../src/agent");

suite("drive mode with a real agent", () => {
  let hub: Awaited<ReturnType<typeof createHub>>;
  let base = "", cookie = "";
  const api = (p: string, b: object = {}) => fetch(base + p, { method: "POST", headers: { cookie, "x-nix64": "1", "content-type": "application/json" }, body: JSON.stringify(b) });

  beforeAll(async () => {
    hub = await createHub();
    attachAgent(hub);
    const server = hub.start(0);
    hub.settings.agent.model = MODEL!;
    base = `http://127.0.0.1:${server.port}`;
    cookie = (await fetch(`${base}/?t=${hub.token}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
    await api("/api/machines", { name: "live" });
    expect((await api("/api/machines/live/start")).status).toBe(200);
    expect(await hub.lives.get("live")!.machine.waitForText("READY.", 25000)).not.toBeNull();
  }, 90000);

  afterAll(async () => {
    await (await import("../src/engine")).stopMachine("live");
    hub.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("it types a program that the machine runs, and the feed says what it did and how", async () => {
    const live = hub.lives.get("live")!;
    const r = await api("/api/machines/live/agent/prompt", { text: 'Write and run a one-line BASIC program that prints the word ZEBRA 3 times on separate lines. Use line number 10 and a FOR loop.' });
    expect(r.status).toBe(200);
    const end = Date.now() + 150000;
    let zebras = 0;
    while (Date.now() < end) {
      zebras = live.machine.screen().filter((x) => x.trim() === "ZEBRA").length;
      if (zebras >= 3 && !hub.agentRunning!("live")) break;
      await Bun.sleep(500);
    }
    console.log(live.feed.map((f) => `${f.kind.padEnd(7)} ${f.text.slice(0, 140)}`).join("\n"));
    console.log(JSON.stringify(live.machine.screen().filter(Boolean)));
    expect(zebras).toBeGreaterThanOrEqual(3); // the machine printed it: judged by the screen
    const typed = live.feed.filter((f) => f.kind === "machine" && f.via === "keyboard");
    expect(typed.length).toBeGreaterThan(0);
    expect(live.feed.some((f) => f.kind === "machine" && /FOR/i.test(f.text))).toBe(true); // it typed a FOR loop itself
    expect(live.feed.filter((f) => f.kind === "host").length).toBe(0); // nothing outside the machine's own inputs
  }, 200000);

  test("Stop takes the keyboard back at once", async () => {
    const live = hub.lives.get("live")!;
    await api("/api/machines/live/agent/prompt", { text: "Type a very long REM comment of 400 characters, slowly." });
    await Bun.sleep(8000);
    await api("/api/machines/live/agent/stop");
    await Bun.sleep(800);
    expect(hub.agentRunning!("live")).toBe(false);
    expect(live.machine.ring().head).toBe(live.machine.ring().tail);
    const len = live.machine.screen().join("").length;
    await Bun.sleep(1500);
    expect(live.machine.screen().join("").length).toBe(len);
  }, 90000);
});
