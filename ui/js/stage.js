// The monitor in front of you: the bezel, the tube, the strip of machine buttons, and the keyboard capture.
import { S, on, send, post, toast, machine, frameHandlers, esc, api } from "./net.js";
import { icon } from "./icons.js";
import { Tube } from "./crt.js";
import { click } from "./sounds.js";

let tube, canvasEl, monitor, aspect = 1.33, picW = 384, picH = 272, focused = false, joyKeys = 0, rec = null;
const held = new Set();

export function init() {
  const el = document.getElementById("stage");
  el.innerHTML = `
  <div class="monitor-wrap" id="mon-wrap">
    <div class="monitor" id="monitor">
      <div class="tube" id="tube"><canvas id="screen" tabindex="0" aria-label="C64 screen. Click to type on the C64."></canvas><div class="gloss"></div><div class="off-screen" id="off" hidden></div></div>
      <div class="badge">NIX64</div>
      <div class="power"><span class="led" id="pled"></span>POWER</div>
    </div>
  </div>
  <div class="glass strip" id="strip"></div>`;
  canvasEl = el.querySelector("#screen");
  monitor = el.querySelector("#monitor");
  tube = new Tube(canvasEl);
  window.__tube = tube;

  frameHandlers.add((mid, w, h, asp, lines, frame, pal, pix) => {
    if (mid !== S.mids[S.current]) return;
    picW = w; picH = h; if (asp && Math.abs(asp - aspect) > 0.001) { aspect = asp; layout(); }
    if (!frameHandlers.pending) frameHandlers.pending = true;
    latest = { pix: pix.slice(), pal: pal.slice(), w, h };
    if (!raf) raf = requestAnimationFrame(paint);
  });
  new ResizeObserver(layout).observe(document.getElementById("mon-wrap"));
  on("machines", update); on("settings", applySettings); on("status", paintStatus);
  setupKeys();
  update();
}

let latest = null, raf = 0;
function paint() { raf = 0; if (latest) { tube.frame(latest.pix, latest.pal, latest.w, latest.h); document.getElementById("pled")?.classList.add("on"); } }

/** Fit the tube into the stage, keeping the picture's true shape (width x pixel aspect : height). */
function layout() {
  const wrap = document.getElementById("mon-wrap");
  if (!wrap || !monitor) return;
  const bez = S.settings?.display.bezel !== false;
  const padX = bez ? 32 : 0, padY = bez ? 42 : 0;
  const availW = wrap.clientWidth - padX - 8, availH = wrap.clientHeight - padY - 8;
  const ratio = (picW * aspect) / picH;
  let w = availW, h = w / ratio;
  if (h > availH) { h = availH; w = h * ratio; }
  w = Math.max(160, Math.floor(w)); h = Math.max(120, Math.floor(h));
  const t = document.getElementById("tube");
  t.style.width = `${w}px`; t.style.height = `${h}px`;
  tube.resize(w, h);
}

function applySettings() {
  if (!S.settings || !monitor) return;
  const d = S.settings.display;
  monitor.classList.toggle("nobezel", !d.bezel);
  tube.setStrength(d.crt ? d.crtStrength / 100 : 0);
  layout();
  joyKeys = S.settings.keys.joystickKeys ? 2 : 0;
}

export function update() {
  const m = machine();
  const off = document.getElementById("off");
  if (!off) return;
  const on_ = !!m?.running;
  off.hidden = on_;
  document.getElementById("pled")?.classList.toggle("on", on_);
  if (!on_) {
    off.innerHTML = m
      ? `<div><div class="big">${esc(m.name.toUpperCase())}</div><p>${esc(m.description || "A Commodore 64.")}</p><div class="row" style="justify-content:center"><button class="btn primary" data-act="power-on">${icon("power")} Power on</button><button class="btn" data-act="edit-machine">Edit machine file</button></div>${m.problems.length ? `<p class="problems">${esc(m.problems.join("; "))}</p>` : ""}</div>`
      : `<div><div class="big">NO MACHINE</div><p>Make a machine to begin.</p><button class="btn primary" data-act="new-machine">${icon("plus")} New machine</button></div>`;
  }
  renderStrip();
  layout();
  applySettings();
}

function renderStrip() {
  const m = machine(), st = S.status[S.current];
  const run = !!m?.running;
  document.getElementById("strip").innerHTML = `
    <button class="btn sm" data-act="${run ? "power-off" : "power-on"}" ${m ? "" : "disabled"} title="${run ? "Switch the machine off" : "Switch the machine on"}">${icon("power")} ${run ? "Power off" : "Power on"}</button>
    <button class="btn sm" data-act="reset" ${run ? "" : "disabled"} title="The reset button (RUN/STOP+RESTORE stays on the keyboard)">${icon("reset")} Reset</button>
    <button class="btn sm" data-act="power-cycle" ${run ? "" : "disabled"} title="Power cycle: clears RAM, like unplugging it">${icon("cycle")} Power cycle</button>
    <button class="btn sm" data-act="warp" aria-pressed="${st?.warp ? "true" : "false"}" ${run ? "" : "disabled"} title="Warp: run as fast as the computer allows (loading, long programs)">${icon("warp")} Warp</button>
    <button class="btn sm" data-act="joykeys" aria-pressed="${joyKeys ? "true" : "false"}" ${run ? "" : "disabled"} title="Arrow keys and Space become a joystick in port 2 (Ctrl+J)">${icon("joystick")} Keys as stick</button>
    <button class="btn sm" data-act="shot" ${run ? "" : "disabled"} title="Save the picture as a PNG">${icon("camera")} Shot</button>
    <button class="btn sm" data-act="record" aria-pressed="${rec ? "true" : "false"}" ${run ? "" : "disabled"} title="Record the screen as a video">${icon(rec ? "stop" : "record")} ${rec ? "Stop rec" : "Rec"}</button>
    <span class="spacer"></span>
    <span class="captured ${focused ? "on" : "off"}" id="captured">${focused ? "● KEYBOARD ON THE C64" : "○ click the screen to type"}</span>
    <span class="chip" id="fpschip">${run && st ? `${st.fps || "?"} fps` : "off"}</span>
    <button class="btn sm ghost icon" data-act="fullscreen" title="Fullscreen (F11)" aria-label="Fullscreen">${icon("fullscreen")}</button>`;
}

