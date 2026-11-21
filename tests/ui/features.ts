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
  // a program that moves the screen to $0800 (VIC register $D018) keeps the sprite pointers at $0BF8, not at $07F8
  await live.machine.type("POKE 2040,14:POKE 3064,13:POKE 53272,(PEEK(53272) AND 15) OR 32\n");
  await Bun.sleep(1200);
  const sp2 = await page.eval<any>(`(() => { const c = document.querySelector('#sp0 canvas'); const d = c.getContext('2d').getImageData(0, 0, 24, 21).data; let lit = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) lit++; return lit; })()`);
  check(sp2 > 300, "sprite pointers follow $D018 when a program moves the screen", `lit pixels ${sp2}/504`);
  await live.machine.type("POKE 53272,21\n");

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
  // the shelf search box keeps the order you type in (it used to rebuild the panel and drop the caret to the start)
  await page.eval(`document.getElementById('shelf-filter').focus()`);
  for (const ch of "abc") await page.send("Input.insertText", { text: ch });
  const filt = await page.eval<string>(`document.getElementById('shelf-filter').value`);
  check(filt === "abc", "shelf search keeps typing order", `typed abc, box holds "${filt}"`);

  // Ctrl+V and Shift+Insert are left to the browser (so the paste event fires); ordinary keys are still taken by the C64
  const pv = await page.eval<any>(`(() => { const c = document.getElementById('screen'); const t = (init) => { const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); c.dispatchEvent(e); return e.defaultPrevented; }; return { ctrlV: t({ code: 'KeyV', key: 'v', ctrlKey: true }), shiftIns: t({ code: 'Insert', key: 'Insert', shiftKey: true }), plainA: t({ code: 'KeyA', key: 'a' }) }; })()`);
  check(pv.ctrlV === false && pv.shiftIns === false && pv.plainA === true, "Ctrl+V and Shift+Insert reach the browser's paste, plain keys go to the C64", JSON.stringify(pv));
  // WebGL context lost and restored: the picture comes back (it used to stay black until a reload)
  const lit = `(() => { const c = document.getElementById('screen'); const t = document.createElement('canvas'); t.width = c.width; t.height = c.height; const g = t.getContext('2d'); g.drawImage(c, 0, 0); const d = g.getImageData(0, 0, t.width, t.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++; return n; })()`;
  const litBefore = await page.eval<number>(lit);
  await page.eval(`(() => { const e = __tube.gl.getExtension('WEBGL_lose_context'); window.__lc = e; e.loseContext(); })()`);
  await Bun.sleep(400);
  await page.eval(`window.__lc.restoreContext()`);
  await Bun.sleep(1500);
  const litAfter = await page.eval<number>(lit);
  check(litBefore > 1000 && litAfter > 1000, "the CRT redraws after the graphics context is lost and restored", `lit pixels before ${litBefore}, after ${litAfter}`);
  // a shader that cannot be used: plain 2D drawing, on a canvas that is really on the page
  const fb = await page.eval<boolean>(`(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 48; document.body.appendChild(c); const t = new (window.__tube.constructor)(c); t.fallback(); const pal = new Uint8Array(48); pal[3] = 255; t.frame(new Uint8Array(16).fill(1), pal, 4, 4); const d = t.canvas.getContext('2d').getImageData(1, 1, 1, 1).data; const ok = t.canvas !== c && t.canvas.isConnected && d[0] === 255; t.canvas.remove(); return ok; })()`);
  check(fb === true, "without a shader the tube draws plain pixels on a canvas that is on the page");
  console.log("page errors:", page.errors.slice(0, 4));
} finally {
  b.close();
  await stopMachine("f").catch(() => {});
  hub.stop();
  rmSync(home, { recursive: true, force: true });
}
process.exit(fails ? 1 : 0);
