// The dock under the screen: the on-screen keyboard (with "guide me" highlights) and the tools that read
// the machine's real memory: a hex view, a sprite viewer, the charset, the cheat finder, captures.
import { S, on, send, get, post, actions, toast, machine, esc } from "./net.js";
import { click } from "./sounds.js";
import { icon } from "./icons.js";
import { loadShelf } from "./left.js";
import { decode as decodeSprite, encode as encodeSprite, paint as paintSprite, convert as convertSprite, toData } from "./sprite.js";

const TABS = [["keys", "Keyboard"], ["memory", "Memory"], ["sprites", "Sprites"], ["charset", "Charset"], ["cheats", "Cheat finder"], ["captures", "Captures"], ["sid", "SID"], ["library", "ROM library"], ["printer", "Printer"]];

// [C64 key name, legend, shifted legend, width in units]
const ROWS = [
  [["LEFTARROW", "←", "", 1], ..."1234567890".split("").map((c) => [c, c, "!\"#$%&'()".charAt("1234567890".indexOf(c)) || "", 1]), ["+", "+", "", 1], ["-", "-", "", 1], ["POUND", "£", "", 1], ["HOME", "CLR", "HOME", 1.4], ["DEL", "INST", "DEL", 1.4]],
  [["CTRL", "CTRL", "", 1.5], ..."QWERTYUIOP".split("").map((c) => [c, c, "", 1]), ["@", "@", "", 1], ["*", "*", "", 1], ["UPARROW", "↑", "", 1], ["RESTORE", "RESTORE", "", 1.4]],
  [["STOP", "RUN", "STOP", 1.4], ["SHIFTLOCK", "SHIFT", "LOCK", 1.1], ..."ASDFGHJKL".split("").map((c) => [c, c, "", 1]), [":", ":", "[", 1], [";", ";", "]", 1], ["=", "=", "", 1], ["RETURN", "RETURN", "", 1.9]],
  [["CBM", "C=", "", 1.3], ["LSHIFT", "SHIFT", "", 1.6], ..."ZXCVBNM".split("").map((c) => [c, c, "", 1]), [",", ",", "<", 1], [".", ".", ">", 1], ["/", "/", "?", 1], ["RSHIFT", "SHIFT", "", 1.6], ["CRSR_DOWN", "CRSR", "↓↑", 1.1], ["CRSR_RIGHT", "CRSR", "→←", 1.1]],
  [["SPACE", "", "", 9]],
];
const FKEYS = [["F1", "f1", "f2"], ["F3", "f3", "f4"], ["F5", "f5", "f6"], ["F7", "f7", "f8"]];
const LATCH = new Set(["LSHIFT", "RSHIFT", "SHIFTLOCK", "CBM", "CTRL"]);
const latched = new Set();

let tab = "keys", snapTimer = 0, memAddr = 0x0400, search = { snap: null, cands: null, step: 0 };

export function init() {
  const el = document.getElementById("dock");
  el.className = "glass";
  el.innerHTML = `<div class="dock-tabs" role="tablist" id="dtabs"></div><div class="dock-body" id="dbody"></div>`;
  on("guide", () => paintGuide());
  on("machines", () => { if (tab !== "keys") render(); });
  S.tool = tab;
  render();
  document.getElementById("dock").addEventListener("pointerdown", (e) => { const k = e.target.closest(".key"); if (k) oskDown(k); });
  document.getElementById("dock").addEventListener("pointerup", (e) => { const k = e.target.closest(".key"); if (k) oskUp(k); });
  window.addEventListener("pointerup", () => { for (const k of document.querySelectorAll(".key.down")) oskUp(k); });
}

function render() {
  clearInterval(snapTimer);
  document.getElementById("dtabs").innerHTML = TABS.map(([id, label]) => `<button class="dock-tab" role="tab" data-act="dock-tab" data-tab="${id}" aria-selected="${tab === id}">${label}</button>`).join("");
  const body = document.getElementById("dbody");
  ({ keys: keysPane, memory: memoryPane, sprites: spritesPane, charset: charsetPane, cheats: cheatsPane, captures: capturesPane, sid: sidPane, library: libraryPane, printer: printerPane })[tab](body);
}
actions["dock-tab"] = (el) => { tab = el.dataset.tab; S.tool = tab; render(); };

// ---------- the keyboard ----------

function keysPane(body) {
  body.innerHTML = `<div class="osk-wrap"><div class="osk" id="osk">${ROWS.map((row, i) => `<div class="osk-row" style="${i === 1 ? "padding-left:6px" : i === 2 ? "padding-left:12px" : i === 3 ? "padding-left:0" : ""}">${row.map(([k, label, sub, w]) => `<button class="key ${LATCH.has(k) ? "latch" : ""}" data-key="${k}" style="--w:${w}" aria-label="${esc(label || k)}">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</button>`).join("")}</div>`).join("")}</div>
    <div class="fkeys">${FKEYS.map(([k, a, b]) => `<button class="key fn" data-key="${k}">${a}<small>${b}</small></button>`).join("")}</div></div>
    <div class="row sm faint" style="justify-content:center">Click keys to type · SHIFT, C=, CTRL stay down until the next key · your own keyboard works when the screen has focus</div>`;
  paintGuide();
}

