// The REST routes behind the shell's panels: drives, media, freeze slots, running a disk, the shelf, the
// Internet Archive, captures, devices, the memory snapshot, and which agent is set up.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { chooseAgent, detectAgents, detectLocal } from "./agents";
import { devices } from "./devices";
import { diskHistory, readState } from "./engine";
import type { Hub, Route } from "./server";
import { json } from "./server";
import { driveInfo, ejectDisk, exportDisk, flushDisk, freeze, insertDisk, restoreFromHistory, setMedia, thaw, autostartPrg, playSid, stopSid } from "./media";
import { machineNames } from "./machinefile";
import { paths } from "./paths";
import { addToShelf, archiveFetch, archiveFiles, archiveSearch, kindOf, listShelf, removeFromShelf } from "./shelf";
import type { Live } from "./live";
import { Stopped } from "./machine";

const body = async (req: Request) => (await req.json().catch(() => ({}))) as Record<string, any>;
const err = (status: number, error: string) => json({ ok: false, error }, status);
const known = (n: string) => machineNames().includes(n);
const M = "/api/machines/([^/]+)";

/** Load a disk the way you would: put it in drive 8, type LOAD for you, warp while it loads, then RUN. */
async function loadAndRun(live: Live, shelfName: string): Promise<void> {
  const m = live.machine;
  const token = m.flushToken();
  const stopped = () => m.flushToken() !== token;
  try {
    live.say("machine", `Disk “${shelfName}” put in drive 8.`, "drive tray");
    await insertDisk(live.name, "8", { shelf: shelfName });
    await m.waitFrames(30);
    if (stopped()) return;
    live.say("machine", 'Typed `LOAD"*",8,1`.', "keyboard");
    await m.type('LOAD"*",8,1\n');
    live.setWarp(true);
    live.say("note", "Warp is on while it loads (the stripes are the real loader). It switches off when the machine is ready again.");
    const end = Date.now() + 240000;
    let sawLoading = false, ok = false;
    while (Date.now() < end && !stopped()) {
      const rows = m.screen();
      if (rows.some((r) => r.includes("LOADING") || r.includes("SEARCHING"))) sawLoading = true;
      if (rows.some((r) => r.startsWith("?"))) { live.say("error", `The machine says: ${rows.find((r) => r.startsWith("?"))}`); break; }
      const last = rows.filter(Boolean).at(-1) ?? "";
      if (sawLoading && last.trim() === "READY.") { ok = true; break; }
      await Bun.sleep(120);
    }
    live.setWarp(false);
    if (ok && !stopped()) { live.say("machine", "Typed `RUN`.", "keyboard"); await m.type("RUN\n"); }
  } catch (e) {
    try { live.setWarp(false); } catch { /* gone */ }
    if (!(e instanceof Stopped)) live.say("error", (e as Error).message);
  }
}

