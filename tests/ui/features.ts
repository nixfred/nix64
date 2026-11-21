// Features that need a real browser: Shot, Rec, the sprite viewer reading a real sprite, the charset viewer,
// and the cheat finder narrowing down a real RAM byte. Run against a real engine:
//   NIX64_X64SC=<x64sc> NIX64_VICE_DATA=<dir> bun tests/ui/features.ts <out dir>
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "./cdp";

const out = process.argv[2] ?? "/tmp/nix64-features";
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "nix64-feat-"));
process.env.NIX64_HOME = home;
process.env.NIX64_NO_SYSTEMD = "1";
process.env.NIX64_UI = join(import.meta.dir, "../../ui");
const { createHub } = await import("../../src/server");
const { createMachine } = await import("../../src/machinefile");
const { startMachine, stopMachine } = await import("../../src/engine");
const { ensureDirs, paths } = await import("../../src/paths");

ensureDirs();
const hub = await createHub();
const server = hub.start(0);
createMachine("f", undefined, "c64c-pal");
await startMachine("f");
hub.syncLives();
const live = hub.lives.get("f")!;
await live.machine.waitForText("READY.", 25000);
const b = await Browser.launch();
const page = await b.page();
let fails = 0;
const check = (ok: boolean, what: string, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? "  " + detail : ""}`); if (!ok) fails++; };
try {
  await page.viewport(1600, 1000);
  await page.goto(`http://127.0.0.1:${server.port}/?t=${hub.token}`);
  await page.waitFor(`window.__S && __S.connected && __S.current === "f"`, 15000);
  await page.eval(`document.getElementById('modal').hidden = true`);
  await Bun.sleep(1500);

  // a real sprite, made by the machine itself: a 24x21 block with a hole, in yellow, at 100,100
  for (const line of ["10 FOR I=0 TO 62:POKE 832+I,255:NEXT", "20 FOR I=21 TO 41:POKE 832+I,129:NEXT", "30 POKE 2040,13:POKE 53269,1:POKE 53248,100:POKE 53249,100:POKE 53287,7", "RUN"]) await live.machine.type(line + "\n");
  await live.machine.waitForText("READY.", 8000);
  await Bun.sleep(600);
  await page.eval(`document.querySelector('[data-tab=sprites]').click()`);
  await Bun.sleep(900);
  const sp = await page.eval<any>(`(() => { const c = document.querySelector('#sp0 canvas'); const d = c.getContext('2d').getImageData(0, 0, 24, 21).data; let lit = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) lit++; return { lit, label: document.getElementById('spm0').textContent, on: !document.getElementById('sp0').classList.contains('off') }; })()`);
  check(sp.on && sp.lit > 300 && sp.lit < 504, "sprite viewer decodes the sprite the C64 made", `lit pixels ${sp.lit}/504, label "${sp.label}"`);
  check(/100,100/.test(sp.label), "sprite position read from the VIC registers");
  await page.shot(join(out, "sprites.png"));

  // charset viewer: the ROM set is in use, and it says so
  await page.eval(`document.querySelector('[data-tab=charset]').click()`);
  await Bun.sleep(900);
  const cs = await page.eval<string>(`document.getElementById('csinfo').textContent`);
  check(/ROM character set/.test(cs), "charset viewer says the ROM set is in use", cs.slice(0, 60));

  // cheat finder: find the byte a program holds
  await live.machine.type("POKE 50000,7\n");
  await page.eval(`document.querySelector('[data-tab=cheats]').click()`);
  await Bun.sleep(400);
  await page.eval(`document.querySelector('[data-act=cf-new]').click()`);
  await Bun.sleep(900);
  await live.machine.type("POKE 50000,9\n");
  await Bun.sleep(600);
  await page.eval(`document.getElementById('cfv').value = '9'; document.querySelector('[data-act=cf-eq]').click()`);
  await Bun.sleep(900);
  const cf = await page.eval<string>(`document.getElementById('cflist').innerText`);
  const n = await page.eval<string>(`document.getElementById('cfn').textContent`);
  check(/50000/.test(cf) || /\$C350/i.test(cf), "cheat finder narrows to the byte at 50000", n);
  await page.shot(join(out, "cheats.png"));

  // Shot: a PNG lands in the captures folder
  const before = existsSync(paths.captures) ? readdirSync(paths.captures).length : 0;
  await page.eval(`document.querySelector('[data-act=shot]').click()`);
  await Bun.sleep(1500);
  const pngs = readdirSync(paths.captures).filter((f) => f.endsWith(".png"));
  check(pngs.length > 0, "Shot saves a PNG", pngs[0] ? `${pngs[0]}, ${statSync(join(paths.captures, pngs[0])).size} bytes` : "");

  // Rec: a WebM lands there
  await page.eval(`document.querySelector('[data-act=record]').click()`);
  await Bun.sleep(3500);
  await page.eval(`document.querySelector('[data-act=record]').click()`);
  await Bun.sleep(2500);
  const webm = readdirSync(paths.captures).filter((f) => f.endsWith(".webm"));
  check(webm.length > 0 && statSync(join(paths.captures, webm[0])).size > 2000, "Rec saves a video", webm[0] ? `${webm[0]}, ${statSync(join(paths.captures, webm[0])).size} bytes` : "");
  console.log("page errors:", page.errors.slice(0, 4));
} finally {
  b.close();
  await stopMachine("f").catch(() => {});
  hub.stop();
  rmSync(home, { recursive: true, force: true });
}
process.exit(fails ? 1 : 0);
