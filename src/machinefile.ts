// A machine is ONE declarative file (TOML) that says what the box is. Nix64 evaluates it, pins every
// disk, tape and cartridge it names by SHA-256 in a content-addressed store, and records each
// change as a numbered generation you can roll back to. Same idea as NixOS, native to Nix64 (no Nix
// needed). The file is the truth: two machines with the same file are the same machine.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { generationsDir, machineDir, machineFile, paths, storeFile, validName } from "./paths";

export const MODELS = ["c64", "c64c", "c64old", "c64gs"] as const;
export const REGIONS = ["pal", "ntsc"] as const;
export const SID_MODELS = ["6581", "8580", "8580d"] as const;
export const DRIVE_TYPES = ["1541", "1541-II", "1570", "1571", "1581"] as const;
export const DRIVE_MODES = ["none", "image", "folder", "real"] as const;
export const BORDERS = ["normal", "full", "none"] as const;
export const SLOTS = ["8", "9", "10", "11"] as const;

export type Pinned = { name: string; sha256: string };
export type DriveDef = { type: (typeof DRIVE_TYPES)[number]; mode: (typeof DRIVE_MODES)[number]; image?: Pinned; folder?: string; true_drive: boolean };
export type MachineDef = {
  name: string;
  description: string;
  model: (typeof MODELS)[number];
  region: (typeof REGIONS)[number];
  sid: { model: (typeof SID_MODELS)[number] };
  drives: Record<(typeof SLOTS)[number], DriveDef>;
  tape: { image?: Pinned };
  cartridge: { image?: Pinned };
  devices: {
    reu: { enabled: boolean; size: number };
    wic64: boolean;
    modem: { enabled: boolean; host: string; port: number };
    ethernet: { enabled: boolean };
  };
  display: { borders: (typeof BORDERS)[number]; crt: boolean };
  sound: { enabled: boolean; volume: number; drive_sounds: boolean };
  engine: { extra_args: string[] };
};

export class MachineFileError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
  }
}

/** The file a new machine starts from. Comments are the documentation: this is what people read. */
export const TEMPLATE = (name: string, description = "A stock Commodore 64C, PAL, with a 1541-II.") => `# ${name}: one Nix64 machine, described completely in this file.
# Change it, then press Apply in the shell (or run: nix64 switch ${name}). Every change is a numbered
# generation, and you can roll back to any earlier one.

name = "${name}"
description = ${JSON.stringify(description)}

model  = "c64c"      # c64 (breadbin), c64c (the 1987 case), c64old (early board), c64gs
region = "pal"       # pal (50 Hz, Europe) or ntsc (60 Hz, USA)

[sid]
model = "6581"       # 6581 (the classic, warmer) or 8580 (clean) or 8580d (8580 with digi boost)

[drive.8]
type = "1541-II"     # 1541, 1541-II, 1570, 1571, 1581
mode = "image"       # image (a disk file), folder (a host folder), real (a real drive on USB), none
# image = "shelf:my-disk.d64"   # a file in your shelf; Nix64 pins it by SHA-256
true_drive = true    # emulate the drive's own 6502 (slower, authentic: fastloaders work)

[drive.9]
mode = "none"

[tape]
# image = "shelf:game.tap"

[cartridge]
# image = "shelf:cart.crt"

[devices]
wic64 = false        # WiC64 WiFi userport device (internet for the C64), experimental
[devices.reu]
enabled = false      # RAM expansion unit
size = 512           # KiB
[devices.modem]
enabled = false      # RS232 modem to TCP: dial a BBS from a terminal program
host = "127.0.0.1"
port = 25232
[devices.ethernet]
enabled = false      # Ethernet cartridge on a real network card (needs a pcap build), experimental

[display]
borders = "normal"   # normal, full, none
crt = true           # the shell draws a CRT: scanlines, phosphor mask, glow

[sound]
enabled = true
volume = 80          # 0 to 100
drive_sounds = true  # the real 1541 head clatter

[engine]
extra_args = []      # any other VICE option, for people who know what they want
`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function pick<T extends string>(v: unknown, allowed: readonly T[], dflt: T, label: string, problems: string[]): T {
  if (v === undefined) return dflt;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  problems.push(`${label} must be one of ${allowed.join(", ")} (got ${JSON.stringify(v)})`);
  return dflt;
}
function bool(v: unknown, dflt: boolean, label: string, problems: string[]): boolean {
  if (v === undefined) return dflt;
  if (typeof v === "boolean") return v;
  problems.push(`${label} must be true or false`);
  return dflt;
}
function int(v: unknown, dflt: number, min: number, max: number, label: string, problems: string[]): number {
  if (v === undefined) return dflt;
  if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) return v;
  problems.push(`${label} must be a whole number from ${min} to ${max}`);
  return dflt;
}

