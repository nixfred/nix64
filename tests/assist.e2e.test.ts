// The assistant, watching a real machine through its real doors, judged by what the machine itself shows.
//   NIX64_X64SC=<x64sc> NIX64_VICE_DATA=<dir> bun test tests/assist.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const X64SC = process.env.NIX64_X64SC;
const home = mkdtempSync(join(tmpdir(), "nix64-assist-"));
mkdirSync(join(home, "ui"), { recursive: true });
writeFileSync(join(home, "ui/index.html"), "ok");
process.env.NIX64_HOME = home;
process.env.NIX64_NO_SYSTEMD = "1";
process.env.NIX64_UI = join(home, "ui");
const suite = X64SC ? describe : describe.skip;
const { createHub } = await import("../src/server");
const { attachAgent } = await import("../src/agent");

suite("the assistant", () => {
  let hub: Awaited<ReturnType<typeof createHub>>;
  let ws: WebSocket;
  let base = "", cookie = "";
  const cards: any[][] = [], guides: any[] = [], feeds: any[] = [];
  const send = (o: object) => ws.send(JSON.stringify(o));
  const until = async (f: () => boolean, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await Bun.sleep(40); } return false; };
  const live = () => hub.lives.get("as")!;
  const lastCards = () => cards.at(-1) ?? [];
  const lastGuide = () => guides.at(-1);

  beforeAll(async () => {
    hub = await createHub();
    attachAgent(hub);
    const server = hub.start(0);
    base = `http://127.0.0.1:${server.port}`;
    cookie = (await fetch(`${base}/?t=${hub.token}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
    const api = (p: string, b: object = {}) => fetch(base + p, { method: "POST", headers: { cookie, "x-nix64": "1", "content-type": "application/json" }, body: JSON.stringify(b) });
    await api("/api/machines", { name: "as" });
    expect((await api("/api/machines/as/start")).status).toBe(200);
    expect(await live().machine.waitForText("READY.", 25000)).not.toBeNull();
    ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie, origin: base } } as any);
    ws.onmessage = (e) => { if (typeof e.data !== "string") return; const m = JSON.parse(e.data); if (m.t === "cards") cards.push(m.cards); if (m.t === "guide") guides.push(m.guide); if (m.t === "feed") feeds.push(m.item); };
    await new Promise<void>((r) => (ws.onopen = () => r()));
    send({ t: "sub", subs: { as: 5 } });
  }, 90000);

  afterAll(async () => {
    ws?.close();
    await hub.lives.get("as") && (await import("../src/engine")).stopMachine("as");
    hub.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("a command from another BASIC gets a card that names what you were trying to do", async () => {
    await live().machine.type("SOUND 1,2,3\n");
    expect(await until(() => lastCards().some((c: any) => /make a sound/.test(c.title)))).toBe(true);
    const c = lastCards().find((x: any) => /make a sound/.test(x.title));
    expect(c.body).toContain("no SOUND");
    expect(c.actions.map((a: any) => a.label)).toEqual(["Do it for me", "Guide me", "Not now"]);
  }, 30000);

  test("Do it for me types the C64 way on the real keyboard, and the machine accepts it", async () => {
    const id = lastCards().find((x: any) => /make a sound/.test(x.title)).id;
    send({ t: "card", name: "as", id, action: "do" });
    expect(await until(() => live().machine.screen().some((r) => r.includes("POKE 54276,17")), 25000)).toBe(true);
    await Bun.sleep(1500);
    const rows = live().machine.screen();
    // the six POKEs went in without a single new error row
    expect(rows.filter((r) => r.startsWith("?")).length).toBe(1); // only the SOUND error from before
    expect(feeds.some((f) => f.kind === "machine" && f.via === "keyboard" && f.text.includes("POKE 54296,15"))).toBe(true);
    expect(lastCards().some((c: any) => /make a sound/.test(c.title))).toBe(false);
  }, 60000);

  test("Guide me lights the next key, follows what you type, and finishes only when you did", async () => {
    await live().machine.type("CLS\n");
    expect(await until(() => lastCards().some((c: any) => /clear the screen/.test(c.title)), 20000)).toBe(true);
    const id = lastCards().find((x: any) => /clear the screen/.test(x.title)).id;
    // eager mode waits between cards: the second came because the first three cards are not rate limited
    send({ t: "card", name: "as", id, action: "guide" });
    expect(await until(() => lastGuide()?.keys?.length > 0)).toBe(true);
    expect(lastGuide().line).toBe("PRINT CHR$(147)");
    expect(lastGuide().keys).toEqual(["P"]);
    const typeKey = async (ch: string) => { await live().machine.type(ch); await until(() => true, 10); };
    await typeKey("P");
    expect(await until(() => lastGuide()?.keys?.[0] === "R")).toBe(true);
    await live().machine.type("RINT CHR");
    expect(await until(() => lastGuide()?.keys?.[0] === "LSHIFT" && lastGuide()?.keys?.[1] === "4")).toBe(true); // the dollar sign
    await live().machine.type("$(147)");
    expect(await until(() => lastGuide()?.keys?.[0] === "RETURN")).toBe(true);
    await live().machine.type("\n");
    expect(await until(() => lastGuide() === null)).toBe(true);
    expect(lastCards().some((c: any) => /how it is done on a C64/.test(c.title))).toBe(true);
    // the user typed it, so no feed line says the agent typed it
    expect(feeds.some((f) => f.kind === "machine" && f.text.includes("CHR$(147)"))).toBe(false);
  }, 90000);

  test("dismissing makes the next card wait; Quiet means no cards at all", async () => {
    hub.settings.agent.assist = "quiet";
    await Bun.sleep(600);
    const before = cards.length;
    await live().machine.type("GRAPHICS 2\n");
    await Bun.sleep(2500);
    expect(lastCards().some((c: any) => /draw graphics/.test(c.title))).toBe(false);
    hub.settings.agent.assist = "eager";
  }, 30000);

  test("Stop throws away a guide and anything queued", async () => {
    hub.settings.agent.assist = "eager";
    live().machine.type("REM " + "Q".repeat(120)).catch(() => {});
    await Bun.sleep(400);
    send({ t: "stop", name: "as" });
    await Bun.sleep(600);
    expect(live().machine.ring().head).toBe(live().machine.ring().tail);
    expect(lastGuide() ?? null).toBeNull();
  }, 30000);
});
