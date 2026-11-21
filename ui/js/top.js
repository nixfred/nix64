// The top bar: logo, machine tabs, Hub, and the quick switches.
import { S, on, machine, esc } from "./net.js";
import { icon } from "./icons.js";
import { logo } from "./logo.js";

export function init() {
  const el = document.getElementById("top");
  render();
  on("machines", render); on("conn", render); on("settings", render); on("agent", render);
  el.addEventListener("keydown", (e) => {
    const tabs = [...el.querySelectorAll(".tab")];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === "ArrowRight") { tabs[(i + 1) % tabs.length].focus(); e.preventDefault(); }
    if (e.key === "ArrowLeft") { tabs[(i - 1 + tabs.length) % tabs.length].focus(); e.preventDefault(); }
  });
}

function render() {
  const el = document.getElementById("top");
  const s = S.settings;
  const tabs = S.machines.map((m, i) => `<button class="tab" role="tab" data-act="select" data-name="${esc(m.name)}" aria-selected="${S.view === "machine" && m.name === S.current}" title="${esc(m.description)}${m.running ? "" : " (off)"}"><span class="dot ${m.running ? (m.fps > 1 ? "on" : "boot") : ""}"></span>${esc(m.name)}</button>`).join("");
  const assist = s?.agent.assist ?? "eager";
  el.innerHTML = `
    <div class="logo" aria-hidden="true">${logo(20)}<small>READY.</small></div>
    <nav class="tabs" role="tablist" aria-label="Machines">${tabs}<button class="tab" data-act="new-machine" title="Make a new machine (one file)" aria-label="New machine">${icon("plus")}</button></nav>
    <button class="btn sm" data-act="hub" aria-pressed="${S.view === "hub"}" title="All your machines at once (F9)">${icon("hub")} Hub</button>
    <span class="spacer"></span>
    ${s ? `<span class="chip ${assist === "eager" ? "info" : ""}" title="Agent: ${assist}">${icon("spark", .9)} ${assist === "off" ? "agent off" : assist === "quiet" ? "quiet" : "assist"}</span>` : ""}
    <button class="btn sm ghost" data-act="quiet" title="Quiet switch: the agent only speaks when asked">${icon(assist === "quiet" ? "bell-off" : "bell")} Quiet</button>
    <span class="chip ${S.connected ? "ok" : "bad"}" title="Connection to the Nix64 server">${S.connected ? "● live" : "○ offline"}</span>
    <button class="btn sm ghost icon" data-act="mute" title="UI sounds">${icon(s?.sound.muted ? "volume-off" : "volume")}</button>
    <button class="btn sm ghost icon" data-act="docs" title="Manual" aria-label="Manual">${icon("help")}</button>
    <button class="btn sm ghost icon" data-act="settings" title="Settings" aria-label="Settings">${icon("gear")}</button>`;
}
