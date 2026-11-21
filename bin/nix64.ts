#!/usr/bin/env bun
// nix64: the Nix64 shell and its machines.
//
//   nix64                   open the shell (starts its server if it is not running)
//   nix64 ls                machines and whether they are on
//   nix64 new NAME [--preset c64c-pal|breadbin-pal|c64c-ntsc|gs]
//   nix64 start|stop NAME   switch a machine on or off (no window needed: machines run headless)
//   nix64 switch NAME       evaluate the machine file and record a new generation if it changed
//   nix64 rollback NAME N   put generation N's file back
//   nix64 edit NAME         edit the machine file in $EDITOR
//   nix64 classic [ARGS]    the plain engine window, no shell (what Nix64 was before the shell)
//   nix64 serve             run the shell's server in the foreground
//   nix64 theme install     put the READY. Omarchy theme in ~/.config/omarchy/themes (then: omarchy theme set ready)
//   nix64 skill install     link the c64 skill into your agents' skill folders (claude, codex, pi, agents), only where they exist
//   nix64 doctor            check the engine, the browser, the agent
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { detectAgents, detectLocal } from "../src/agents";
import { findEngine, readState, runningMachines, startMachine, stopMachine } from "../src/engine";
import { createMachine, currentGeneration, listGenerations, machineNames, rollback, switchMachine, PRESETS } from "../src/machinefile";
import { ensureDirs, machineFile, paths } from "../src/paths";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const pos = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));
const die = (m: string): never => { console.error(`nix64: ${m}`); process.exit(1); };

function serverInfo(): { pid: number; port: number; token: string } | null {
  try {
    const j = JSON.parse(readFileSync(join(paths.run, "server.json"), "utf8"));
    process.kill(j.pid, 0);
    return j;
  } catch { return null; }
}

async function ensureServer(): Promise<{ port: number; token: string }> {
  let s = serverInfo();
  if (s) return s;
  ensureDirs();
  const log = Bun.file(join(paths.run, "server.log"));
  const p = Bun.spawn(["bun", join(root, "src/serve.ts")], { stdin: "ignore", stdout: log, stderr: log, env: process.env, detached: true });
  p.unref();
  for (let i = 0; i < 100; i++) { await Bun.sleep(100); s = serverInfo(); if (s) return s; }
  return die(`the server did not start. See ${join(paths.run, "server.log")}`);
}

function findBrowser(): string | null {
  const wanted = [process.env.NIX64_BROWSER, "chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave", "brave-browser", "chrome"].filter(Boolean) as string[];
  for (const b of wanted) if (Bun.spawnSync(["which", b]).exitCode === 0) return b;
  return null;
}

