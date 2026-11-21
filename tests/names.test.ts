// Machine names are file names, and run/NAME.json is the machine's state file. The shell keeps its own
// run/server.json, so a machine may not be called "server": Stop on it used to kill the shell itself.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NIX64_HOME ??= mkdtempSync(join(tmpdir(), "nix64-names-"));
const { validName, paths, ensureDirs } = await import("../src/paths");
const { readState, stopMachine } = await import("../src/engine");
const { createMachine } = await import("../src/machinefile");

test("the shell's own file name is not a usable machine name", () => {
  expect(validName("server")).toBe(false);
  expect(validName("server2")).toBe(true);
  expect(validName("my-c64")).toBe(true);
  expect(() => createMachine("server", "x", "c64c-pal")).toThrow();
});

test("a machine state lookup never reads the shell's server.json, and Stop never signals the shell", async () => {
  ensureDirs();
  // a state file that names a live pid (this very test process) and looks like a running engine
  writeFileSync(join(paths.run, "server.json"), JSON.stringify({ pid: process.pid, port: 1, token: "x", started: "now" }));
  expect(readState("server")).toBeNull();
  await stopMachine("server"); // must return at once and leave this process alone
  expect(process.kill(process.pid, 0)).toBe(true);
  rmSync(join(paths.run, "server.json"), { force: true }); // bun shares one paths module across test files: leave nothing behind
});
