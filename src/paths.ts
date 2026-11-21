// Where Nix64 keeps things. One root can be forced with NIX64_HOME (tests, portable installs);
// otherwise the XDG directories are used, so nothing is scattered through the home folder.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME ?? "/tmp";
const uid = process.getuid?.() ?? 0;
const forced = process.env.NIX64_HOME;

export const paths = {
  /** machine files, settings, agent choice: things you edit */
  config: forced ? join(forced, "config") : join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "nix64"),
  /** generations, the content-addressed media store, per-machine state: things Nix64 owns */
  data: forced ? join(forced, "data") : join(process.env.XDG_DATA_HOME ?? join(home, ".local/share"), "nix64"),
  /** shared-memory files, sockets, pid files: gone on logout */
  run: forced ? join(forced, "run") : join(process.env.XDG_RUNTIME_DIR ?? `/tmp/nix64-${uid}`, "nix64"),
  /** the folder you see and use: your shelf of disks, tapes and cartridges, and your projects */
  shelf: process.env.NIX64_SHELF ?? join(forced ?? home, "Nix64", "shelf"),
  projects: process.env.NIX64_PROJECTS ?? join(forced ?? home, "Nix64", "projects"),
  captures: process.env.NIX64_CAPTURES ?? join(forced ?? home, "Nix64", "captures"),
};

export const machineFile = (name: string) => join(paths.config, "machines", `${name}.toml`);
export const machineDir = (name: string) => join(paths.data, "machines", name);
export const generationsDir = (name: string) => join(machineDir(name), "generations");
export const storeFile = (sha256: string) => join(paths.data, "store", sha256);
export const shmPath = (name: string) => join(paths.run, `${name}.shm`);
export const statePath = (name: string) => join(paths.run, `${name}.json`);

export function ensureDirs(): void {
  for (const d of [paths.config, join(paths.config, "machines"), paths.data, join(paths.data, "store"), join(paths.data, "machines"), paths.run, paths.shelf, paths.projects, paths.captures]) {
    mkdirSync(d, { recursive: true, mode: 0o755 });
  }
}

/** Machine names are file names: keep them boring so no name can escape its folder. */
export function validName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,39}$/.test(name);
}
