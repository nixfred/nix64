// Drive the real shell in a real Chromium against real engines, and photograph every screen.
//   NIX64_X64SC=<x64sc> NIX64_VICE_DATA=<dir> bun tests/ui/shots.ts <out dir> [width height]
// It also checks Law 17 at each size: the page never scrolls, and nothing hangs off the bottom or right edge.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "./cdp";

const out = process.argv[2] ?? "/tmp/nix64-shots";
const W = Number(process.argv[3] ?? 1600), H = Number(process.argv[4] ?? 1000);
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "nix64-ui-"));
process.env.NIX64_HOME = home;
process.env.NIX64_NO_SYSTEMD = "1";
process.env.NIX64_UI = join(import.meta.dir, "../../ui");

const { createHub } = await import("../../src/server");
const { attachAgent } = await import("../../src/agent");
const { createMachine } = await import("../../src/machinefile");
const { startMachine, stopMachine } = await import("../../src/engine");
const { addToShelf } = await import("../../src/shelf");
const { createD64 } = await import("../../src/d64");
const { ensureDirs } = await import("../../src/paths");

ensureDirs();
const hub = await createHub();
attachAgent(hub);
const server = hub.start(0);
const base = `http://127.0.0.1:${server.port}`;
for (const [n, p] of [["breadbox", "c64c-pal"], ["ntsc-usa", "c64c-ntsc"], ["spare", "breadbin-pal"]] as const) createMachine(n, undefined, p);
addToShelf("games.d64", createD64("GAMES", "01"));
addToShelf("utils.d64", createD64("UTILS", "02"));
await startMachine("breadbox"); await startMachine("ntsc-usa");
hub.syncLives(); hub.publishMachines(true);
for (const n of ["breadbox", "ntsc-usa"]) await hub.lives.get(n)!.machine.waitForText("READY.", 25000);

const b = await Browser.launch();
const page = await b.page();
const shots: string[] = [];
const snap = async (name: string) => { const f = join(out, `${W}x${H}-${name}.png`); await page.shot(f); shots.push(f); };
const law17 = async (label: string) => {
  const r = await page.eval<any>(`(() => { const d = document.documentElement; const bad = []; for (const e of document.querySelectorAll('#app *')) { const r = e.getBoundingClientRect(); if (r.width && r.height && (r.bottom > innerHeight + 1 || r.right > innerWidth + 1) && getComputedStyle(e).position !== 'fixed' && !e.closest('.scroll,#shelf-list,#hexv,.credits')) bad.push(e.tagName + '.' + e.className + '#' + e.id + ' ' + Math.round(r.right) + 'x' + Math.round(r.bottom)); } return { sh: d.scrollHeight, ih: innerHeight, sw: d.scrollWidth, iw: innerWidth, bad: bad.slice(0, 6) }; })()`);
  const ok = r.sh <= r.ih && r.sw <= r.iw && r.bad.length === 0;
  console.log(`${ok ? "ok  " : "FAIL"} law17 ${label}: page ${r.sw}x${r.sh} in ${r.iw}x${r.ih}${r.bad.length ? " overflow: " + r.bad.join(" | ") : ""}`);
};

try {
  await page.viewport(W, H);
  await page.goto(`${base}/?t=${hub.token}`);
  console.log("loaded:", await page.waitFor(`window.__S && __S.connected && __S.machines.length === 3`, 15000));
  await page.eval(`document.getElementById('modal').hidden = true`);
  await page.waitFor(`document.querySelector('#screen') && __S.current`, 10000);
  await Bun.sleep(1200);
  await page.eval(`window.__tube && document.title`);
  await snap("01-machine");
  await law17("machine view");

  // type on the real screen with real key events
  await page.click("#screen");
  await page.type('PRINT "HELLO FROM NIX64"\n');
  await page.type("10 FOR I=1 TO 5\n");
  await page.type("20 PRINT I*I\n");
  await page.type("30 NEXT\n");
  await page.type("RUN\n");
  await Bun.sleep(900);
  await snap("02-typed");

  await page.eval(`document.querySelector('[data-act=hub]').click()`); await Bun.sleep(900);
  await snap("03-hub"); await law17("hub");
  await page.eval(`document.querySelector('[data-act=hub]').click()`); await Bun.sleep(300);

  for (const [act, file, wait] of [["settings", "04-settings", 300], ["edit-machine", "05-editor", 500], ["shelf-open", "06-library", 500], ["devices", "07-devices", 500]] as const) {
    await page.eval(`document.querySelector('[data-act=${act}]').click()`);
    await Bun.sleep(wait);
    await snap(file); await law17(act);
    await page.eval(`document.querySelector('#modal [data-act=close]')?.click()`); await Bun.sleep(150);
  }
  for (const tab of ["memory", "sprites", "cheats"]) {
    await page.eval(`document.querySelector('[data-tab=${tab}]').click()`); await Bun.sleep(700);
    await snap(`08-dock-${tab}`);
  }
  await page.eval(`document.querySelector('[data-tab=keys]').click()`);
  await page.eval(`document.querySelector('[data-act=power-off]')?.click()`);
  console.log("console:", page.console.slice(-5), "errors:", page.errors.slice(0, 5));
} finally {
  console.log("browser console:", page.console.slice(-12), "\npage errors:", page.errors.slice(0, 8));
  b.close();
  for (const n of ["breadbox", "ntsc-usa", "spare"]) await stopMachine(n).catch(() => {});
  hub.stop();
  rmSync(home, { recursive: true, force: true });
}
console.log(shots.join("\n"));
process.exit(0);