export const apiRoutes: Route[] = [
  // ----- drives and media -----
  ["GET", new RegExp(`^${M}/drives$`), async (_h, _r, m, url) => {
    if (!known(m[1])) return err(404, "no such machine");
    if (url.searchParams.get("flush")) for (const s of ["8", "9", "10", "11"]) await flushDisk(m[1], s).catch(() => {}); // make the images true first (the disk dialog asks)
    return json({ ok: true, ...driveInfo(m[1]) });
  }],
  ["POST", new RegExp(`^${M}/drives/(\\d+)/insert$`), async (hub, req, m) => {
    const b = await body(req);
    const label = await insertDisk(m[1], m[2], { shelf: b.shelf, blank: b.blank });
    hub.lives.get(m[1])?.say("machine", `Disk “${label}” put in drive ${m[2]}.`, "drive tray");
    return json({ ok: true, label });
  }],
  ["POST", new RegExp(`^${M}/drives/(\\d+)/eject$`), async (hub, _req, m) => { await ejectDisk(m[1], m[2]); hub.lives.get(m[1])?.say("machine", `Disk ejected from drive ${m[2]}.`, "drive tray"); return json({ ok: true }); }],
  ["GET", new RegExp(`^${M}/drives/(\\d+)/history$`), (_h, _r, m) => json({ ok: true, history: diskHistory(m[1], m[2]) })],
  ["POST", new RegExp(`^${M}/drives/(\\d+)/restore$`), async (hub, req, m) => { await restoreFromHistory(m[1], m[2], String((await body(req)).file)); hub.lives.get(m[1])?.say("machine", `Disk in drive ${m[2]} put back to an earlier state.`, "drive tray"); return json({ ok: true }); }],
  ["POST", new RegExp(`^${M}/drives/(\\d+)/export$`), async (_h, req, m) => json({ ok: true, name: await exportDisk(m[1], m[2], (await body(req)).name) })],
  ["POST", new RegExp(`^${M}/media/(tape|cart)$`), async (hub, req, m) => {
    const b = await body(req);
    await setMedia(m[1], m[2] as "tape" | "cart", { shelf: b.shelf, eject: !!b.eject });
    hub.lives.get(m[1])?.say("machine", b.eject ? `${m[2] === "tape" ? "Tape" : "Cartridge"} removed.` : `${m[2] === "tape" ? "Tape" : "Cartridge"} “${b.shelf}” inserted.`, "monitor");
    return json({ ok: true });
  }],
  ["POST", new RegExp(`^${M}/freeze$`), async (hub, req, m) => { const slot = Number((await body(req)).slot); await freeze(m[1], slot); hub.lives.get(m[1])?.say("machine", `Whole machine frozen in slot ${slot}.`, "snapshot"); return json({ ok: true }); }],
  ["POST", new RegExp(`^${M}/thaw$`), async (hub, req, m) => { const slot = Number((await body(req)).slot); await thaw(m[1], slot); hub.lives.get(m[1])?.say("machine", `Machine restored from freeze slot ${slot}.`, "snapshot"); return json({ ok: true }); }],
  // ----- SID tunes -----
  ["GET", new RegExp(`^${M}/sid$`), (hub, _r, m) => {
    const live = hub.lives.get(m[1]);
    return json({ ok: true, playing: live?.sid ?? null });
  }],
  ["POST", new RegExp(`^${M}/sid$`), async (hub, req, m) => {
    const live = hub.lives.get(m[1]);
    if (!live) return err(409, "switch the machine on first");
    const b = await body(req);
    // A tune takes the whole machine (it is reset). Never throw away someone's program without asking.
    let program = 0;
    try { program = live.machine.programLines().length; } catch { /* cannot tell */ }
    if (program > 0 && !live.sid && b.force !== true) return json({ ok: false, needsConfirm: true, error: `There is a BASIC program in memory (${program} lines). Playing a tune resets the machine and it would be lost. Freeze the machine into a slot first, or play anyway.` }, 409);
    const np = await playSid(m[1], String(b.shelf ?? ""), b.song === undefined ? undefined : Number(b.song));
    live.queueCleared();
    live.sid = np;
    live.say("host", `Tune “${np.shelf}”, song ${np.song} of ${np.songs}: the machine was reset, the tune and Nix64's player were written into RAM, and the tune's own code now drives the SID chip every frame.`, "monitor");
    for (const w of np.warnings) live.say("note", w);
    hub.broadcast({ t: "sid", name: m[1], sid: np });
    return json({ ok: true, playing: np });
  }],
  ["POST", new RegExp(`^${M}/sid/stop$`), async (hub, _req, m) => {
    const live = hub.lives.get(m[1]);
    if (!live) return err(409, "switch the machine on first");
    if (!live.sid) return err(409, "no tune is playing on this machine");
    await stopSid(m[1]);
    live.sid = null;
    live.say("host", "Tune stopped: the machine was reset and the chip silenced.", "monitor");
    hub.broadcast({ t: "sid", name: m[1], sid: null });
    return json({ ok: true });
  }],
  ["POST", new RegExp(`^${M}/run$`), async (hub, req, m) => {
    const live = hub.lives.get(m[1]);
    if (!live) return err(409, "switch the machine on first");
    const name = String((await body(req)).shelf);
    const kind = kindOf(name);
    if (kind === "disk") { void loadAndRun(live, name); return json({ ok: true, how: "typed LOAD" }); }
    if (kind === "sid") return err(400, "use the SID player for tunes (POST /sid)");
    if (kind === "prg") {
      await autostartPrg(m[1], name);
      live.say("host", `VICE autostart loaded and started “${name}” (there is no disk to LOAD it from).`, "monitor");
      return json({ ok: true, how: "autostart" });
    }
    return err(400, `${name} is not something to run (put tapes and cartridges in their own slots)`);
  }],

  // ----- reading the machine -----
  ["GET", new RegExp(`^${M}/snapshot$`), (hub, _r, m) => {
    const live = hub.lives.get(m[1]);
    if (!live) return err(409, "that machine is off");
    const s = live.machine.snapshot();
    const out = Buffer.alloc(4 + 64 + 1024 + 65536);
    out.writeUInt32LE(s.frame, 0); s.vic.copy(out, 4); s.color.copy(out, 68); s.ram.copy(out, 1092);
    return new Response(out, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
  }],

  // ----- shelf -----
  ["GET", /^\/api\/shelf$/, () => json({ ok: true, items: listShelf() })],
  ["POST", /^\/api\/shelf\/import$/, async (_h, req) => {
    const name = decodeURIComponent(req.headers.get("x-filename") ?? "");
    return json({ ok: true, name: addToShelf(name, new Uint8Array(await req.arrayBuffer())) });
  }],
  ["DELETE", /^\/api\/shelf\/([^/]+)$/, (_h, _r, m) => { removeFromShelf(decodeURIComponent(m[1])); return json({ ok: true }); }],

  // ----- the Internet Archive: only when asked -----
  ["GET", /^\/api\/archive\/search$/, async (_h, _r, _m, url) => json({ ok: true, items: await archiveSearch(url.searchParams.get("q") ?? "") })],
  ["GET", /^\/api\/archive\/files$/, async (_h, _r, _m, url) => json({ ok: true, files: await archiveFiles(url.searchParams.get("id") ?? "") })],
  ["POST", /^\/api\/archive\/fetch$/, async (_h, req) => { const b = await body(req); const names = await archiveFetch(String(b.id), String(b.file)); return json({ ok: true, name: names.join(", "), names }); }],

  // ----- captures -----
  ["GET", /^\/api\/captures$/, () => {
    mkdirSync(paths.captures, { recursive: true });
    return json({ ok: true, items: readdirSync(paths.captures).filter((f) => /\.(png|webm|json)$/.test(f)).map((name) => ({ name, kind: extname(name).slice(1), size: statSync(join(paths.captures, name)).size, mtime: statSync(join(paths.captures, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime) });
  }],
  ["POST", /^\/api\/captures$/, async (_h, req, _m, url) => {
    const kind = url.searchParams.get("kind") === "webm" ? "webm" : "png";
    const data = new Uint8Array(await req.arrayBuffer());
    if (!data.length || data.length > 256 * 1024 * 1024) return err(400, "empty or too large");
    mkdirSync(paths.captures, { recursive: true });
    const name = `nix64-${new Date().toISOString().replace(/[:.]/g, "-")}.${kind}`;
    writeFileSync(join(paths.captures, name), data);
    return json({ ok: true, name });
  }],
  ["GET", /^\/api\/captures\/([^/]+)$/, (_h, _r, m) => {
    const name = basename(decodeURIComponent(m[1])), f = join(paths.captures, name);
    if (!existsSync(f) || !/\.(png|webm|json)$/.test(name)) return err(404, "no such capture");
    return new Response(Bun.file(f), { headers: { "content-disposition": `attachment; filename="${name}"` } });
  }],

  // ----- devices, agent -----
  ["GET", /^\/api\/devices$/, () => json({ ok: true, devices: devices() })],
  ["GET", /^\/api\/agent$/, async (hub) => {
    const detected = detectAgents();
    const current = chooseAgent(detected, hub.settings.agent.choice);
    return json({ ok: true, detected, current, local: await detectLocal(), running: Object.fromEntries([...hub.lives.keys()].map((n) => [n, hub.agentRunning?.(n) ?? false])) });
  }],
];
