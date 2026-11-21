// Nix64 shell: boot, wiring, the views, the hotkeys.
import { S, on, emit, connect, subscribe, actions, get, toast, machine, send } from "./net.js";
import * as top from "./top.js";
import * as stage from "./stage.js";
import * as left from "./left.js";
import * as dock from "./dock.js";
import * as right from "./right.js";
import * as hub from "./hub.js";
import "./modals.js";

function applyUI() {
  const s = S.settings; if (!s) return;
  const r = document.documentElement;
  r.style.setProperty("--scale", s.display.scale / 100);
  r.dataset.contrast = s.display.highContrast ? "high" : "";
  r.dataset.motion = s.display.reducedMotion === "on" ? "off" : "";
}

function select(name) {
  S.current = name;
  S.view = "machine";
  document.documentElement.dataset.view = "machine";
  document.getElementById("machine-view").hidden = false;
  document.getElementById("hub-view").hidden = true;
  resubscribe();
  emit("machines");
  stage.update();
  right.init && null;
  setTimeout(stage.focusScreen, 50);
}

function resubscribe() {
  if (S.view === "hub") return; // the hub subscribes itself
  const m = machine();
  subscribe(m?.running ? { [m.name]: 60 } : {});
}

actions["select"] = (el) => select(el.dataset.name);
actions["hub"] = () => {
  const toHub = S.view !== "hub";
  S.view = toHub ? "hub" : "machine";
  document.documentElement.dataset.view = S.view;
  document.getElementById("machine-view").hidden = toHub;
  document.getElementById("hub-view").hidden = !toHub;
  if (toHub) hub.render(); else { resubscribe(); stage.update(); setTimeout(stage.focusScreen, 50); }
  emit("machines");
};
actions["back"] = () => { if (S.view === "hub") actions["hub"](); };
actions["mute"] = async () => { if (!S.settings) return; // not connected yet
   await fetch("/api/settings", { method: "PUT", headers: { "x-nix64": "1", "content-type": "application/json" }, body: JSON.stringify({ sound: { muted: !S.settings.sound.muted } }) }); };
for (const a of ["power-on", "power-off", "reset", "power-cycle", "warp", "joykeys", "fullscreen", "shot", "record"]) actions[a] = () => stage.action(a);

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input,textarea,select")) return;
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".tile")) { e.preventDefault(); e.target.click(); }
  if (e.key === "F9") { e.preventDefault(); actions["hub"](); }
  if (e.key === "F10") { e.preventDefault(); document.activeElement?.blur?.(); }
  if (e.key === "Escape" && S.view === "hub") actions["back"]();
  if (e.key === "n" && S.view === "hub") actions["new-machine"]();
});

// drop media anywhere on the window to put it on the shelf
window.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
window.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); left.importFiles([...e.dataTransfer.files]); } });
window.addEventListener("nix64-select", () => select(S.current));

// gamepad: auto-detected, drives port 2 (set the port with the keys-as-joystick switch for port 1 games)
let padState = "";
function pollPad() {
  const m = machine();
  if (m?.running && S.view === "machine") {
    const p = [...(navigator.getGamepads?.() ?? [])].find((g) => g?.connected);
    if (p) {
      const d = [];
      if (p.axes[1] < -0.5 || p.buttons[12]?.pressed) d.push("up");
      if (p.axes[1] > 0.5 || p.buttons[13]?.pressed) d.push("down");
      if (p.axes[0] < -0.5 || p.buttons[14]?.pressed) d.push("left");
      if (p.axes[0] > 0.5 || p.buttons[15]?.pressed) d.push("right");
      if (p.buttons[0]?.pressed || p.buttons[1]?.pressed || p.buttons[2]?.pressed || p.buttons[7]?.pressed) d.push("fire");
      const spec = d.join("+") || "none";
      if (spec !== padState) { padState = spec; send({ t: "joy", name: m.name, port: 2, spec }); }
    }
  }
  requestAnimationFrame(pollPad);
}
window.addEventListener("gamepadconnected", (e) => toast(`Gamepad found: ${e.gamepad.id.slice(0, 40)}. It drives joystick port 2.`, "ok"));

async function boot() {
  for (const [name, m] of Object.entries({ top, stage, left, dock, right, hub })) { try { m.init(); } catch (e) { console.error(`init ${name}:`, e); } }
  on("settings", applyUI);
  on("machines", () => { resubscribe(); });
  connect();
  requestAnimationFrame(pollPad);
  try { const a = await get("/api/agent"); Object.assign(S.agent, a); emit("agent"); } catch { /* old server */ }
  on("settings", async () => { try { Object.assign(S.agent, await get("/api/agent")); emit("agent"); } catch { /* ignore */ } });
  // first run: no machine at all, or never welcomed
  setTimeout(() => { if (!S.machines.length || (S.settings && !S.settings.firstRunDone && !S.machines.some((m) => m.running))) actions["welcome"](); }, 900);
}
boot();
window.__S = S; // for tests and for poking around in the console
