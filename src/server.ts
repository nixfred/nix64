// The Nix64 shell's server. It runs on loopback only (127.0.0.1), checks a per-session token, and
// sits between the browser window (the UI) and the machines (shared memory + the input ring).
//   - frames: each machine's picture is sent to the window as palette indices, only when it changed
//   - keys:   the window sends host key events; they are mapped symbolically and pushed to the ring
//   - REST:   machines, files, media, settings, shelf, agent
// It never opens a port on any other interface, and never uses `tailscale serve` (Law 23): if a machine
// is ever shared on the tailnet it is the host's own listener, opted into per machine.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { Live } from "./live";
import { readState, runningMachines, startMachine, stopMachine, type RunState } from "./engine";
import { MachineFileError, createMachine, currentGeneration, evaluate, hashOf, listGenerations, machineNames, rollback, switchMachine, type MachineDef } from "./machinefile";
import { machineFile, paths, statePath, ensureDirs } from "./paths";
import { loadSettings, saveSettings, type Settings } from "./settings";
import { reset as monitorReset } from "./monitor";

export type ClientData = { id: number; subs: Map<string, { minMs: number; last: number; force: boolean }> };
type Handler = (hub: Hub, req: Request, m: RegExpMatchArray, url: URL) => Promise<Response> | Response;
export type Route = [method: string, pattern: RegExp, handler: Handler];

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, message: string, extra: object = {}) => json({ ok: false, error: message, ...extra }, status);

const UI_DIR = process.env.NIX64_UI ?? resolve(import.meta.dir, "../ui");
const MIDS_START = 1;

export type MachineSummary = {
  name: string;
  description: string;
  running: boolean;
  mid: number | null;
  gen: number;
  hash: string;
  model: string;
  region: string;
  sid: string;
  drives: { slot: string; type: string; mode: string; image?: string }[];
  problems: string[];
  fps: number;
  warp: boolean;
  started?: string;
};

export class Hub {
  lives = new Map<string, Live>();
  clients = new Set<ServerWebSocket<ClientData>>();
  mids = new Map<string, number>();
  nextMid = MIDS_START;
  settings: Settings = loadSettings();
  routes: Route[] = [];
  server!: Server<ClientData>;
  readonly token = randomBytes(24).toString("base64url");
  private nextClient = 1;
  private timers: ReturnType<typeof setInterval>[] = [];
  private listSig = "";
  /** modules (assist, agent) hang their per-machine work on these */
  onLive: ((live: Live) => void)[] = [];
  onLiveGone: ((name: string) => void)[] = [];
  onTick: ((live: Live) => void)[] = [];
  /** a window subscribed to a machine for the first time: send it the machine's feed and cards */
  onSub: ((ws: ServerWebSocket<ClientData>, name: string) => void)[] = [];

  midOf(name: string): number {
    let m = this.mids.get(name);
    if (!m) { m = this.nextMid++; this.mids.set(name, m); }
    return m;
  }

  // ---------- machines ----------

  /** Reconcile what is running with what we hold open. Returns true if the set changed. */
  syncLives(): boolean {
    const running = new Map(runningMachines().map((s) => [s.name, s]));
    let changed = false;
    for (const [name, live] of this.lives) {
      const st = running.get(name);
      if (!st || st.started !== live.state.started) {
        live.close();
        this.lives.delete(name);
        for (const f of this.onLiveGone) f(name);
        changed = true;
      }
    }
    for (const [name, st] of running) {
      if (this.lives.has(name)) continue;
      try {
        const live = new Live(st);
        this.lives.set(name, live);
        for (const f of this.onLive) f(live);
        changed = true;
      } catch { /* still starting: try again on the next sweep */ }
    }
    return changed;
  }