function paintStatus(m) {
  if (m.name !== S.current) return;
  const chip = document.getElementById("fpschip");
  if (chip) chip.textContent = `${m.fps || "?"} fps`;
  const w = document.querySelector('[data-act="warp"]');
  if (w) w.setAttribute("aria-pressed", m.warp ? "true" : "false");
  document.getElementById("live-screen").textContent = m.screen.filter(Boolean).slice(-6).join("\n");
}

// ---------- keyboard ----------

function setFocused(v) {
  focused = v;
  monitor?.classList.toggle("focus", v);
  const c = document.getElementById("captured");
  if (c) { c.className = `captured ${v ? "on" : "off"}`; c.textContent = v ? "● KEYBOARD ON THE C64" : "○ click the screen to type"; }
  if (!v && S.current) send({ t: "release", name: S.current });
}

const RESERVED = new Set(["F11", "F12"]);
const STICK = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Space: "fire", ControlLeft: "fire" };
let stick = new Set();

function setupKeys() {
  canvasEl.addEventListener("focus", () => setFocused(true));
  canvasEl.addEventListener("blur", () => setFocused(false));
  canvasEl.addEventListener("keydown", (e) => {
    if (RESERVED.has(e.key) || !S.current) return;
    e.preventDefault();
    if (e.ctrlKey && e.code === "KeyJ" && !e.repeat) { toggleJoy(); return; }
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") { send({ t: "shift", name: S.current, down: true }); return; }
    if (joyKeys && STICK[e.code]) { stick.add(STICK[e.code]); sendStick(); return; }
    if (e.repeat) return;
    send({ t: "kd", name: S.current, code: e.code, key: e.key, shift: e.shiftKey });
    held.add(e.code);
    click();
  });
  canvasEl.addEventListener("keyup", (e) => {
    if (!S.current) return;
    e.preventDefault();
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") { send({ t: "shift", name: S.current, down: false }); return; }
    if (joyKeys && STICK[e.code]) { stick.delete(STICK[e.code]); sendStick(); return; }
    send({ t: "ku", name: S.current, code: e.code });
    held.delete(e.code);
  });
  canvasEl.addEventListener("paste", (e) => { e.preventDefault(); const t = e.clipboardData.getData("text"); if (t && S.current) send({ t: "paste", name: S.current, text: t }); });
  canvasEl.addEventListener("pointerdown", () => canvasEl.focus());
  window.addEventListener("blur", () => setFocused(false));
}

function sendStick() { send({ t: "joy", name: S.current, port: 2, spec: [...stick].join("+") || "none" }); }
function toggleJoy() { joyKeys = joyKeys ? 0 : 2; stick.clear(); sendStick(); toast(joyKeys ? "Arrow keys and Space are a joystick in port 2." : "Keyboard is a keyboard again."); renderStrip(); }
export const focusScreen = () => canvasEl?.focus();

// ---------- strip actions ----------

export async function action(act) {
  const name = S.current;
  try {
    switch (act) {
      case "power-on": await post(`/api/machines/${name}/start`); break;
      case "power-off": await post(`/api/machines/${name}/stop`); break;
      case "reset": await post(`/api/machines/${name}/reset`, { hard: false }); toast("Reset."); break;
      case "power-cycle": await post(`/api/machines/${name}/reset`, { hard: true }); toast("Power cycled."); break;
      case "warp": send({ t: "warp", name, on: !S.status[name]?.warp }); break;
      case "joykeys": toggleJoy(); break;
      case "fullscreen": document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); break;
      case "shot": shot(); break;
      case "record": record(); break;
    }
  } catch (e) { toast(e.message, "error"); }
}

function shot() {
  const c = document.createElement("canvas"); c.width = picW * 2; c.height = picH * 2;
  const x = c.getContext("2d"); x.imageSmoothingEnabled = false;
  x.drawImage(canvasEl, 0, 0, c.width, c.height);
  c.toBlob(async (b) => {
    const res = await fetch("/api/captures?kind=png", { method: "POST", headers: { "x-nix64": "1" }, body: b });
    const j = await res.json(); toast(res.ok ? `Saved ${j.name}` : j.error, res.ok ? "ok" : "error");
  });
}
function record() {
  if (rec) { rec.stop(); return; }
  const stream = canvasEl.captureStream(30);
  const mr = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9", videoBitsPerSecond: 3_000_000 });
  const chunks = [];
  mr.ondataavailable = (e) => chunks.push(e.data);
  mr.onstop = async () => {
    rec = null; renderStrip();
    const res = await fetch("/api/captures?kind=webm", { method: "POST", headers: { "x-nix64": "1" }, body: new Blob(chunks, { type: "video/webm" }) });
    const j = await res.json(); toast(res.ok ? `Saved ${j.name}` : j.error, res.ok ? "ok" : "error");
  };
  mr.start(1000); rec = mr; toast("Recording the screen. Press Stop rec to save."); renderStrip();
}