function oskDown(k) {
  const name = k.dataset.key, m = S.current;
  if (!m || !machine()?.running) return;
  click();
  if (name === "RESTORE") { send({ t: "restore", name: m }); return; }
  if (LATCH.has(name)) {
    const real = name === "SHIFTLOCK" ? "LSHIFT" : name;
    if (latched.has(name)) { latched.delete(name); send({ t: "osk", name: m, key: real, down: false }); k.classList.remove("latched"); }
    else { latched.add(name); send({ t: "osk", name: m, key: real, down: true }); k.classList.add("latched"); }
    return;
  }
  k.classList.add("down");
  send({ t: "osk", name: m, key: name, down: true });
}
function oskUp(k) {
  const name = k.dataset.key, m = S.current;
  if (!k.classList.contains("down")) return;
  k.classList.remove("down");
  send({ t: "osk", name: m, key: name, down: false });
  for (const l of [...latched]) { latched.delete(l); send({ t: "osk", name: m, key: l === "SHIFTLOCK" ? "LSHIFT" : l, down: false }); document.querySelector(`.key[data-key="${l}"]`)?.classList.remove("latched"); }
}

function paintGuide() {
  const g = S.guide[S.current];
  const want = new Set(g?.keys ?? []);
  for (const k of document.querySelectorAll(".key")) k.classList.toggle("guide", want.has(k.dataset.key));
}

// ---------- reading the machine ----------

async function snapshot() {
  const r = await fetch(`/api/machines/${S.current}/snapshot`, { headers: { "x-nix64": "1" } });
  if (!r.ok) throw new Error("machine is off");
  const b = new Uint8Array(await r.arrayBuffer());
  return { frame: new DataView(b.buffer).getUint32(0, true), vic: b.subarray(4, 68), color: b.subarray(68, 1092), ram: b.subarray(1092, 1092 + 65536) };
}
const hex = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");

function live(body, draw, ms = 250) {
  const tick = async () => { try { draw(await snapshot()); } catch { body.innerHTML = `<div class="dim" style="padding:12px">Power the machine on to read its memory.</div>`; } };
  tick(); snapTimer = setInterval(tick, ms);
}

function memoryPane(body) {
  body.innerHTML = `<div class="row wrap"><label class="faint sm mono">ADDRESS $</label><input class="field mono" id="maddr" style="width:84px" value="${hex(memAddr, 4)}" maxlength="4" aria-label="Address in hex">
    ${[["Zero page", 0], ["Stack", 0x100], ["Screen", 0x400], ["BASIC", 0x801], ["Sprites", 0x2000]].map(([n, a]) => `<button class="btn sm" data-act="mem-go" data-a="${a}">${n}</button>`).join("")}
    <span class="spacer"></span><button class="btn sm" data-act="mem-prev">◂</button><button class="btn sm" data-act="mem-next">▸</button></div>
    <div class="hex grow" id="hexv" style="overflow:hidden"></div>
    <div class="row wrap sm"><span class="faint">Poke (types it on the C64 for you):</span><input class="field mono" id="pa" style="width:70px" placeholder="addr"><input class="field mono" id="pv" style="width:56px" placeholder="val"><button class="btn sm" data-act="poke">Type POKE</button><span class="faint">RAM only: the VIC, SID and CIA chips and the ROMs are not in this view.</span></div>`;
  const inp = body.querySelector("#maddr");
  inp.onchange = () => { memAddr = (parseInt(inp.value, 16) || 0) & 0xfff0; };
  live(body, (s) => {
    const rows = [];
    for (let r = 0; r < 8; r++) {
      const a = (memAddr + r * 16) & 0xffff, bytes = Array.from(s.ram.subarray(a, a + 16));
      rows.push(`<span class="a">${hex(a, 4)}</span>  ${bytes.map((b) => (b ? hex(b) : `<span class="z">00</span>`)).join(" ")}  <span class="asc">${bytes.map((b) => (b >= 32 && b < 127 ? esc(String.fromCharCode(b)) : "·")).join("")}</span>`);
    }
    const v = document.getElementById("hexv"); if (v) v.innerHTML = rows.join("\n");
  });
}
actions["mem-go"] = (el) => { memAddr = Number(el.dataset.a); document.getElementById("maddr").value = hex(memAddr, 4); };
actions["mem-prev"] = () => { memAddr = (memAddr - 128) & 0xffff; document.getElementById("maddr").value = hex(memAddr, 4); };
actions["mem-next"] = () => { memAddr = (memAddr + 128) & 0xffff; document.getElementById("maddr").value = hex(memAddr, 4); };
actions["poke"] = () => {
  const a = parseInt(document.getElementById("pa").value.replace(/^\$/, ""), 16), v = parseInt(document.getElementById("pv").value, 10) ?? NaN;
  if (!(a >= 0 && a <= 65535) || !(v >= 0 && v <= 255)) return toast("Address in hex (0 to FFFF), value 0 to 255.", "error");
  send({ t: "paste", name: S.current, text: `POKE ${a},${v}\n` }); toast(`Typed POKE ${a},${v} on the C64.`);
};