  summary(name: string): MachineSummary {
    const live = this.lives.get(name);
    let def: MachineDef | undefined;
    const problems: string[] = [];
    try { def = evaluate(readFileSync(machineFile(name), "utf8"), name); } catch (e) {
      if (e instanceof MachineFileError) problems.push(...e.problems); else problems.push((e as Error).message);
    }
    return {
      name,
      description: def?.description ?? "",
      running: !!live,
      mid: live ? this.midOf(name) : null,
      gen: currentGeneration(name),
      hash: def ? hashOf(def).slice(0, 12) : "",
      model: def?.model ?? "?",
      region: def?.region ?? "?",
      sid: def?.sid.model ?? "?",
      drives: def ? (["8", "9", "10", "11"] as const).filter((s) => def!.drives[s].mode !== "none").map((s) => ({ slot: s, type: def!.drives[s].type, mode: def!.drives[s].mode, image: def!.drives[s].image?.name })) : [],
      problems,
      fps: Math.round((live?.fps ?? 0) * 10) / 10,
      warp: live?.warp ?? false,
      started: live?.state.started,
    };
  }

  machines(): MachineSummary[] {
    return machineNames().map((n) => this.summary(n));
  }

  /** Tell every window the list of machines, if it changed. */
  publishMachines(force = false): void {
    const list = this.machines();
    const sig = JSON.stringify(list.map((m) => ({ ...m, fps: 0 })));
    if (!force && sig === this.listSig) return;
    this.listSig = sig;
    this.broadcast({ t: "machines", list });
  }

  broadcast(msg: object): void {
    const s = JSON.stringify(msg);
    for (const ws of this.clients) ws.send(s);
  }

  // ---------- frames ----------

  private encode(mid: number, p: NonNullable<ReturnType<Live["picture"]>>): Buffer {
    const out = Buffer.alloc(64 + p.width * p.height);
    out[0] = 1; out[1] = mid;
    out.writeUInt16LE(p.width, 2); out.writeUInt16LE(p.height, 4);
    out.writeUInt16LE(Math.round(p.aspect * 1000), 6); out.writeUInt16LE(p.lines, 8);
    out.writeUInt32LE(p.frame, 10);
    for (let i = 0; i < 16; i++) { out[16 + i * 3] = p.pal[i][0]; out[17 + i * 3] = p.pal[i][1]; out[18 + i * 3] = p.pal[i][2]; }
    out.set(p.pix, 64);
    return out;
  }

  private pump(): void {
    const now = performance.now();
    for (const [name, live] of this.lives) {
      let f: number;
      try { f = live.machine.frame(); } catch { continue; }
      if (f !== live.lastFrame) { live.lastFrame = f; live.sampleFps(f); }
      const want: ServerWebSocket<ClientData>[] = [];
      for (const ws of this.clients) {
        const sub = ws.data.subs.get(name);
        if (sub && (sub.force || (f !== live.lastPicture?.frame && now - sub.last >= sub.minMs))) want.push(ws);
      }
      if (!want.length) continue;
      let pic;
      try { pic = live.picture(); } catch { continue; }
      if (!pic) continue;
      const buf = this.encode(this.midOf(name), pic);
      const same = live.lastPicture && live.lastPicture.w === pic.width && live.lastPicture.h === pic.height
        && Buffer.compare(live.lastPicture.pix, buf.subarray(64)) === 0 && Buffer.compare(live.lastPicture.pal, buf.subarray(16, 64)) === 0;
      live.lastPicture = { frame: f, w: pic.width, h: pic.height, pal: Buffer.from(buf.subarray(16, 64)), pix: Buffer.from(buf.subarray(64)) };
      for (const ws of want) {
        const sub = ws.data.subs.get(name)!;
        if (same && !sub.force) { sub.last = now; continue; } // nothing changed on screen: send nothing
        if (ws.getBufferedAmount() > 1_500_000) continue; // a slow window: skip frames rather than queue them
        sub.force = false;
        sub.last = now;
        ws.send(buf);
      }
    }
  }