export type Raw = { name: string; description: string; model: string; region: string; [k: string]: unknown };

/** Parse and check a machine file. Throws MachineFileError listing every problem at once. */
export function parseMachine(text: string, expectName?: string): { raw: Record<string, unknown>; problems: string[] } {
  let raw: Record<string, unknown>;
  try {
    raw = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new MachineFileError([`not valid TOML: ${(e as Error).message}`]);
  }
  const problems: string[] = [];
  if (typeof raw.name !== "string" || !validName(raw.name)) problems.push(`name must be lowercase letters, digits, . _ - (got ${JSON.stringify(raw.name)})`);
  else if (expectName && raw.name !== expectName) problems.push(`name "${raw.name}" does not match the file name "${expectName}"`);
  return { raw, problems };
}

/** Media named in a machine file: "shelf:NAME", an absolute path, "sha256:HEX", or { source, sha256 }. */
export function resolveMedia(ref: unknown, label: string, problems: string[], pinFirst: boolean): Pinned | undefined {
  if (ref === undefined || ref === "") return undefined;
  let source: string, want: string | undefined;
  if (typeof ref === "string") source = ref;
  else if (isObj(ref) && typeof ref.source === "string") { source = ref.source; want = typeof ref.sha256 === "string" ? ref.sha256 : undefined; }
  else { problems.push(`${label} must be a file reference`); return undefined; }

  let file: string | undefined;
  if (source.startsWith("sha256:")) {
    const sha = source.slice(7);
    if (!/^[0-9a-f]{64}$/.test(sha)) { problems.push(`${label}: ${source} is not a SHA-256`); return undefined; }
    if (!existsSync(storeFile(sha))) { problems.push(`${label}: nothing with SHA-256 ${sha.slice(0, 12)}... is in the store`); return undefined; }
    return { name: want ?? sha.slice(0, 12), sha256: sha };
  }
  if (source.startsWith("shelf:")) file = join(paths.shelf, source.slice(6));
  else file = isAbsolute(source) ? source : resolve(paths.shelf, source);
  if (!resolve(file).startsWith(resolve(paths.shelf)) && !isAbsolute(source)) { problems.push(`${label}: ${source} is outside the shelf`); return undefined; }
  if (!existsSync(file)) { problems.push(`${label}: ${file} does not exist`); return undefined; }
  const data = readFileSync(file);
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (want && want !== sha256) { problems.push(`${label}: ${basename(file)} has SHA-256 ${sha256.slice(0, 12)}... but the file pins ${want.slice(0, 12)}...`); return undefined; }
  if (pinFirst && !existsSync(storeFile(sha256))) {
    mkdirSync(join(paths.data, "store"), { recursive: true });
    writeFileSync(storeFile(sha256), data);
  }
  return { name: basename(file), sha256 };
}

