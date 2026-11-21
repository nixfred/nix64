// Putting things in drives. A disk in a drive is a working copy: writes go to it, as on a real disk,
// and the previous contents are kept in a history before anything replaces them. Inserting and ejecting
// on a RUNNING machine goes through the engine's text monitor (the only door VICE has for it), which
// pauses the machine for a few milliseconds; the feed says so.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createD64, readDir, type DiskDir } from "./d64";
import { archiveDisk, diskHistory, diskPath, readState, restoreDisk } from "./engine";
import { SLOTS, evaluate, type MachineDef } from "./machinefile";
import { Machine } from "./machine";
import { attach, detach, loadSnapshot, saveSnapshot, autostart, reset, writeMemory } from "./monitor";
import { parseSid, type SidInfo } from "./psid";
import { planSid } from "./sidplayer";
import { machineDir, machineFile, paths, storeFile } from "./paths";
import { addToShelf, kindOf, shelfPath } from "./shelf";

type Slot = (typeof SLOTS)[number];
const slotOk = (s: string): Slot => { if (!(SLOTS as readonly string[]).includes(s)) throw new Error(`no drive ${s}`); return s as Slot; };

export type DriveInfo = { slot: string; type: string; mode: string; folder?: string; disk: DiskDir | null; history: number };
export type MediaInfo = { tape: { name: string } | null; cart: { name: string } | null };

const mediaFile = (name: string) => join(machineDir(name), "media.json");
const loadDef = (name: string): MachineDef => evaluate(readFileSync(machineFile(name), "utf8"), name);

export function driveInfo(name: string): { drives: DriveInfo[]; media: MediaInfo; freezes: { slot: number; time: string }[] } {
  const def = loadDef(name);
  const drives: DriveInfo[] = [];
  for (const s of SLOTS) {
    const d = def.drives[s];
    if (d.mode === "none") continue;
    const f = diskPath(name, s);
    drives.push({ slot: s, type: d.type, mode: d.mode, folder: d.folder, disk: d.mode === "image" && existsSync(f) ? readDir(readFileSync(f)) : null, history: diskHistory(name, s).length });
  }
  let media: MediaInfo = { tape: def.tape.image ? { name: def.tape.image.name } : null, cart: def.cartridge.image ? { name: def.cartridge.image.name } : null };
  if (existsSync(mediaFile(name))) media = { ...media, ...JSON.parse(readFileSync(mediaFile(name), "utf8")) };
  return { drives, media, freezes: freezeList(name) };
}

/** Put a disk from the shelf (or a blank one) into a drive. On a running machine the engine is told. */
export async function insertDisk(name: string, slotStr: string, src: { shelf?: string; blank?: string }): Promise<string> {
  const slot = slotOk(slotStr), def = loadDef(name);
  if (def.drives[slot].mode !== "image") throw new Error(`drive ${slot} is not set up for disk images (its mode is ${def.drives[slot].mode})`);
  const st = readState(name), work = diskPath(name, slot);
  let data: Buffer, label: string;
  if (src.blank !== undefined) { label = (src.blank || "BLANK").toUpperCase().slice(0, 16); data = createD64(label, "64"); }
  else {
    const p = shelfPath(src.shelf ?? ""); label = src.shelf!;
    if (kindOf(label) !== "disk") throw new Error(`${label} is not a disk image (tapes and cartridges have their own slots)`);
    data = readFileSync(p);
  }
  if (st) await detach(st.monitorPort, Number(slot));
  mkdirSync(join(machineDir(name), "disks"), { recursive: true });
  archiveDisk(name, slot);
  writeFileSync(work, data);
  if (st) await attach(st.monitorPort, work, Number(slot));
  return label;
}

export async function ejectDisk(name: string, slotStr: string): Promise<void> {
  const slot = slotOk(slotStr), st = readState(name);
  if (st) await detach(st.monitorPort, Number(slot));
  archiveDisk(name, slot);
  rmSync(diskPath(name, slot), { force: true });
}

export async function restoreFromHistory(name: string, slotStr: string, file: string): Promise<void> {
  const slot = slotOk(slotStr), st = readState(name);
  if (st) await detach(st.monitorPort, Number(slot));
  restoreDisk(name, slot, file);
  if (st) await attach(st.monitorPort, diskPath(name, slot), Number(slot));
}

/**
 * The 1541 emulation keeps its tracks in memory and writes them back to the image when the disk is taken
 * out. So before the image file is read for anything that matters (a copy, the directory) a running machine's
 * disk is re-seated: out and in again, which takes a few milliseconds and makes the file true.
 */
export async function flushDisk(name: string, slotStr: string): Promise<void> {
  const slot = slotOk(slotStr), st = readState(name), f = diskPath(name, slot);
  if (!st || !existsSync(f)) return;
  await detach(st.monitorPort, Number(slot));
  await attach(st.monitorPort, f, Number(slot));
}

export async function exportDisk(name: string, slotStr: string, as?: string): Promise<string> {
  const slot = slotOk(slotStr), f = diskPath(name, slot);
  if (!existsSync(f)) throw new Error(`drive ${slot} is empty`);
  await flushDisk(name, slot);
  const dir = readDir(readFileSync(f));
  const base = (as || `${dir?.name || name}-${new Date().toISOString().slice(0, 10)}`).replace(/\.d64$/i, "");
  return addToShelf(`${base}.d64`, readFileSync(f));
}