const PAL = ["#000000", "#ffffff", "#9f4e44", "#6abfc6", "#a057a3", "#5cab5e", "#50459b", "#c9d487", "#a1683c", "#6d5412", "#cb7e75", "#626262", "#898989", "#9ae29b", "#887ecb", "#adadad"];

// ---------- sprites: a live viewer, and an editor that writes into the machine's RAM ----------
let spSel = 0, spBuf = null, spAddr = -1, spMulti = false, spColor = 2, spTimer = 0, spLast = null;
const spRGB = (ci) => [parseInt(PAL[ci].slice(1, 3), 16), parseInt(PAL[ci].slice(3, 5), 16), parseInt(PAL[ci].slice(5, 7), 16)];
function spritesPane(body) {
  body.innerHTML = `<div class="row" style="gap:12px;align-items:flex-start;height:100%;min-height:0">
    <div class="sprites" id="sprites" style="flex:0 0 auto;display:grid;grid-template-columns:repeat(4,58px);gap:4px">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<div class="sprite off" id="sp${i}" data-act="sp-pick" data-i="${i}" style="cursor:pointer;padding:2px;gap:1px;min-width:0"><canvas width="24" height="21" style="width:48px;height:42px;image-rendering:pixelated"></canvas><span style="font-size:10px">#${i}</span><span class="faint trunc" id="spm${i}" style="font-size:8px;max-width:54px"></span></div>`).join("")}</div>
    <div class="col" style="gap:5px;min-width:0;flex:1">
      <div class="row wrap" style="gap:6px"><b class="sm">Sprite #<span id="sped-n"></span></b><span class="faint sm mono" id="sped-at"></span><span class="spacer"></span>
        <button class="btn sm" data-act="sp-multi" id="sped-multi" aria-pressed="false">Multicolour</button>
        <button class="btn sm" data-act="sp-clear">Clear</button><button class="btn sm" data-act="sp-invert">Invert</button><button class="btn sm" data-act="sp-reload" title="Read the sprite from the machine again">Reload</button><button class="btn sm" data-act="sp-data" title="Copy BASIC DATA lines for this sprite">Copy DATA</button></div>
      <div class="row" style="gap:10px;align-items:flex-start">
        <canvas id="sped" width="288" height="252" style="width:192px;height:168px;image-rendering:pixelated;background:#000;border-radius:6px;cursor:crosshair;touch-action:none;flex:0 0 auto" aria-label="Sprite editor: click to paint, right click to erase"></canvas>
        <div class="col" style="gap:4px"><div class="faint sm" id="sped-help"></div><div class="row" id="sped-colors" style="gap:4px"></div></div>
      </div>
    </div></div>`;
  const ed = document.getElementById("sped");
  const cell = (e) => { const r = ed.getBoundingClientRect(); return [Math.floor(((e.clientX - r.left) / r.width) * 24), Math.floor(((e.clientY - r.top) / r.height) * 21)]; };
  let down = 0;
  const stroke = (e) => { const [x, y] = cell(e); spPaint(x, y, down === 2 ? 0 : spMulti ? spColor : 1); };
  ed.onpointerdown = (e) => { if (!spBuf) return; down = e.button === 2 ? 2 : 1; try { ed.setPointerCapture(e.pointerId); } catch { /* a synthetic event has no pointer to capture */ } stroke(e); e.preventDefault(); };
  ed.onpointermove = (e) => { if (down) stroke(e); };
  ed.onpointerup = ed.onpointercancel = () => { down = 0; };
  ed.oncontextmenu = (e) => e.preventDefault();
  spBuf = null; spAddr = -1;
  live(body, (s) => {
    // The sprite pointers sit 1016 bytes into the screen. Where the screen is inside its 16 KB bank comes from $D018 (what the chip uses:
    // a program may move it without telling the KERNAL); which bank it is we can only take from the KERNAL's screen page, as the CIA port is not in RAM.
    const v = s.vic, scr = ((s.ram[0x288] << 8) & 0xc000) | (((v[0x18] >> 4) & 15) << 10);
    for (let i = 0; i < 8; i++) {
      const on_ = (v[0x15] >> i) & 1, ptr = s.ram[(scr + 0x3f8 + i) & 0xffff], addr = ((scr & 0xc000) + ptr * 64) & 0xffff;
      const multi = (v[0x1c] >> i) & 1, col = v[0x27 + i] & 15, m0 = v[0x25] & 15, m1 = v[0x26] & 15;
      const c = document.querySelector(`#sp${i} canvas`); if (!c) continue;
      const g = c.getContext("2d"), img = g.createImageData(24, 21);
      const bits = decodeSprite(s.ram.subarray(addr, addr + 63), !!multi);
      if (on_) for (let y = 0; y < 21; y++) for (let x = 0; x < 24; x++) {
        const val = bits[y][x];
        const ci = multi ? (val === 0 ? -1 : val === 1 ? m0 : val === 2 ? col : m1) : (val ? col : -1);
        if (ci >= 0) img.data.set([...spRGB(ci), 255], (y * 24 + x) * 4);
      }
      g.putImageData(img, 0, 0);
      const px = v[i * 2] | (((v[0x10] >> i) & 1) << 8), py = v[i * 2 + 1];
      const card = document.getElementById(`sp${i}`);
      card.classList.toggle("off", !on_);
      card.style.outline = i === spSel ? "1px solid var(--accent, #7aa2ff)" : "";
      document.getElementById(`spm${i}`).textContent = on_ ? `${px},${py} $${hex(addr, 4)}${multi ? " multi" : ""}${(v[0x17] >> i) & 1 ? " tall" : ""}${(v[0x1d] >> i) & 1 ? " wide" : ""}` : "off";
      if (i === spSel) {
        spLast = { col, m0, m1 };
        // load the sprite into the editor when it is chosen, or when the program moved its pointer or changed its mode
        if (spBuf === null || addr !== spAddr || !!multi !== spMulti) { spAddr = addr; spMulti = !!multi; spBuf = Uint8Array.from(s.ram.subarray(addr, addr + 63)); }
        spDraw();
      }
    }
  }, 400);
}