/** Evaluate a machine file into a complete definition. `pin` copies referenced media into the store. */
export function evaluate(text: string, expectName?: string, pin = false): MachineDef {
  const { raw, problems } = parseMachine(text, expectName);
  const sid = isObj(raw.sid) ? raw.sid : {};
  const drive = isObj(raw.drive) ? raw.drive : {};
  const devices = isObj(raw.devices) ? raw.devices : {};
  const reu = isObj(devices.reu) ? devices.reu : {};
  const modem = isObj(devices.modem) ? devices.modem : {};
  const eth = isObj(devices.ethernet) ? devices.ethernet : {};
  const display = isObj(raw.display) ? raw.display : {};
  const sound = isObj(raw.sound) ? raw.sound : {};
  const engine = isObj(raw.engine) ? raw.engine : {};
  const tape = isObj(raw.tape) ? raw.tape : {};
  const cart = isObj(raw.cartridge) ? raw.cartridge : {};

  const drives = {} as MachineDef["drives"];
  for (const s of SLOTS) {
    const d = isObj(drive[s]) ? (drive[s] as Record<string, unknown>) : {};
    const mode = pick(d.mode, DRIVE_MODES, s === "8" ? "image" : "none", `drive.${s}.mode`, problems);
    const def: DriveDef = {
      type: pick(d.type, DRIVE_TYPES, "1541-II", `drive.${s}.type`, problems),
      mode,
      true_drive: bool(d.true_drive, true, `drive.${s}.true_drive`, problems),
    };
    if (mode === "image") def.image = resolveMedia(d.image, `drive.${s}.image`, problems, pin);
    if (mode === "folder") {
      if (typeof d.folder === "string" && d.folder) def.folder = isAbsolute(d.folder) ? d.folder : join(paths.projects, d.folder);
      else problems.push(`drive.${s}.folder is required when mode = "folder"`);
    }
    drives[s] = def;
  }

  const extra = engine.extra_args;
  if (extra !== undefined && !(Array.isArray(extra) && extra.every((x) => typeof x === "string"))) problems.push("engine.extra_args must be a list of strings");

  const def: MachineDef = {
    name: String(raw.name ?? expectName ?? ""),
    description: typeof raw.description === "string" ? raw.description : "",
    model: pick(raw.model, MODELS, "c64c", "model", problems),
    region: pick(raw.region, REGIONS, "pal", "region", problems),
    sid: { model: pick(sid.model, SID_MODELS, "6581", "sid.model", problems) },
    drives,
    tape: { image: resolveMedia(tape.image, "tape.image", problems, pin) },
    cartridge: { image: resolveMedia(cart.image, "cartridge.image", problems, pin) },
    devices: {
      reu: { enabled: bool(reu.enabled, false, "devices.reu.enabled", problems), size: int(reu.size, 512, 128, 16384, "devices.reu.size", problems) },
      wic64: bool(devices.wic64, false, "devices.wic64", problems),
      modem: {
        enabled: bool(modem.enabled, false, "devices.modem.enabled", problems),
        host: typeof modem.host === "string" ? modem.host : "127.0.0.1",
        port: int(modem.port, 25232, 1, 65535, "devices.modem.port", problems),
      },
      ethernet: { enabled: bool(eth.enabled, false, "devices.ethernet.enabled", problems) },
    },
    display: { borders: pick(display.borders, BORDERS, "normal", "display.borders", problems), crt: bool(display.crt, true, "display.crt", problems) },
    sound: {
      enabled: bool(sound.enabled, true, "sound.enabled", problems),
      volume: int(sound.volume, 80, 0, 100, "sound.volume", problems),
      drive_sounds: bool(sound.drive_sounds, true, "sound.drive_sounds", problems),
    },
    engine: { extra_args: (extra as string[] | undefined) ?? [] },
  };
  if (problems.length) throw new MachineFileError(problems);
  return def;
}

/** Stable JSON: keys sorted, so the same machine always hashes the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const hashOf = (def: MachineDef) => createHash("sha256").update(canonical(def)).digest("hex");

// ---------- generations ----------

export type Generation = { n: number; time: string; hash: string; source: string; def: MachineDef };

export function listGenerations(name: string): Generation[] {
  const dir = generationsDir(name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Generation)
    .sort((a, b) => a.n - b.n);
}

export function currentGeneration(name: string): number {
  const f = join(generationsDir(name), "current");
  return existsSync(f) ? Number(readFileSync(f, "utf8").trim()) || 0 : 0;
}

/** Evaluate the machine's file and, if it differs from the current generation, record a new one. */
export function switchMachine(name: string): { gen: Generation; changed: boolean } {
  const text = readFileSync(machineFile(name), "utf8");
  const def = evaluate(text, name, true);
  const hash = hashOf(def);
  const all = listGenerations(name);
  const cur = all.find((g) => g.n === currentGeneration(name));
  if (cur && cur.hash === hash) return { gen: cur, changed: false };
  const n = (all.at(-1)?.n ?? 0) + 1;
  const gen: Generation = { n, time: new Date().toISOString(), hash, source: text, def };
  mkdirSync(generationsDir(name), { recursive: true });
  writeFileSync(join(generationsDir(name), `${n}.json`), JSON.stringify(gen, null, 1));
  writeFileSync(join(generationsDir(name), "current"), String(n));
  return { gen, changed: true };
}

