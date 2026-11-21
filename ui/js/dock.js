// The dock under the screen: the on-screen keyboard (with "guide me" highlights) and the tools that read
// the machine's real memory: a hex view, a sprite viewer, the charset, the cheat finder, captures.
import { S, on, send, get, post, actions, toast, machine, esc } from "./net.js";
import { click } from "./sounds.js";

const TABS = [["keys", "Keyboard"], ["memory", "Memory"], ["sprites", "Sprites"], ["charset", "Charset"], ["cheats", "Cheat finder"], ["captures", "Captures"], ["sid", "SID"], ["printer", "Printer"]];

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
  ({ keys: keysPane, memory: memoryPane, sprites: spritesPane, charset: charsetPane, cheats: cheatsPane, captures: capturesPane, sid: sidPane, printer: printerPane })[tab](body);
}
actions["dock-tab"] = (el) => { tab = el.dataset.tab; S.tool = tab; render(); };

// ---------- the keyboard ----------

function keysPane(body) {
  const u = 40;
  body.innerHTML = `<div class="osk-wrap"><div class="osk" id="osk">${ROWS.map((row, i) => `<div class="osk-row" style="${i === 1 ? "padding-left:6px" : i === 2 ? "padding-left:12px" : i === 3 ? "padding-left:0" : ""}">${row.map(([k, label, sub, w]) => `<button class="key ${LATCH.has(k) ? "latch" : ""}" data-key="${k}" style="width:${w * u + (w - 1) * 4}px" aria-label="${esc(label || k)}">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</button>`).join("")}</div>`).join("")}</div>
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

function spritesPane(body) {
  body.innerHTML = `<div class="sprites" id="sprites">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<div class="sprite off" id="sp${i}"><canvas width="24" height="21"></canvas><span>#${i}</span><span class="faint" id="spm${i}"></span></div>`).join("")}</div>
    <div class="faint sm">Read live from the VIC-II registers and the sprite pointers in RAM. Multicolour, expand and position are decoded as the chip sees them.</div>`;
  live(body, (s) => {
    const v = s.vic, scr = (s.ram[0x288] << 8) & 0xffff; // the KERNAL's screen page: the sprite pointers sit 1016 bytes into it
    for (let i = 0; i < 8; i++) {
      const on_ = (v[0x15] >> i) & 1, ptr = s.ram[(scr + 0x3f8 + i) & 0xffff], addr = ((scr & 0xc000) + ptr * 64) & 0xffff;
      const multi = (v[0x1c] >> i) & 1, col = v[0x27 + i] & 15, m0 = v[0x25] & 15, m1 = v[0x26] & 15;
      const c = document.querySelector(`#sp${i} canvas`); if (!c) continue;
      const g = c.getContext("2d"), img = g.createImageData(24, 21);
      if (on_) for (let y = 0; y < 21; y++) for (let x = 0; x < 24; x++) {
        const byte = s.ram[(addr + y * 3 + (x >> 3)) & 0xffff];
        let ci = -1;
        if (multi) { const bits = (byte >> (6 - (x & 6))) & 3; ci = bits === 0 ? -1 : bits === 1 ? m0 : bits === 2 ? col : m1; }
        else if ((byte >> (7 - (x & 7))) & 1) ci = col;
        if (ci >= 0) img.data.set([parseInt(PAL[ci].slice(1, 3), 16), parseInt(PAL[ci].slice(3, 5), 16), parseInt(PAL[ci].slice(5, 7), 16), 255], (y * 24 + x) * 4);
      }
      g.putImageData(img, 0, 0);
      const px = v[i * 2] | (((v[0x10] >> i) & 1) << 8), py = v[i * 2 + 1];
      document.getElementById(`sp${i}`).classList.toggle("off", !on_);
      document.getElementById(`spm${i}`).textContent = on_ ? `${px},${py} $${hex(addr, 4)}${multi ? " multi" : ""}${(v[0x17] >> i) & 1 ? " tall" : ""}${(v[0x1d] >> i) & 1 ? " wide" : ""}` : "off";
    }
  }, 400);
}

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
const sidPane = notBuilt("SID jukebox", "Playing SID music needs a SID player (libsidplayfp's sidplayfp) and the HVSC collection, and neither is wired in. The machine's own SID plays whatever a program sends it, as always.", "Planned: HVSC browser on the shelf, play through the real engine so it is the same chip you hear in games.");
const printerPane = notBuilt("Printer to PDF", "The engine can print to a file, but the shell does not yet collect it into a PDF.", "Planned: virtual MPS-803 to PDF; a real MPS when one is attached on the real-hardware path.");