  private status(): void {
    for (const [name, live] of this.lives) {
      let wanted = false;
      for (const ws of this.clients) if (ws.data.subs.has(name)) { wanted = true; break; }
      if (!wanted) continue;
      try {
        const s = live.machine.snapshot();
        const msg = {
          t: "status", name, mid: this.midOf(name), frame: s.frame, fps: Math.round(live.fps * 10) / 10,
          jiffies: live.machine.jiffies(s), cursor: live.machine.cursor(s), border: s.vic[0x20] & 15, background: s.vic[0x21] & 15,
          warp: live.warp, ring: live.machine.ring(), screen: live.machine.screen(s),
        };
        const str = JSON.stringify(msg);
        for (const ws of this.clients) if (ws.data.subs.has(name)) ws.send(str);
      } catch { /* mid-start or stopping */ }
      for (const f of this.onTick) { try { f(live); } catch (e) { console.error(`nix64: ${name}:`, e); } }
    }
  }

  // ---------- http ----------

  private authed(req: Request, url: URL): boolean {
    const host = req.headers.get("host") ?? "";
    if (host !== `127.0.0.1:${this.server.port}` && host !== `localhost:${this.server.port}`) return false; // DNS rebinding
    const cookie = /(?:^|;\s*)nix64=([\w-]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? "";
    const a = Buffer.from(cookie), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handle(req: Request, server: Server<ClientData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? "";
    if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) return new Response("wrong host", { status: 421 });

    // the launcher opens /?t=TOKEN once: set the cookie and drop the token from the address bar
    if (url.pathname === "/" && url.searchParams.get("t")) {
      const t = url.searchParams.get("t")!;
      if (t.length === this.token.length && timingSafeEqual(Buffer.from(t), Buffer.from(this.token))) {
        return new Response(null, { status: 302, headers: { location: "/", "set-cookie": `nix64=${this.token}; HttpOnly; SameSite=Strict; Path=/` } });
      }
    }
    if (!this.authed(req, url)) {
      return new Response("<!doctype html><meta charset=utf-8><title>Nix64</title><body style='font:16px system-ui;background:#10163a;color:#cfd6ff;padding:3em'><h2>READY.</h2><p>Open Nix64 with the <code>nix64</code> command; this address needs the session token.</p>", { status: 403, headers: { "content-type": "text/html" } });
    }

    if (url.pathname === "/ws") {
      const origin = req.headers.get("origin");
      if (origin && origin !== `http://127.0.0.1:${server.port}` && origin !== `http://localhost:${server.port}`) return new Response("bad origin", { status: 403 });
      if (server.upgrade(req, { data: { id: this.nextClient++, subs: new Map() } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.headers.get("x-nix64") !== "1") return fail(403, "missing X-Nix64 header");
      for (const [method, pattern, handler] of this.routes) {
        if (method !== req.method) continue;
        const m = url.pathname.match(pattern);
        if (!m) continue;
        try {
          return await handler(this, req, m, url);
        } catch (e) {
          if (e instanceof MachineFileError) return fail(400, e.message, { problems: e.problems });
          return fail(500, (e as Error).message);
        }
      }
      return fail(404, "no such endpoint");
    }

    // static UI
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "");
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const file = join(UI_DIR, rel);
    if (!file.startsWith(UI_DIR) || !existsSync(file) || !statSync(file).isFile()) return new Response("not found", { status: 404 });
    return new Response(Bun.file(file), { headers: { "cache-control": "no-cache" } });
  }

  // ---------- websocket ----------

  private wsMessage(ws: ServerWebSocket<ClientData>, raw: string | Buffer): void {
    if (typeof raw !== "string") return;
    let msg: Record<string, any>;
    try { msg = JSON.parse(raw); } catch { return; }
    const live = typeof msg.name === "string" ? this.lives.get(msg.name) : undefined;
    switch (msg.t) {
      case "sub": {
        const next = new Map<string, { minMs: number; last: number; force: boolean }>();
        for (const [name, fps] of Object.entries((msg.subs ?? {}) as Record<string, number>)) {
          if (!this.lives.has(name)) continue;
          const old = ws.data.subs.get(name);
          next.set(name, { minMs: 1000 / Math.max(1, Math.min(60, Number(fps) || 60)), last: 0, force: !old });
          if (!old) for (const f of this.onSub) f(ws, name);
        }
        ws.data.subs = next;
        break;
      }
      case "kd": if (live) live.keyboard.down({ code: String(msg.code), key: String(msg.key ?? ""), shift: !!msg.shift }); break;
      case "ku": if (live) live.keyboard.up(String(msg.code)); break;
      case "shift": if (live) live.keyboard.setShift(!!msg.down); break;
      case "release": if (live) live.keyboard.releaseAll(); break;
      case "osk": if (live) live.key(String(msg.key), !!msg.down); break;
      case "joy": if (live && (msg.port === 1 || msg.port === 2)) { try { live.joystick(msg.port, String(msg.spec ?? "none")); } catch { /* bad spec */ } } break;
      case "paste": if (live && typeof msg.text === "string") live.machine.type(msg.text.slice(0, 20000), { framesPerKey: 2 }).catch(() => {}); break;
      case "restore": if (live) live.machine.restore().catch(() => {}); break;
      case "stop": if (live) this.stopDriving(live); break;
      case "warp": if (live) { try { live.setWarp(!!msg.on); } catch { /* old engine */ } } break;
      default: for (const f of this.wsExtra) f(ws, msg, live);
    }
  }
  /** set by the agent module: is a drive-mode run active on this machine? */
  agentRunning?: (name: string) => boolean;
  /** feature modules (agent, assist, tools) add their own socket messages here */
  wsExtra: ((ws: ServerWebSocket<ClientData>, msg: Record<string, any>, live?: Live) => void)[] = [];
  /** the Stop key: whoever is driving lets go, now. The agent module adds its own stop here. */
  stopHooks: ((live: Live) => void)[] = [];
  stopDriving(live: Live): void {
    for (const f of this.stopHooks) f(live);
    live.keyboard.releaseAll();
    try { live.machine.flush(); } catch { /* engine without patch 0004 */ }
    live.queueCleared();
    live.say("note", "Stop: everything queued was thrown away and every key and stick was released.");
  }

  // ---------- life cycle ----------

  start(port = Number(process.env.NIX64_PORT ?? 6464)): Server<ClientData> {
    ensureDirs();
    const self = this;
    const options = {
      hostname: "127.0.0.1",
      fetch: (req: Request, server: Server<ClientData>) => self.handle(req, server),
      websocket: {
        maxPayloadLength: 1_000_000,
        open(ws: ServerWebSocket<ClientData>) {
          self.clients.add(ws);
          ws.send(JSON.stringify({ t: "hello", version: 1, settings: self.settings, machines: self.machines(), mids: Object.fromEntries(self.mids) }));
        },
        message: (ws: ServerWebSocket<ClientData>, raw: string | Buffer) => self.wsMessage(ws, raw),
        close(ws: ServerWebSocket<ClientData>) { self.clients.delete(ws); },
      },
    };
    try {
      this.server = Bun.serve<ClientData, {}>({ ...options, port } as any);
    } catch (e) {
      if (port === 0 || !/EADDRINUSE|in use/i.test(String((e as Error).message))) throw e;
      this.server = Bun.serve<ClientData, {}>({ ...options, port: 0 } as any); // 6464 is taken: any free port will do
    }
    this.syncLives();
    this.timers.push(setInterval(() => this.pump(), 8));
    this.timers.push(setInterval(() => this.status(), 200));
    this.timers.push(setInterval(() => { if (this.syncLives()) this.publishMachines(true); else this.publishMachines(); }, 1000));
    writeFileSync(join(paths.run, "server.json"), JSON.stringify({ pid: process.pid, port: this.server.port, token: this.token, started: new Date().toISOString() }), { mode: 0o600 });
    return this.server;
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    for (const live of this.lives.values()) live.close();
    this.server?.stop(true);
    rmSync(join(paths.run, "server.json"), { force: true });
  }
}

// ---------- the core REST routes ----------

const body = async (req: Request) => (await req.json().catch(() => ({}))) as Record<string, any>;
const nameOk = (n: string) => machineNames().includes(n);

export const coreRoutes: Route[] = [
  ["GET", /^\/api\/state$/, (hub) => json({ ok: true, machines: hub.machines(), settings: hub.settings })],

  ["GET", /^\/api\/settings$/, (hub) => json(hub.settings)],
  ["PUT", /^\/api\/settings$/, async (hub, req) => { hub.settings = saveSettings(await body(req)); hub.broadcast({ t: "settings", settings: hub.settings }); return json(hub.settings); }],

  ["POST", /^\/api\/machines$/, async (hub, req) => {
    const b = await body(req);
    createMachine(String(b.name ?? ""), typeof b.description === "string" ? b.description : undefined, typeof b.preset === "string" ? b.preset : undefined);
    switchMachine(String(b.name));
    hub.publishMachines(true);
    return json({ ok: true });
  }],

  ["GET", /^\/api\/machines\/([^/]+)\/file$/, (_hub, _req, m) => {
    if (!nameOk(m[1])) return fail(404, "no such machine");
    return json({ ok: true, text: readFileSync(machineFile(m[1]), "utf8"), generations: listGenerations(m[1]).map((g) => ({ n: g.n, time: g.time, hash: g.hash.slice(0, 12) })), current: currentGeneration(m[1]) });
  }],
  ["PUT", /^\/api\/machines\/([^/]+)\/file$/, async (hub, req, m) => {
    if (!nameOk(m[1])) return fail(404, "no such machine");
    const b = await body(req);
    const text = String(b.text ?? "");
    evaluate(text, m[1]); // throws a MachineFileError listing every problem; nothing is saved if it is wrong
    writeFileSync(machineFile(m[1]), text);
    let gen = currentGeneration(m[1]), changed = false;
    if (b.apply) { const r = switchMachine(m[1]); gen = r.gen.n; changed = r.changed; }
    hub.publishMachines(true);
    return json({ ok: true, gen, changed, running: hub.lives.has(m[1]), note: hub.lives.has(m[1]) && changed ? "Restart the machine to run the new generation." : undefined });
  }],
  ["POST", /^\/api\/machines\/([^/]+)\/rollback$/, async (hub, req, m) => {
    if (!nameOk(m[1])) return fail(404, "no such machine");
    const g = rollback(m[1], Number((await body(req)).gen));
    hub.publishMachines(true);
    return json({ ok: true, gen: g.n });
  }],

  ["POST", /^\/api\/machines\/([^/]+)\/start$/, async (hub, _req, m) => {
    if (!nameOk(m[1])) return fail(404, "no such machine");
    const st = await startMachine(m[1]);
    hub.syncLives();
    hub.publishMachines(true);
    return json({ ok: true, state: st });
  }],
  ["POST", /^\/api\/machines\/([^/]+)\/stop$/, async (hub, _req, m) => {
    if (!nameOk(m[1])) return fail(404, "no such machine");
    const live = hub.lives.get(m[1]);
    if (live) hub.stopDriving(live);
    await stopMachine(m[1]);
    hub.syncLives();
    hub.publishMachines(true);
    return json({ ok: true });
  }],
  ["POST", /^\/api\/machines\/([^/]+)\/restart$/, async (hub, _req, m) => {
    if (!nameOk(m[1])) return fail(404, "no such machine");
    await stopMachine(m[1]);
    hub.syncLives();
    const st = await startMachine(m[1]);
    hub.syncLives();
    hub.publishMachines(true);
    return json({ ok: true, state: st });
  }],
  ["POST", /^\/api\/machines\/([^/]+)\/reset$/, async (hub, req, m) => {
    const st = readState(m[1]);
    if (!st) return fail(409, "that machine is not running");
    const hard = !!(await body(req)).hard;
    await monitorReset(st.binaryPort, hard);
    hub.lives.get(m[1])?.say("machine", hard ? "Power cycle." : "Reset button pressed.", "monitor");
    return json({ ok: true });
  }],
];

export async function createHub(): Promise<Hub> {
  const hub = new Hub();
  const { apiRoutes } = await import("./api");
  hub.routes.push(...coreRoutes, ...apiRoutes);
  return hub;
}