/** Put an earlier generation's file back and make it current. The newer generations stay on disk. */
export function rollback(name: string, n: number): Generation {
  const gen = listGenerations(name).find((g) => g.n === n);
  if (!gen) throw new Error(`${name} has no generation ${n}`);
  writeFileSync(machineFile(name), gen.source);
  writeFileSync(join(generationsDir(name), "current"), String(n));
  return gen;
}

export function createMachine(name: string, description?: string): void {
  if (!validName(name)) throw new MachineFileError([`"${name}" is not a usable machine name (lowercase letters, digits, . _ -)`]);
  const f = machineFile(name);
  if (existsSync(f)) throw new MachineFileError([`machine "${name}" already exists`]);
  mkdirSync(join(paths.config, "machines"), { recursive: true });
  writeFileSync(f, TEMPLATE(name, description));
  mkdirSync(machineDir(name), { recursive: true });
}

export function machineNames(): string[] {
  const d = join(paths.config, "machines");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".toml")).map((f) => f.slice(0, -5)).sort() : [];
}

// ---------- the engine command line ----------

const MODEL_ARG: Record<string, Record<string, string>> = {
  c64: { pal: "c64", ntsc: "ntsc" },
  c64c: { pal: "c64c", ntsc: "newntsc" },
  c64old: { pal: "c64old", ntsc: "oldntsc" },
  c64gs: { pal: "c64gs", ntsc: "c64gs" },
};
const SID_ARG: Record<string, string> = { "6581": "0", "8580": "1", "8580d": "2" };
const DRIVE_ARG: Record<string, string> = { "1541": "1541", "1541-II": "1542", "1570": "1570", "1571": "1571", "1581": "1581" };
const BORDER_ARG: Record<string, string> = { normal: "0", full: "1", none: "3" };

export type EngineRuntime = {
  /** shared-memory file the engine publishes to */
  shm: string;
  /** loopback port of the text monitor (attach, detach, reset) and of the binary monitor */
  monitorPort: number;
  binaryPort: number;
  /** working copies of disk images, one per drive slot */
  driveFiles: Partial<Record<(typeof SLOTS)[number], string>>;
  tapeFile?: string;
  cartFile?: string;
  configFile: string;
  /** extra place to look for the C64 ROMs (development builds that are not installed) */
  dataDir?: string;
};

/** The VICE command line for a machine. Everything the file says, nothing it does not. */
export function engineArgs(def: MachineDef, rt: EngineRuntime): string[] {
  // -default must come before anything else: it resets every resource, including the ROM search path
  const a: string[] = ["+logcolorize", "-default", "-config", rt.configFile];
  if (rt.dataDir) a.push("-directory", rt.dataDir);
  a.push("-model", MODEL_ARG[def.model][def.region]);
  a.push("-sidengine", "1", "-sidmodel", SID_ARG[def.sid.model]);
  a.push("-VICIIfilter", "0", "-VICIIborders", BORDER_ARG[def.display.borders]); // the shell draws the CRT, not the engine
  if (def.sound.enabled) a.push("-sound", "-soundvolume", String(def.sound.volume));
  else a.push("+sound");
  a.push(def.sound.drive_sounds ? "-drivesound" : "+drivesound");
  for (const s of SLOTS) {
    const d = def.drives[s], file = rt.driveFiles[s];
    if (d.mode === "none" || d.mode === "real") { a.push(`-drive${s}type`, "0"); continue; }
    a.push(`-drive${s}type`, DRIVE_ARG[d.type], d.true_drive ? `-drive${s}truedrive` : `+drive${s}truedrive`);
    if (d.mode === "image" && file) a.push(`-${s}`, file);
    if (d.mode === "folder" && d.folder) a.push(`-fs${s}`, d.folder);
  }
  if (rt.tapeFile) a.push("-1", rt.tapeFile);
  if (rt.cartFile) a.push("-cartcrt", rt.cartFile);
  if (def.devices.reu.enabled) a.push("-reu", "-reusize", String(def.devices.reu.size));
  if (def.devices.modem.enabled) a.push("-acia1", "-rsdev1ip232");
  a.push("-remotemonitor", "-remotemonitoraddress", `ip4://127.0.0.1:${rt.monitorPort}`);
  a.push("-binarymonitor", "-binarymonitoraddress", `ip4://127.0.0.1:${rt.binaryPort}`);
  a.push(...def.engine.extra_args);
  return a;
}