function spDraw() {
  const ed = document.getElementById("sped"); if (!ed || !spBuf) return;
  const g = ed.getContext("2d"), bits = decodeSprite(spBuf, spMulti), cw = 288 / 24, ch = 252 / 21;
  const c = spLast ?? { col: 1, m0: 2, m1: 6 };
  g.fillStyle = "#101018"; g.fillRect(0, 0, 288, 252);
  for (let y = 0; y < 21; y++) for (let x = 0; x < 24; x++) {
    const v = bits[y][x];
    const ci = spMulti ? (v === 0 ? -1 : v === 1 ? c.m0 : v === 2 ? c.col : c.m1) : (v ? c.col : -1);
    if (ci >= 0) { g.fillStyle = PAL[ci]; g.fillRect(x * cw, y * ch, cw, ch); }
  }
  g.strokeStyle = "rgba(255,255,255,.12)"; g.lineWidth = 1; g.beginPath();
  for (let x = 0; x <= 24; x += spMulti ? 2 : 1) { g.moveTo(x * cw + .5, 0); g.lineTo(x * cw + .5, 252); }
  for (let y = 0; y <= 21; y++) { g.moveTo(0, y * ch + .5); g.lineTo(288, y * ch + .5); }
  g.stroke();
  document.getElementById("sped-n").textContent = String(spSel);
  document.getElementById("sped-at").textContent = `$${hex(spAddr, 4)}`;
  document.getElementById("sped-multi")?.setAttribute("aria-pressed", spMulti ? "true" : "false");
  document.getElementById("sped-help").textContent = spMulti ? "Multicolour: pixels are double wide. Left click paints the chosen colour, right click erases." : "Left click or drag paints, right click erases.";
  const box = document.getElementById("sped-colors");
  if (box) box.innerHTML = spMulti ? [[1, c.m0, "shared 1"], [2, c.col, "own"], [3, c.m1, "shared 2"]].map(([slot, ci, label]) => `<button class="btn sm" data-act="sp-color" data-slot="${slot}" aria-pressed="${spColor === slot}" title="${label}" style="gap:5px"><span style="width:12px;height:12px;border-radius:2px;background:${PAL[ci]};display:inline-block"></span>${label}</button>`).join("") : "";
}
/** a change to the sprite: draw it at once, then write the sprite's 63 bytes into the machine's RAM */
function spCommit() {
  spDraw();
  clearTimeout(spTimer);
  spTimer = setTimeout(async () => {
    try { await post(`/api/machines/${S.current}/memory`, { addr: spAddr, bytes: [...spBuf], say: `Sprite editor: wrote sprite ${spSel} to $${hex(spAddr, 4)}.` }); }
    catch (e) { toast(e.message, "error"); }
  }, 60);
}
function spPaint(x, y, value) {
  if (!spBuf || x < 0 || x > 23 || y < 0 || y > 20) return;
  const next = encodeSprite(paintSprite(decodeSprite(spBuf, spMulti), x, y, value, spMulti), spMulti);
  if (next.every((b, i) => b === spBuf[i])) return;
  spBuf = next; spCommit();
}
actions["sp-pick"] = (el) => { spSel = Number(el.dataset.i); spBuf = null; spAddr = -1; };
actions["sp-clear"] = () => { if (!spBuf) return; spBuf = new Uint8Array(63); spCommit(); };
actions["sp-invert"] = () => { if (!spBuf) return; spBuf = spBuf.map((b) => b ^ 0xff); spCommit(); };
actions["sp-reload"] = () => { spBuf = null; spAddr = -1; };
actions["sp-color"] = (el) => { spColor = Number(el.dataset.slot); spDraw(); };
actions["sp-multi"] = async () => {
  if (!spBuf) return;
  const next = !spMulti;
  try {
    const snap = await snapshot();
    const reg = (snap.vic[0x1c] & ~(1 << spSel)) | (next ? 1 << spSel : 0);
    await post(`/api/machines/${S.current}/memory`, { addr: 0xd01c, bytes: [reg], say: `Sprite editor: sprite ${spSel} is ${next ? "multicolour" : "hires"} now.` });
    spBuf = encodeSprite(convertSprite(decodeSprite(spBuf, spMulti), next), next); spMulti = next; spCommit();
  } catch (e) { toast(e.message, "error"); }
};
actions["sp-data"] = async () => {
  if (!spBuf) return;
  try { await navigator.clipboard.writeText(toData(spBuf, 1000)); toast("BASIC DATA lines for the sprite copied. Paste them into the C64 (Ctrl+V on the screen).", "ok"); }
  catch { toast("The browser would not let me use the clipboard here.", "error"); }
};

