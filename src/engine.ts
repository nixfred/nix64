// Running machines. A machine is a VICE engine process that Nix64 starts from a machine file and
// keeps running whether or not any window is looking at it (headless by default: the engine has no
// window, the shell draws its picture). Where systemd --user exists the engine is a transient unit
// (`nix64-m-NAME`), so it survives the shell closing, logs to the journal, and stops cleanly.
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createD64 } from "./d64";
import { SLOTS, engineArgs, evaluate, switchMachine, type EngineRuntime, type MachineDef } from "./machinefile";
import { machineDir, machineFile, paths, shmPath, statePath, storeFile, ensureDirs, validName } from "./paths";

export type RunState = {
  name: string;
  pid: number;
  unit?: string;
  shm: string;
  monitorPort: number;
  binaryPort: number;
  started: string;
  gen: number;
  hash: string;
  windowed: boolean;
  engine: string;
};

/** The engine: NIX64_X64SC, then the packaged one, then whatever x64sc is on PATH. */
export function findEngine(): string | null {
  const candidates = [process.env.NIX64_X64SC, "/usr/lib/nix64/bin/x64sc"].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  const which = Bun.spawnSync(["which", "x64sc"]);
  return which.exitCode === 0 ? which.stdout.toString().trim() : null;
}


function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

let systemd: boolean | undefined;
function hasSystemd(): boolean {
  if (process.env.NIX64_NO_SYSTEMD) return false;
  return (systemd ??= Bun.spawnSync(["systemctl", "--user", "is-system-running"]).stdout.toString().trim() !== "" && Bun.spawnSync(["systemd-run", "--version"]).exitCode === 0);
}

const unitName = (name: string) => `nix64-m-${name}`;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// ---------- disks behave like disks ----------
// A disk in a drive is a working copy. Writes go to it, as on a real disk. Before it is changed
// (and when the machine stops) the previous contents are kept in a history, so a bad save is never final.

export const diskPath = (name: string, slot: string) => join(machineDir(name), "disks", `${slot}.d64`);
const historyDir = (name: string, slot: string) => join(machineDir(name), "history", slot);

