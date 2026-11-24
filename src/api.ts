// The REST routes behind the shell's panels: drives, media, freeze slots, running a disk, the shelf, the
// Internet Archive, captures, devices, the memory snapshot, and which agent is set up.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { chooseAgent, detectAgents, detectLocal } from "./agents";
import { devices } from "./devices";
import { diskHistory, readState } from "./engine";
import { writeMemory } from "./monitor";
import type { Hub, Route } from "./server";
import { json } from "./server";
import { driveInfo, ejectDisk, exportDisk, flushDisk, freeze, insertDisk, restoreFromHistory, setMedia, thaw, autostartPrg, playSid, stopSid } from "./media";
import { machineNames } from "./machinefile";
import { paths } from "./paths";
import { addToShelf, archiveFetch, archiveFiles, archiveSearch, kindOf, listShelf, removeFromShelf } from "./shelf";
import type { Live } from "./live";
import { Stopped } from "./machine";
import { indexLibrary, libraryRoot, loadCatalog, searchLibrary, stageOnShelf, type Catalog } from "./library";

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

let indexing: Promise<Catalog> | null = null;

/** Start one shelf item on a running machine, the way each kind is started. Used by Run and by the library. */
async function startShelfItem(live: Live, machineName: string, shelfName: string): Promise<{ ok: true; how: string } | { ok: false; error: string }> {
  const kind = kindOf(shelfName);
  if (kind === "disk") { void loadAndRun(live, shelfName); return { ok: true, how: "typed LOAD" }; }
  if (kind === "sid") return { ok: false, error: "use the SID player for tunes (POST /sid)" };
  if (kind === "prg" || kind === "tape" || kind === "cart") {
    await autostartPrg(machineName, shelfName); // VICE's own autostart: the file is attached and started the way the engine does it
    if (kind === "prg") live.say("host", `VICE autostart loaded and started “${shelfName}” (there is no disk to LOAD it from).`, "monitor");
    return { ok: true, how: "autostart" };
  }
  return { ok: false, error: `${shelfName} is not something to run` };
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
  // ----- writing memory (the sprite editor): RAM and the VIC-II's own registers, nothing else -----
  ["POST", new RegExp(`^${M}/memory$`), async (hub, req, m) => {
    const live = hub.lives.get(m[1]);
    const st = readState(m[1]);
    if (!live || !st) return err(409, "switch the machine on first");
    const b = await body(req);
    const addr = Number(b.addr), bytes = b.bytes;
    if (!Number.isInteger(addr) || !Array.isArray(bytes) || !bytes.length || bytes.length > 4096 || !bytes.every((x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 255)) return err(400, "addr and bytes (1 to 4096 numbers, 0 to 255) are needed");
    const end = addr + bytes.length - 1;
    const ram = addr >= 0x0002 && end <= 0xcfff, vic = addr >= 0xd000 && end <= 0xd02e;
    if (!ram && !vic) return err(400, "only RAM ($0002 to $CFFF) and the VIC-II registers ($D000 to $D02E) can be written this way");
    await writeMemory(st.binaryPort, addr, Uint8Array.from(bytes));
    if (b.say) live.say("host", String(b.say).slice(0, 160), "monitor");
    return json({ ok: true, wrote: bytes.length, addr });
  }],

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
    const r = await startShelfItem(live, m[1], String((await body(req)).shelf));
    return r.ok ? json({ ok: true, how: r.how }) : err(400, r.error);
  }],

  // ----- the library: browse a catalog of your own folder, start a title from it -----
  ["GET", /^\/api\/library$/, () => {
    const root = libraryRoot(), cat = loadCatalog();
    return json({ ok: true, root, exists: existsSync(root), indexed: !!cat, count: cat?.count ?? 0, indexedAt: cat?.indexedAt, sets: cat?.sets ?? {}, kinds: cat?.kinds ?? {}, catalogRoot: cat?.root, indexing: indexing !== null });
  }],
  ["GET", /^\/api\/library\/search$/, (_h, _r, _m, url) => {
    const cat = loadCatalog();
    if (!cat) return err(409, "the library has not been indexed yet");
    const q = url.searchParams;
    return json({ ok: true, ...searchLibrary(cat, q.get("q") ?? "", { kind: q.get("kind") || undefined, set: q.get("set") || undefined, limit: Number(q.get("limit")) || 50 }) });
  }],
  ["POST", /^\/api\/library\/index$/, async (hub) => {
    // one walk at a time: a second press joins the first
    indexing ??= indexLibrary().finally(() => { indexing = null; });
    const cat = await indexing;
    hub.broadcast({ t: "library", count: cat.count });
    return json({ ok: true, count: cat.count, sets: cat.sets, kinds: cat.kinds, ms: cat.ms, skipped: cat.skipped });
  }],
  ["POST", new RegExp(`^${M}/library/run$`), async (hub, req, m) => {
    const live = hub.lives.get(m[1]);
    if (!live) return err(409, "switch the machine on first");
    const id = String((await body(req)).id ?? "");
    const item = loadCatalog()?.items.find((i) => i.id === id);
    if (!item) return err(404, "that title is not in the catalog (index the library again?)");
    const shelf = await stageOnShelf(item).catch((e) => e as Error);
    if (shelf instanceof Error) return err(500, shelf.message);
    if (item.kind === "sid") return json({ ok: true, shelf, how: "sid", title: item.name }); // the caller plays it through POST /sid, which asks before it resets a program
    const r = await startShelfItem(live, m[1], shelf);
    if (!r.ok) return err(400, r.error);
    live.say("host", `Library title “${item.name}” (${item.set}): copied to your shelf as ${shelf} and started (${r.how}).`, "monitor");
    return json({ ok: true, shelf, how: r.how, title: item.name });
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