function charsetPane(body) {
  body.innerHTML = `<div class="row"><span class="faint sm" id="csinfo"></span></div><canvas id="cs" width="256" height="64" style="width:100%;max-height:150px;image-rendering:pixelated;background:#000;border-radius:6px;object-fit:contain"></canvas>`;
  live(body, (s) => {
    const v = s.vic, scr = (s.ram[0x288] << 8) & 0xffff, bank = scr & 0xc000, off = ((v[0x18] >> 1) & 7) * 0x800, base = bank + off;
    const rom = (bank === 0 || bank === 0x8000) && off === 0x1000 || off === 0x1800 && (bank === 0 || bank === 0x8000);
    const info = document.getElementById("csinfo");
    const c = document.getElementById("cs"); if (!c) return;
    const g = c.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, 256, 64);
    if (rom) { info.textContent = `The ROM character set is in use (at $${hex(base, 4)}, seen by the VIC but not in RAM). A custom set appears here when a program points $D018 at RAM.`; return; }
    info.textContent = `Custom character set in RAM at $${hex(base, 4)} (VIC bank inferred from the KERNAL screen pointer).`;
    const img = g.createImageData(256, 64);
    for (let ch = 0; ch < 256; ch++) for (let y = 0; y < 8; y++) { const byte = s.ram[(base + ch * 8 + y) & 0xffff]; for (let x = 0; x < 8; x++) { const on_ = (byte >> (7 - x)) & 1, px = ((ch >> 5) * 8 + y) * 256 + (ch & 31) * 8 + x, o = px * 4; img.data.set(on_ ? [167, 158, 245, 255] : [0, 0, 0, 255], o); } }
    g.putImageData(img, 0, 0);
  }, 500);
}

function cheatsPane(body) {
  const n = search.cands?.length ?? 0;
  body.innerHTML = `<div class="row wrap"><button class="btn sm primary" data-act="cf-new">New search</button>
    <input class="field mono" id="cfv" style="width:64px" placeholder="value"><button class="btn sm" data-act="cf-eq">= value</button>
    <button class="btn sm" data-act="cf-chg">Changed</button><button class="btn sm" data-act="cf-same">Same</button><button class="btn sm" data-act="cf-dec">Decreased</button><button class="btn sm" data-act="cf-inc">Increased</button>
    <span class="spacer"></span><span class="faint sm" id="cfn">${search.snap ? `${n} candidates · step ${search.step}` : "Take a first snapshot, then change something in the game and narrow it down."}</span></div>
    <div class="grow scroll" id="cflist"></div>
    <div class="faint sm">Classic memory search: find the byte that holds your lives or score, then POKE it. Reads real RAM; pokes are typed on the C64's own keyboard.</div>`;
  listCands();
}
async function cfStep(kind) {
  try {
    const s = (await snapshot()).ram.slice();
    if (kind === "new") { search = { snap: s, cands: Array.from({ length: 65536 }, (_, i) => i).filter((a) => a < 0xd000 || a > 0xdfff), step: 0 }; }
    else if (search.snap) {
      const v = parseInt(document.getElementById("cfv")?.value ?? "", 10), p = search.snap;
      const keep = { eq: (a) => s[a] === v, chg: (a) => s[a] !== p[a], same: (a) => s[a] === p[a], dec: (a) => s[a] < p[a], inc: (a) => s[a] > p[a] }[kind];
      if (kind === "eq" && !(v >= 0 && v <= 255)) return toast("Type a value from 0 to 255 first.", "error");
      search.cands = search.cands.filter(keep); search.snap = s; search.step++;
    }
    cheatsPane(document.getElementById("dbody"));
  } catch (e) { toast(e.message, "error"); }
}
for (const k of ["new", "eq", "chg", "same", "dec", "inc"]) actions[`cf-${k}`] = () => cfStep(k);
function listCands() {
  const el = document.getElementById("cflist"); if (!el || !search.cands) return;
  el.innerHTML = search.cands.length > 200 ? `<div class="dim sm" style="padding:6px">Too many to list (${search.cands.length}). Narrow it down.</div>` : `<table class="t"><tr><th>Address</th><th>Value</th><th></th></tr>${search.cands.slice(0, 80).map((a) => `<tr><td class="mono">$${hex(a, 4)} (${a})</td><td class="mono">${search.snap[a]}</td><td><button class="btn sm" data-act="cf-poke" data-a="${a}">Type POKE…</button></td></tr>`).join("")}</table>`;
}
actions["cf-poke"] = (el) => { const v = prompt(`POKE ${el.dataset.a}, value (0-255):`, "99"); if (v !== null && +v >= 0 && +v <= 255) send({ t: "paste", name: S.current, text: `POKE ${el.dataset.a},${+v}\n` }); };