export function archiveDisk(name: string, slot: string, keep = 30): string | null {
  const f = diskPath(name, slot);
  if (!existsSync(f)) return null;
  const data = readFileSync(f);
  const h = sha(data).slice(0, 12);
  const dir = historyDir(name, slot);
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).some((x) => x.endsWith(`-${h}.d64`))) return null; // already kept
  const out = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${h}.d64`);
  writeFileSync(out, data);
  const all = readdirSync(dir).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) unlinkSync(join(dir, old));
  return out;
}

export function diskHistory(name: string, slot: string): { file: string; time: string; sha: string; size: number }[] {
  const dir = historyDir(name, slot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().reverse().map((file) => {
    const m = /^(.+)-([0-9a-f]{12})\.d64$/.exec(file);
    return { file, time: m ? m[1].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/, "T$1:$2:$3.$4Z") : file, sha: m?.[2] ?? "", size: statSync(join(dir, file)).size };
  });
}

export function restoreDisk(name: string, slot: string, file: string): void {
  if (!/^[\w.-]+\.d64$/.test(file)) throw new Error("not a history file");
  const src = join(historyDir(name, slot), file);
  if (!existsSync(src)) throw new Error("no such history entry");
  archiveDisk(name, slot);
  copyFileSync(src, diskPath(name, slot));
}

/** Make sure every drive that should have a disk has its working copy. */
function prepareMedia(name: string, def: MachineDef): EngineRuntime["driveFiles"] {
  const files: EngineRuntime["driveFiles"] = {};
  mkdirSync(join(machineDir(name), "disks"), { recursive: true });
  for (const s of SLOTS) {
    const d = def.drives[s];
    if (d.mode !== "image") continue;
    const work = diskPath(name, s), origin = `${work}.origin`;
    const want = d.image?.sha256 ?? "blank";
    const have = existsSync(origin) ? readFileSync(origin, "utf8") : undefined;
    if (!existsSync(work) || (have !== undefined && have !== want)) {
      archiveDisk(name, s);
      if (d.image) copyFileSync(storeFile(d.image.sha256), work);
      else writeFileSync(work, createD64(name.toUpperCase(), "64"));
      writeFileSync(origin, want);
    } else {
      archiveDisk(name, s); // keep the state the last session ended with
    }
    files[s] = work;
  }
  return files;
}

// ---------- start, stop, look ----------

export function readState(name: string): RunState | null {
  if (!validName(name)) return null; // a name like "server" would read the shell's own run/server.json
  try {
    return JSON.parse(readFileSync(statePath(name), "utf8")) as RunState;
  } catch {
    return null;
  }
}

function alive(st: RunState): boolean {
  if (st.unit && hasSystemd()) {
    // 0 = active, 3 = inactive or failed, 4 = no such unit. Anything else (a bus hiccup, a timeout) says nothing about the engine:
    // treating it as "dead" made runningMachines() delete the state and shared memory of a machine that was running fine.
    const c = Bun.spawnSync(["systemctl", "--user", "is-active", "--quiet", st.unit]).exitCode;
    return c !== 3 && c !== 4;
  }
  try { process.kill(st.pid, 0); return true; } catch { return false; }
}

/** Machines whose engine is actually running. Stale state files are cleaned up as they are found. */
export function runningMachines(): RunState[] {
  if (!existsSync(paths.run)) return [];
  const out: RunState[] = [];
  for (const f of readdirSync(paths.run).filter((x) => x.endsWith(".json") && x !== "server.json")) {
    const name = f.slice(0, -5);
    const st = readState(name);
    if (!st) continue;
    if (alive(st)) out.push(st);
    else { rmSync(statePath(name), { force: true }); rmSync(shmPath(name), { force: true }); }
  }
  return out;
}

const starting = new Map<string, Promise<RunState>>();
/** Start a machine. Two calls for the same machine at once (a double click on Start) share one start instead of racing two engines onto one shared-memory file. */
export function startMachine(name: string, opts: { windowed?: boolean } = {}): Promise<RunState> {
  const pending = starting.get(name);
  if (pending) return pending;
  const p = startMachineNow(name, opts).finally(() => starting.delete(name));
  starting.set(name, p);
  return p;
}

async function startMachineNow(name: string, opts: { windowed?: boolean } = {}): Promise<RunState> {
  ensureDirs();
  const engine = findEngine();
  if (!engine) throw new Error("no engine found. Install nix64-vice, or set NIX64_X64SC to an x64sc built with the Nix64 patches.");
  if (!existsSync(machineFile(name))) throw new Error(`no machine called "${name}"`);
  const running = readState(name);
  if (running && alive(running)) return running;

  const gen = switchMachine(name).gen.n;
  const def = evaluate(readFileSync(machineFile(name), "utf8"), name, true);
  const monitorPort = await freePort(), binaryPort = await freePort();
  const shm = shmPath(name);
  rmSync(shm, { force: true });

  const rt: EngineRuntime = {
    shm, monitorPort, binaryPort,
    driveFiles: prepareMedia(name, def),
    configFile: join(machineDir(name), "vicerc"),
    dataDir: process.env.NIX64_VICE_DATA,
  };
  for (const [k, ref] of [["tapeFile", def.tape.image], ["cartFile", def.cartridge.image]] as const) {
    if (!ref) continue;
    const src = storeFile(ref.sha256);
    if (k === "tapeFile") { const w = join(machineDir(name), "tape.tap"); copyFileSync(src, w); rt.tapeFile = w; }
    else { const w = join(machineDir(name), `cart-${ref.sha256.slice(0, 12)}.crt`); if (!existsSync(w)) copyFileSync(src, w); rt.cartFile = w; }
  }
  const args = engineArgs(def, rt);
  const env: Record<string, string> = { NIX64_TELEMETRY: shm };
  if (!opts.windowed) env.SDL_VIDEODRIVER = "dummy"; // no window of its own: the shell draws the picture

  let pid = 0, unit: string | undefined;
  if (hasSystemd()) {
    unit = unitName(name);
    Bun.spawnSync(["systemctl", "--user", "reset-failed", unit]);
    const r = Bun.spawnSync([
      "systemd-run", "--user", "--collect", "--quiet", `--unit=${unit}`, `--description=Nix64 machine ${name}`,
      "-p", "TimeoutStopSec=8", ...Object.entries(env).flatMap(([k, v]) => ["-E", `${k}=${v}`]), "--", engine, ...args,
    ]);
    if (r.exitCode !== 0) throw new Error(`could not start the engine: ${r.stderr.toString().trim()}`);
    pid = Number(Bun.spawnSync(["systemctl", "--user", "show", "-p", "MainPID", "--value", unit]).stdout.toString().trim()) || 0;
  } else {
    const log = openSync(join(machineDir(name), "engine.log"), "w");
    const p = Bun.spawn([engine, ...args], { env: { ...process.env, ...env }, stdin: "ignore", stdout: log, stderr: log });
    p.unref();
    closeSync(log); // the engine has its own copy of the descriptor; ours would leak one per start
    pid = p.pid;
  }

  const st: RunState = { name, pid, unit, shm, monitorPort, binaryPort, started: new Date().toISOString(), gen, hash: "", windowed: !!opts.windowed, engine };
  writeFileSync(statePath(name), JSON.stringify(st));

  // ready = the engine has published its first frames
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (!alive(st)) { rmSync(statePath(name), { force: true }); throw new Error(`the engine exited while starting.\n${engineLog(name, 20)}`); }
    try {
      const h = readFileSync(shm).subarray(0, 24);
      if (h.subarray(0, 8).toString() === "NIX64TEL" && h.readUInt32LE(20) > 3) return st;
    } catch { /* not there yet */ }
    await Bun.sleep(100);
  }
  throw new Error(`the engine did not start publishing within 30 s.\n${engineLog(name, 20)}`);
}

export function engineLog(name: string, lines = 40): string {
  const st = readState(name);
  if (st?.unit && hasSystemd()) {
    return Bun.spawnSync(["journalctl", "--user", "-u", st.unit, "-n", String(lines), "--no-pager", "-o", "cat"]).stdout.toString().trim();
  }
  const f = join(machineDir(name), "engine.log");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").slice(-lines).join("\n") : "";
}

export async function stopMachine(name: string): Promise<void> {
  const st = readState(name);
  if (!st) return;
  if (st.unit && hasSystemd()) Bun.spawnSync(["systemctl", "--user", "stop", st.unit]);
  else { try { process.kill(st.pid, "SIGTERM"); } catch { /* already gone */ } }
  for (let i = 0; i < 50 && alive(st); i++) await Bun.sleep(100);
  if (alive(st)) { try { process.kill(st.pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(statePath(name), { force: true });
  rmSync(shmPath(name), { force: true });
  for (const s of SLOTS) archiveDisk(name, s);
}