async function openWindow(): Promise<void> {
  const s = await ensureServer();
  const url = `http://127.0.0.1:${s.port}/?t=${s.token}`;
  const browser = findBrowser();
  if (!browser) { console.log(`No browser found. Open this address yourself:\n${url}`); return; }
  const args = [`--app=${url}`, `--user-data-dir=${join(paths.data, "browser")}`, "--class=Nix64", "--name=Nix64", "--window-size=1600,1000", "--no-first-run", "--no-default-browser-check", "--ozone-platform-hint=auto", "--autoplay-policy=no-user-gesture-required", "--disable-features=Translate"];
  Bun.spawn([browser, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
  console.log("READY.");
}

switch (cmd) {
  case undefined:
  case "open": await openWindow(); break;

  case "serve": await import("../src/serve"); break;

  case "ls": {
    ensureDirs();
    const run = new Map(runningMachines().map((s) => [s.name, s]));
    const names = machineNames();
    if (!names.length) console.log("No machines yet. Make one:  nix64 new breadbox");
    for (const n of names) console.log(`${run.has(n) ? "●" : "○"} ${n.padEnd(20)} gen ${currentGeneration(n)}${run.has(n) ? `  up since ${run.get(n)!.started.slice(11, 19)}` : ""}`);
    break;
  }
  case "new": {
    ensureDirs();
    const name = pos[0] ?? die("nix64 new NAME");
    const preset = flag("preset");
    if (preset && !PRESETS[preset]) die(`unknown preset ${preset}. Presets: ${Object.keys(PRESETS).join(", ")}`);
    createMachine(name, undefined, preset);
    switchMachine(name);
    console.log(`Made ${machineFile(name)}\nSwitch it on:  nix64 start ${name}`);
    break;
  }
  case "start": { const st = await startMachine(pos[0] ?? die("nix64 start NAME")); console.log(`${st.name} is on (engine pid ${st.pid}, generation ${st.gen})`); break; }
  case "stop": await stopMachine(pos[0] ?? die("nix64 stop NAME")); console.log("off"); break;
  case "switch": { const r = switchMachine(pos[0] ?? die("nix64 switch NAME")); console.log(r.changed ? `generation ${r.gen.n} recorded` : `no change (generation ${r.gen.n})`); if (r.changed && readState(pos[0])) console.log("the machine is running the old generation: restart it to use the new one"); break; }
  case "rollback": { const g = rollback(pos[0] ?? die("nix64 rollback NAME N"), Number(pos[1])); console.log(`machine file is generation ${g.n} again`); break; }
  case "generations": for (const g of listGenerations(pos[0] ?? die("nix64 generations NAME"))) console.log(`#${g.n}  ${g.time}  ${g.hash.slice(0, 12)}${g.n === currentGeneration(pos[0]) ? "  <- current" : ""}`); break;
  case "edit": {
    const name = pos[0] ?? die("nix64 edit NAME");
    if (!existsSync(machineFile(name))) die(`no machine ${name}`);
    const ed = process.env.EDITOR ?? "nano";
    const r = Bun.spawnSync([ed, machineFile(name)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (r.exitCode === 0) { const s = switchMachine(name); console.log(s.changed ? `generation ${s.gen.n} recorded` : "no change"); }
    break;
  }
  case "classic": {
    const e = findEngine() ?? die("no engine found");
    const run = process.env.XDG_RUNTIME_DIR ?? "/tmp";
    Bun.spawnSync(["mkdir", "-p", join(run, "nix64")]);
    const p = Bun.spawn([e, "+logcolorize", ...rest], { env: { ...process.env, NIX64_TELEMETRY: join(run, "nix64", "default.shm") }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exit(await p.exited);
  }
  case "theme": {
    if (pos[0] !== "install") die("nix64 theme install");
    const src = join(root, "theme/ready"), dest = join(process.env.HOME ?? "", ".config/omarchy/themes/ready");
    if (!existsSync(src)) die(`the theme is not in ${src}`);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    console.log(`Installed the READY. theme in ${dest}\nSwitch to it with:  omarchy theme set ready`);
    break;
  }
  case "skill": {
    if (pos[0] !== "install") die("nix64 skill install");
    const src = join(root, "skills/c64"), home = process.env.HOME ?? "";
    const there = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
    let n = 0;
    for (const dir of [".claude/skills", ".codex/skills", ".pi/agent/skills", ".agents/skills"]) {
      const base = join(home, dir);
      if (!existsSync(base)) continue; // only agents that are really there
      const link = join(base, "c64");
      if (there(link)) { console.log(`left alone (already there): ${link}`); continue; }
      symlinkSync(src, link);
      console.log(`linked ${link} -> ${src}`);
      n++;
    }
    if (!n) console.log("nothing to do: no agent skill folder was found, or the c64 skill is already linked.");
    break;
  }
  case "doctor": {
    const e = findEngine(), b = findBrowser(), a = detectAgents(), l = await detectLocal();
    const line = (ok: boolean, what: string, detail = "") => console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `  ${detail}` : ""}`);
    line(!!e, "engine", e ?? "none: install nix64-vice or set NIX64_X64SC");
    line(!!b, "browser for the window", b ?? "none: set NIX64_BROWSER, or open the printed address by hand");
    line(a.length > 0, "agent", a.map((x) => x.name).join(", ") || "none found (assist and drive are unavailable; everything else works)");
    for (const x of l) console.log(`info ${x.name}: ${x.up ? "running" : "not running"}`);
    line(true, "folders", `config ${paths.config}  data ${paths.data}  shelf ${paths.shelf}`);
    break;
  }
  default: die(`unknown command ${cmd}. See the top of ${join(root, "bin/nix64.ts")}`);
}
