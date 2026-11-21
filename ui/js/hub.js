// The Hub: every machine on one screen. Live tiles of the real pictures, pick one to go full size, run
// as many as you like. Number keys 1-9 zoom a tile; Esc returns here; N makes a new machine.
import { S, on, actions, frameHandlers, machine, esc, subscribe } from "./net.js";
import { icon } from "./icons.js";
import { Tube } from "./crt.js";

const tiles = new Map(); // name -> { canvas, ctx, off }

export function init() {
  const el = document.getElementById("hub-view");
  el.innerHTML = `<div class="hub-head"><h1>HUB</h1><span class="faint sm" id="hubsub"></span><span class="spacer"></span><button class="btn sm" data-act="new-machine">${icon("plus")} New machine</button><button class="btn sm" data-act="back">Back to the machine (Esc)</button></div><div class="grid" id="grid"></div>`;
  on("machines", () => { if (S.view === "hub") render(); });
  on("status", (st) => { const c = S.view === "hub" ? document.querySelector(`[data-fps="${CSS.escape(st.name)}"]`) : null; if (c && st.fps) c.textContent = `${Math.round(st.fps)} fps`; });
  frameHandlers.add((mid, w, h, asp, lines, frame, pal, pix) => {
    if (S.view !== "hub") return;
    const name = Object.keys(S.mids).find((n) => S.mids[n] === mid), t = tiles.get(name);
    if (!t) return;
    if (t.canvas.width !== w || t.canvas.height !== h) { t.canvas.width = w; t.canvas.height = h; t.img = null; }
    t.rgba = Tube.toRGBA(pix, pal, w, h, t.rgba);
    t.ctx.putImageData(new ImageData(t.rgba, w, h), 0, 0);
    t.canvas.style.setProperty("--r", (w * (asp || 1)) / h);
  });
  window.addEventListener("keydown", (e) => {
    if (S.view !== "hub" || e.target.closest("input,textarea")) return;
    const n = Number(e.key);
    if (n >= 1 && n <= 9 && S.machines[n - 1]) { e.preventDefault(); actions["select"]({ dataset: { name: S.machines[n - 1].name } }); }
  });
}

export function render() {
  const grid = document.getElementById("grid"), ms = S.machines;
  const n = ms.length + 1, cols = Math.min(4, Math.ceil(Math.sqrt(n))), rows = Math.ceil(n / cols);
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  tiles.clear();
  grid.innerHTML = ms.map((m, i) => `<div class="tile ${m.running ? "" : "off"}" tabindex="0" role="button" data-act="select" data-name="${esc(m.name)}" aria-label="${esc(m.name)}, ${m.running ? "running" : "off"}">
      <div class="pic">${m.running ? `<canvas width="384" height="272" data-tile="${esc(m.name)}"></canvas>` : "OFF"}</div>
      <div class="bar"><span class="num">${i + 1}</span><b class="trunc">${esc(m.name)}</b><span class="faint sm trunc">${esc(m.model.toUpperCase())} ${esc(m.region.toUpperCase())} · ${esc(m.drives.map((d) => d.slot).join("+") || "no drive")}</span><span class="spacer"></span><span class="chip ${m.running ? "ok" : ""}" data-fps="${esc(m.name)}">${m.running ? `${S.status[m.name]?.fps ?? m.fps ?? 0 ? Math.round(S.status[m.name]?.fps ?? m.fps) : "?"} fps` : "off"}</span></div></div>`).join("")
    + `<div class="tile new" tabindex="0" role="button" data-act="new-machine"><div style="font-size:2rem">${icon("plus", 1.6)}</div>New machine</div>`;
  for (const c of grid.querySelectorAll("canvas[data-tile]")) tiles.set(c.dataset.tile, { canvas: c, ctx: c.getContext("2d") });
  document.getElementById("hubsub").textContent = `${ms.filter((m) => m.running).length} running · ${ms.length} machines`;
  subscribe(Object.fromEntries(ms.filter((m) => m.running).map((m) => [m.name, 15])));
}