async function capturesPane(body) {
  body.innerHTML = `<div class="dim sm">Loading…</div>`;
  try {
    const { items } = await get("/api/captures");
    body.innerHTML = items.length ? `<div class="grow scroll"><table class="t"><tr><th>File</th><th>Kind</th><th>Size</th><th></th></tr>${items.map((i) => `<tr><td class="mono">${esc(i.name)}</td><td>${i.kind}</td><td>${(i.size / 1024).toFixed(0)} KB</td><td><a class="btn sm" href="/api/captures/${encodeURIComponent(i.name)}" download>Download</a></td></tr>`).join("")}</table></div>` : `<div class="dim" style="padding:10px">No captures yet. Use ▣ Shot or ● Rec under the screen. The agent's sessions are saved here too.</div>`;
  } catch (e) { body.innerHTML = `<div class="problems">${esc(e.message)}</div>`; }
}

const notBuilt = (title, why, plan) => (body) => { body.innerHTML = `<div class="col" style="padding:10px;gap:8px"><div class="row"><span class="badge-s no">not built yet</span><b>${title}</b></div><div class="dim">${why}</div><div class="faint sm">${plan}</div></div>`; };
// ---------- SID jukebox ----------
// The tunes on your shelf (.sid files). Play resets the machine and the tune's own code drives the machine's own SID chip.
let sidPick = Object.create(null), sidAsk = null; // shelf name -> chosen song; a Play waiting for "play anyway"
function sidPane(body) {
  const name = S.current;
  if (name && S.sid[name] === undefined && machine()?.running) { S.sid[name] = null; get(`/api/machines/${name}/sid`).then((r) => { S.sid[name] = r.playing; if (tab === "sid") render(); }).catch(() => {}); } // what is playing already (another window may have started it)
  const tunes = (S.shelf ?? []).filter((i) => i.kind === "sid"), now = name ? S.sid[name] : null;
  const run = !!machine()?.running;
  body.innerHTML = `<div class="col" style="padding:8px 10px;gap:8px;height:100%;min-height:0">
    <div class="row wrap" style="gap:8px">${now
      ? `<span class="badge-s verified">playing</span><b class="trunc" style="min-width:0">${esc(now.title || now.shelf)}</b><span class="faint sm trunc">${esc(now.author || "")}${now.author ? " · " : ""}song ${now.song} of ${now.songs}</span><span class="spacer"></span><button class="btn sm danger" data-act="sid-stop">${icon("stop")} Stop</button>`
      : `<b>SID jukebox</b><span class="faint sm">${run ? "Pick a tune from your shelf." : "Power the machine on first."}</span>`}</div>
    ${now?.warnings?.length ? `<div class="faint sm" style="color:var(--warn,#e8c46a)">${now.warnings.map(esc).join(" ")}</div>` : ""}
    ${sidAsk ? `<div class="problems" role="alert"><div>${esc(sidAsk.msg)}</div><div class="row" style="margin-top:6px"><button class="btn sm primary" data-act="sid-force">Play anyway</button><button class="btn sm" data-act="sid-cancel">Cancel</button></div></div>` : ""}
    <div class="grow scroll col" style="gap:3px;min-height:0" id="sid-list">${tunes.length ? tunes.map((t) => {
      const n = Math.min(t.sid?.songs ?? 1, Math.max(1, sidPick[t.name] ?? t.sid?.startSong ?? 1)), songs = t.sid?.songs ?? 1, on_ = now?.shelf === t.name;
      return `<div class="slot" style="grid-template-columns:22px 1fr auto auto;padding:4px 6px${on_ ? ";outline:1px solid var(--ok,#6c6)" : ""}"><div style="text-align:center">${icon("music")}</div>
        <div class="col" style="gap:0;min-width:0"><div class="name trunc sm">${esc(t.sid?.title || t.name)}</div><div class="faint trunc" style="font-size:10px">${esc(t.sid?.author || t.name)}${t.sid?.released ? " · " + esc(t.sid.released) : ""} · ${songs} song${songs === 1 ? "" : "s"}${t.sid ? " · " + esc(t.sid.clock) + " " + esc(t.sid.model) : ""}</div></div>
        ${songs > 1 ? `<div class="row" style="gap:2px"><button class="btn sm ghost icon" data-act="sid-song" data-n="${t.name}" data-d="-1" aria-label="Previous song">‹</button><span class="mono sm" style="min-width:34px;text-align:center">${n}/${songs}</span><button class="btn sm ghost icon" data-act="sid-song" data-n="${t.name}" data-d="1" aria-label="Next song">›</button></div>` : "<span></span>"}
        <button class="btn sm ${on_ ? "" : "primary"}" data-act="sid-play" data-n="${esc(t.name)}" ${run ? "" : "disabled"}>${icon("play")} Play</button></div>`;
    }).join("") : `<div class="dim sm" style="padding:6px">No SID tunes on your shelf yet. Drop a .sid file on the window or press Import. Nix64 ships no music: the High Voltage SID Collection (hvsc.c64.org) is where most of it lives.</div>`}</div>
    <div class="faint" style="font-size:10px;line-height:1.35">Play resets the machine (a tune takes the whole machine, as on a real C64), loads the tune into RAM and plays it on this machine's own SID chip, the one set by sid.model in its file. It plays tunes that sit in free RAM ($0800 to $9FFF and $C000 to $CFFF); others are refused, not played wrongly. No level meters yet. I have not listened to it by ear.</div>
  </div>`;
}
async function sidPlay(shelf, force = false) {
  const name = S.current;
  try {
    await post(`/api/machines/${name}/sid`, { shelf, song: sidPick[shelf] ?? undefined, force });
    sidAsk = null;
  } catch (e) {
    if (e.status === 409 && e.body?.needsConfirm) sidAsk = { shelf, msg: e.body.error };
    else { sidAsk = null; toast(e.message, "error"); }
  }
  if (tab === "sid") render();
}
actions["sid-play"] = (el) => sidPlay(el.dataset.n);
actions["sid-force"] = () => { if (sidAsk) sidPlay(sidAsk.shelf, true); };
actions["sid-cancel"] = () => { sidAsk = null; if (tab === "sid") render(); };
actions["sid-stop"] = async () => { try { await post(`/api/machines/${S.current}/sid/stop`); } catch (e) { toast(e.message, "error"); } };
actions["sid-song"] = (el) => {
  const t = (S.shelf ?? []).find((i) => i.name === el.dataset.n), songs = t?.sid?.songs ?? 1;
  const cur = sidPick[el.dataset.n] ?? t?.sid?.startSong ?? 1;
  sidPick[el.dataset.n] = ((cur - 1 + Number(el.dataset.d) + songs) % songs) + 1;
  if (tab === "sid") render();
};
on("sid", () => { if (tab === "sid") render(); });
on("machines", () => { if (tab === "sid") render(); });
// ---------- ROM library ----------
// Your own folder of disks, tapes and cartridges (default ~/c64-library), browsed from a catalog the shell
// builds from it (Index). Start copies that one title to your shelf and starts it on the running machine.
// Nix64 ships and downloads none of it.
const lib = { info: null, q: "", kind: "", res: null, busy: "", err: "", ask: null, asked: false };
let libTimer = 0, libSeq = 0;
const KIND_ICON = { disk: "disk", tape: "tape", cart: "cart", prg: "file", sid: "music" };
function libraryPane(body) {
  if (!lib.asked) { lib.asked = true; libInfo(); }
  const hadFocus = document.activeElement?.id === "lib-q", info = lib.info, run = !!machine()?.running;
  const kinds = info?.kinds ? Object.keys(info.kinds) : [];
  body.innerHTML = `<div class="col" style="padding:8px 10px;gap:6px;height:100%;min-height:0">
    <div class="row wrap" style="gap:8px"><b>ROM library</b>
      <span class="faint sm trunc mono" style="min-width:0;flex:1" title="${esc(info?.root ?? "")}">${info ? esc(info.root) : "…"}</span>
      ${info?.indexed ? `<span class="faint sm">${info.count.toLocaleString()} title${info.count === 1 ? "" : "s"}</span>` : ""}
      <button class="btn sm" data-act="lib-index" ${lib.busy || !info?.exists ? "disabled" : ""}>${icon("reset")} ${lib.busy === "index" ? "Indexing…" : info?.indexed ? "Index again" : "Index"}</button></div>
    ${!info ? "" : !info.exists ? `<div class="dim sm">No folder at ${esc(info.root)}. Make it and put your own disks, tapes and cartridges in it (folders and .zip files are fine), then press Index. To use another folder: Settings, or NIX64_LIBRARY.</div>`
      : !info.indexed ? `<div class="dim sm">The folder is there but not catalogued yet. Press Index (it reads names only, a big collection takes a minute or two).</div>`
      : `<div class="row" style="gap:6px"><input class="field" id="lib-q" style="flex:1;min-width:0" placeholder="Search ${info.count.toLocaleString()} titles: words in the name or the folder" value="${esc(lib.q)}" aria-label="Search the library" autocomplete="off" spellcheck="false">
        <select class="field" id="lib-kind" style="width:150px;flex:none" aria-label="Kind"><option value="">all kinds</option>${kinds.map((k) => `<option value="${k}" ${lib.kind === k ? "selected" : ""}>${k} (${info.kinds[k].toLocaleString()})</option>`).join("")}</select></div>`}
    ${lib.err ? `<div class="problems" role="alert">${esc(lib.err)}</div>` : ""}
    ${lib.ask ? `<div class="problems" role="alert"><div>${esc(lib.ask.msg)}</div><div class="row" style="margin-top:6px"><button class="btn sm primary" data-act="lib-sid-force">Play anyway</button><button class="btn sm" data-act="lib-sid-cancel">Cancel</button></div></div>` : ""}
    <div class="grow scroll col" style="gap:3px;min-height:0" id="lib-list">${libRows(run)}</div>
    <div class="faint" style="font-size:10px;line-height:1.35">Nix64 ships and downloads no ROMs or disks: this is only a catalog of the folder you fill yourself. Start copies one title to your shelf, then loads it like any shelf item (disks type LOAD for you).${run ? "" : " Power the machine on to start a title."}</div>
  </div>`;
  const q = body.querySelector("#lib-q");
  if (q) {
    q.oninput = () => { lib.q = q.value; clearTimeout(libTimer); libTimer = setTimeout(libSearch, 140); };
    q.onkeydown = (e) => e.stopPropagation();
    if (hadFocus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }
  const k = body.querySelector("#lib-kind");
  if (k) k.onchange = () => { lib.kind = k.value; libSearch(); };
  if (info?.indexed && !lib.res && !lib.err) libSearch();
}
function libRows(run) {
  const info = lib.info;
  if (!info?.indexed) return "";
  if (!lib.res) return `<div class="dim sm" style="padding:6px">…</div>`;
  if (!lib.res.items.length) return `<div class="dim sm" style="padding:6px">Nothing matches.</div>`;
  const more = lib.res.total > lib.res.items.length ? `<div class="faint sm" style="padding:4px 6px">${lib.res.items.length} of ${lib.res.total.toLocaleString()} shown: add a word to narrow it.</div>` : "";
  return lib.res.items.map((t) => `<div class="slot" style="grid-template-columns:22px 1fr auto;padding:4px 6px"><div style="text-align:center">${icon(KIND_ICON[t.kind] ?? "file")}</div>
    <div class="col" style="gap:0;min-width:0"><div class="name trunc sm" title="${esc(t.name)}">${esc(t.name)}</div><div class="faint trunc" style="font-size:10px">${esc(t.kind)} · ${esc(t.set)}${t.zip ? " · in a zip" : ""} · ${(t.size / 1024).toFixed(t.size < 10240 ? 1 : 0)} KB</div></div>
    <button class="btn sm primary" data-act="lib-run" data-id="${esc(t.id)}" ${run && !lib.busy ? "" : "disabled"}>${lib.busy === t.id ? "…" : `${icon("play")} Start`}</button></div>`).join("") + more;
}
async function libInfo() {
  try { lib.info = await get("/api/library"); lib.err = ""; } catch (e) { lib.err = e.message; }
  if (tab === "library") render();
}
async function libSearch() {
  const seq = ++libSeq;
  try {
    const r = await get(`/api/library/search?q=${encodeURIComponent(lib.q)}&kind=${encodeURIComponent(lib.kind)}&limit=60`);
    if (seq !== libSeq) return; // a newer keystroke is already searching
    lib.res = r; lib.err = "";
  } catch (e) { if (seq !== libSeq) return; lib.err = e.message; }
  const list = document.getElementById("lib-list");
  if (tab === "library" && list) list.innerHTML = libRows(!!machine()?.running); else if (tab === "library") render();
}
actions["lib-index"] = async () => {
  lib.busy = "index"; render();
  try { const r = await post("/api/library/index"); toast(`Catalogued ${r.count.toLocaleString()} title${r.count === 1 ? "" : "s"}.`, "ok"); lib.res = null; await libInfo(); }
  catch (e) { lib.err = e.message; }
  lib.busy = ""; if (tab === "library") render();
};
actions["lib-run"] = async (el) => {
  const id = el.dataset.id;
  lib.busy = id; lib.err = ""; render();
  try {
    const r = await post(`/api/machines/${S.current}/library/run`, { id });
    await loadShelf();
    if (r.how === "sid") { lib.busy = ""; await libPlaySid(r.shelf, false); return; }
    toast(`Started “${r.title}”.`, "ok");
  } catch (e) { lib.err = e.message; }
  lib.busy = ""; if (tab === "library") render();
};
async function libPlaySid(shelf, force) {
  try { await post(`/api/machines/${S.current}/sid`, { shelf, force }); lib.ask = null; toast("Playing the tune. The SID tab has the controls.", "ok"); }
  catch (e) { if (e.status === 409 && e.body?.needsConfirm) lib.ask = { shelf, msg: e.body.error }; else { lib.ask = null; lib.err = e.message; } }
  if (tab === "library") render();
}
actions["lib-sid-force"] = () => { if (lib.ask) libPlaySid(lib.ask.shelf, true); };
actions["lib-sid-cancel"] = () => { lib.ask = null; if (tab === "library") render(); };
on("library", () => { lib.asked = false; lib.res = null; if (tab === "library") render(); });
const printerPane = notBuilt("Printer to PDF", "The engine can print to a file, but the shell does not yet collect it into a PDF.", "Planned: virtual MPS-803 to PDF; a real MPS when one is attached on the real-hardware path.");