export async function setMedia(name: string, kind: "tape" | "cart", src: { shelf?: string; eject?: boolean }): Promise<void> {
  const st = readState(name), dev = kind === "tape" ? 1 : 32;
  const cur = existsSync(mediaFile(name)) ? JSON.parse(readFileSync(mediaFile(name), "utf8")) : {};
  if (src.eject) {
    if (st) await detach(st.monitorPort, dev);
    delete cur[kind];
  } else {
    const p = shelfPath(src.shelf ?? "");
    const want = kind === "tape" ? ["tape"] : ["cart"];
    if (!want.includes(kindOf(src.shelf!))) throw new Error(`${src.shelf} is not a ${kind === "tape" ? "tape" : "cartridge"} image`);
    const work = join(machineDir(name), kind === "tape" ? "tape.tap" : `cart-${Date.now()}.crt`);
    copyFileSync(p, work);
    if (st) await attach(st.monitorPort, work, dev);
    cur[kind] = { name: src.shelf };
  }
  mkdirSync(machineDir(name), { recursive: true });
  writeFileSync(mediaFile(name), JSON.stringify(cur));
}

// ---------- freeze slots: the whole machine, saved as a VICE snapshot ----------

const freezeDir = (name: string) => join(machineDir(name), "freeze");
export function freezeList(name: string): { slot: number; time: string }[] {
  const d = freezeDir(name);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^slot[1-4]\.vsf$/.test(f)).map((f) => ({ slot: Number(f[4]), time: statSync(join(d, f)).mtime.toISOString() }));
}
export async function freeze(name: string, slot: number): Promise<void> {
  if (!(slot >= 1 && slot <= 4)) throw new Error("freeze slots are 1 to 4");
  const st = readState(name);
  if (!st) throw new Error("switch the machine on to freeze it");
  mkdirSync(freezeDir(name), { recursive: true });
  const f = join(freezeDir(name), `slot${slot}.vsf`);
  if (existsSync(f)) copyFileSync(f, join(freezeDir(name), `slot${slot}.prev.vsf`)); // one level of undo
  await saveSnapshot(st.binaryPort, f, true);
}
export async function thaw(name: string, slot: number): Promise<void> {
  const st = readState(name);
  if (!st) throw new Error("switch the machine on first");
  const f = join(freezeDir(name), `slot${slot}.vsf`);
  if (!existsSync(f)) throw new Error(`freeze slot ${slot} is empty`);
  await loadSnapshot(st.binaryPort, f);
}

/** VICE's own autostart, for a .prg (there is no disk to LOAD it from): a host-assisted step, labelled. */
export async function autostartPrg(name: string, shelfName: string): Promise<void> {
  const st = readState(name);
  if (!st) throw new Error("switch the machine on first");
  await autostart(st.binaryPort, shelfPath(shelfName), true);
}

/** What a started tune is, for the shell: the file's own header plus which song is playing. */
export type NowPlaying = SidInfo & { shelf: string; song: number; started: number; warnings: string[] };

/**
 * Play a tune from the shelf on this machine's own SID chip: the machine is reset (the tune takes the machine, as on a real C64,
 * so whatever BASIC program was in memory is gone), the tune and a small driver of Nix64's own are written into RAM, and the
 * driver calls the tune's init once and its play routine every frame. Every note is the tune's own 6502 code writing to the chip.
 */
export async function playSid(name: string, shelfName: string, song?: number): Promise<NowPlaying> {
  const st = readState(name);
  if (!st) throw new Error("switch the machine on first");
  if (kindOf(shelfName) !== "sid") throw new Error(`${shelfName} is not a SID tune`);
  const data = readFileSync(shelfPath(shelfName));
  const info = parseSid(data);
  const n = song ?? info.startSong;
  if (!Number.isInteger(n) || n < 1 || n > info.songs) throw new Error(`${shelfName} has songs 1 to ${info.songs}, not ${n}`);
  const def = loadDef(name);
  const plan = planSid(data, n, def.region === "pal" ? "pal" : "ntsc"); // refuses what it cannot play, before the machine is touched
  const warnings: string[] = [...plan.warnings];
  if (info.clock === "pal" && def.region !== "pal") warnings.push("The tune was written for PAL and this machine is NTSC, so it will play too fast.");
  if (info.clock === "ntsc" && def.region === "pal") warnings.push("The tune was written for NTSC and this machine is PAL, so it will play too slow.");
  if ((info.model === "6581" || info.model === "8580") && info.model !== def.sid.model) warnings.push(`The tune was written for the ${info.model} and this machine has a ${def.sid.model}: it will sound different (set sid.model in the machine file).`);
  await reset(st.binaryPort, false);
  const m = Machine.open(st.shm);
  try {
    if (!(await m.waitForText("READY.", 15000))) throw new Error("the machine did not come back to READY. after the reset");
    await silence(st.binaryPort);
    for (const w of plan.writes) await writeMemory(st.binaryPort, w.addr, w.data);
  } finally {
    m.close();
  }
  return { ...info, shelf: shelfName, song: n, started: Date.now(), warnings };
}

/** Every SID register to zero: no voice gated, volume off. (A reset does not clear a tune's last notes off the chip.) */
async function silence(port: number): Promise<void> {
  await writeMemory(port, 0xd400, Buffer.alloc(25));
}

/** Stop the tune: a soft reset puts the KERNAL's own interrupt back, and the chip is told to be quiet. */
export async function stopSid(name: string): Promise<void> {
  const st = readState(name);
  if (!st) throw new Error("switch the machine on first");
  await reset(st.binaryPort, false);
  const m = Machine.open(st.shm);
  try { await m.waitForText("READY.", 15000); } finally { m.close(); }
  await silence(st.binaryPort);
}

export { paths, storeFile };
