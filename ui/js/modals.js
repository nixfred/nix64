// Dialogs: settings, the machine file editor, a new machine, the first-run welcome, the manual, the
// credits, the shelf library and the devices. Every one fits on one screen: lists scroll inside their box.
import { S, on, actions, get, post, put, toast, machine, esc, api } from "./net.js";
import { icon } from "./icons.js";
import { logo } from "./logo.js";
import { loadShelf, importFiles } from "./left.js";

const modal = () => document.getElementById("modal");
export function open(html, cls = "") {
  const m = modal();
  m.innerHTML = `<div class="glass dialog ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  m.onclick = (e) => { if (e.target === m) close(); };
  m.querySelector("input,textarea,select,button.primary")?.focus();
}
export function close() { modal().hidden = true; modal().innerHTML = ""; S.modal = null; }
const head = (title, extra = "") => `<div class="dialog-h"><h2>${title}</h2>${extra}<button class="btn sm ghost icon" data-act="close" aria-label="Close">${icon("x")}</button></div>`;
actions["close"] = close;
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal().hidden) { e.preventDefault(); e.stopPropagation(); close(); } }, true);

// ---------- settings ----------

const row = (label, hint, ctl) => `<div class="setrow"><div>${label}${hint ? `<small>${hint}</small>` : ""}</div>${ctl}</div>`;
const tg = (id, on_) => `<input type="checkbox" class="toggle" id="${id}" ${on_ ? "checked" : ""}>`;
const rg = (id, v, a, b) => `<input type="range" id="${id}" min="${a}" max="${b}" value="${v}">`;

actions["settings"] = () => {
  const s = S.settings, d = s.display, a = s.agent, det = S.agent.detected ?? [];
  S.modal = "settings";
  open(`${head("Settings")}<div class="dialog-b cols3">
    <div class="setgrp"><div class="panel-h">Look</div>
      ${row("Interface size", "Scales every panel", rg("set-scale", d.scale, 70, 200))}
      ${row("CRT look", "Scanlines, phosphor mask, glow, curvature", tg("set-crt", d.crt))}
      ${row("CRT strength", "0 is a flat, exact picture", rg("set-crtStrength", d.crtStrength, 0, 100))}
      ${row("Monitor bezel", "The frame around the tube", tg("set-bezel", d.bezel))}
      ${row("Reduce motion", "No pulses, slides or roll", `<select class="select" id="set-reducedMotion">${["auto", "on", "off"].map((x) => `<option ${d.reducedMotion === x ? "selected" : ""}>${x}</option>`).join("")}</select>`)}
      ${row("High contrast", "Black panels, white lines", tg("set-highContrast", d.highContrast))}
    </div>
    <div class="setgrp"><div class="panel-h">Sound and keys</div>
      ${row("Interface sounds", "Key click, card blip (made in the browser)", tg("set-ui", s.sound.ui))}
      ${row("Mute interface sounds", "The machine's own sound is not affected", tg("set-muted", s.sound.muted))}
      ${row("Keys as a joystick", "Arrow keys + Space drive port 2 (Ctrl+J toggles)", tg("set-joystickKeys", s.keys.joystickKeys))}
      <div class="faint sm" style="line-height:1.5">The host keyboard is <b>symbolic</b>: what you type is what appears, as in VICE's own keymap. Esc is RUN/STOP, Tab is CTRL, Alt is the Commodore key, Page Up is RESTORE, Home is HOME, Shift+Home is CLR. Real C64 keyboards on USB (Keyrah) are positional: that mode needs the hardware and is not wired yet.</div>
      <div class="sep"></div>
      <div class="row wrap"><button class="btn sm" data-act="docs">Manual</button><button class="btn sm" data-act="credits">Credits</button><button class="btn sm" data-act="welcome">Welcome tour</button></div>
    </div>
    <div class="setgrp"><div class="panel-h">Agent</div>
      ${row("Which agent", det.length ? `Found: ${det.map((x) => esc(x.name)).join(", ")}` : "None found: see the setup box below", `<select class="select" id="set-choice"><option value="auto" ${a.choice === "auto" ? "selected" : ""}>auto (first found)</option>${det.map((x) => `<option value="${esc(x.id)}" ${a.choice === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`)}
      ${row("Model", "Empty uses the agent's own default", `<input class="field" id="set-model" style="width:150px" value="${esc(a.model)}" placeholder="default">`)}
      ${row("Local model server", (S.agent.local ?? []).map((l) => `${l.name} ${l.up ? "● up" : "○ not running"}`).join(" · ") || "Ollama or LM Studio", `<input class="field" id="set-localEndpoint" style="width:150px" value="${esc(a.localEndpoint)}" placeholder="http://127.0.0.1:11434">`)}
      ${row("Assist", "Eager: speaks up when you look stuck, learns, backs off", `<select class="select" id="set-assist">${["eager", "quiet", "off"].map((x) => `<option ${a.assist === x ? "selected" : ""}>${x}</option>`).join("")}</select>`)}
      ${row("Typing speed", "Keys per second when it types for you", `<span class="mono sm" id="ts">${a.typingSpeed}</span>${rg("set-typingSpeed", a.typingSpeed, 5, 120)}`)}
      <div class="faint sm" style="line-height:1.5">${det.length ? "Nix64 uses the agent already on this computer: Omarchy ships Claude Code, and Codex, pi, opencode and Crush are found too. To run on your own machine use Omarchy's Install > AI > Ollama or LM Studio, then set its address above." : "No agent program was found. On Omarchy, Claude Code is installed with the system. Otherwise install one (claude, codex, pi, opencode or crush) or set up a local model with Omarchy's Install > AI menu."}</div>
    </div></div>
    <div class="dialog-h" style="border-top:1px solid var(--line);border-bottom:0"><span class="faint sm">Changes apply as you make them.</span><span style="flex:1"></span><button class="btn primary" data-act="close">Done</button></div>`, "fit");
  const m = modal();
  let t;
  m.oninput = m.onchange = (e) => {
    const id = e.target.id;
    if (!id?.startsWith("set-")) return;
    const k = id.slice(4), v = e.target.type === "checkbox" ? e.target.checked : e.target.type === "range" || k === "typingSpeed" ? Number(e.target.value) : e.target.value;
    if (k === "typingSpeed") document.getElementById("ts").textContent = v;
    const patch = { display: {}, sound: {}, keys: {}, agent: {} };
    if (["scale", "crt", "crtStrength", "bezel", "reducedMotion", "highContrast"].includes(k)) patch.display[k] = v;
    else if (["ui", "muted"].includes(k)) patch.sound[k] = v;
    else if (k === "joystickKeys") patch.keys[k] = v;
    else patch.agent[k === "assist" ? "assist" : k] = v;
    clearTimeout(t);
    t = setTimeout(() => put("/api/settings", patch).catch((er) => toast(er.message, "error")), 150);
  };
};

// ---------- machine file ----------

let editorFor = "";
actions["edit-machine"] = async () => {
  const name = S.current; if (!name) return;
  editorFor = name;
  try {
    const f = await get(`/api/machines/${name}/file`);
    open(`${head(`Machine file: ${esc(name)}`, `<span class="chip">gen ${f.current}</span>`)}
      <div class="dialog-b" style="grid-template-columns:minmax(0,1fr) 250px">
        <textarea class="editor" id="ed" spellcheck="false" aria-label="Machine file">${esc(f.text)}</textarea>
        <div class="col" style="min-height:0"><div class="panel-h">Generations</div><div class="grow scroll col" style="gap:4px">${f.generations.slice().reverse().map((g) => `<div class="slot" style="grid-template-columns:1fr auto"><div><div class="name">#${g.n}${g.n === f.current ? " · current" : ""}</div><div class="meta">${new Date(g.time).toLocaleString()} · ${g.hash}</div></div>${g.n === f.current ? "" : `<button class="btn sm" data-act="rollback" data-gen="${g.n}">Roll back</button>`}</div>`).join("")}</div>
        <div class="problems" id="edp"></div></div></div>
      <div class="dialog-h" style="border-top:1px solid var(--line);border-bottom:0"><span class="faint sm">One file is the whole machine. Media you name here is pinned by SHA-256.</span><span style="flex:1"></span><button class="btn" data-act="close">Cancel</button><button class="btn" data-act="save-machine" data-apply="0">Save</button><button class="btn primary" data-act="save-machine" data-apply="1">Save and apply</button></div>`);
  } catch (e) { toast(e.message, "error"); }
};
actions["save-machine"] = async (el) => {
  try {
    const r = await put(`/api/machines/${editorFor}/file`, { text: document.getElementById("ed").value, apply: el.dataset.apply === "1" });
    toast(r.note ?? (r.changed ? `Generation ${r.gen} made.` : "Saved."), "ok"); close();
  } catch (e) { document.getElementById("edp").innerHTML = e.problems ? e.problems.map((p) => `• ${esc(p)}`).join("<br>") : esc(e.message); }
};
actions["rollback"] = async (el) => { try { await post(`/api/machines/${editorFor}/rollback`, { gen: Number(el.dataset.gen) }); toast(`Rolled back to generation ${el.dataset.gen}. Restart the machine to run it.`, "ok"); actions["edit-machine"](); } catch (e) { toast(e.message, "error"); } };

// ---------- new machine, welcome ----------

actions["new-machine"] = () => open(`${head("New machine")}<div class="dialog-b" style="grid-template-columns:1fr">
  <div class="setgrp"><div class="setrow"><div>Name<small>Lowercase letters, digits, - _ .</small></div><input class="field" id="nm" style="width:220px" placeholder="breadbox" maxlength="40"></div>
  <div class="setrow"><div>Starting point<small>You can change everything in the file afterwards</small></div><select class="select" id="np"><option value="c64c-pal">C64C, PAL, 1541-II (stock)</option><option value="breadbin-pal">Breadbin, PAL, 1541, 6581</option><option value="c64c-ntsc">C64C, NTSC (USA), 1541-II</option><option value="gs">C64 Games System, NTSC, no drive</option></select></div>
  <div class="setrow"><div>Description</div><input class="field" id="nd" style="width:220px" placeholder="optional"></div></div></div>
  <div class="dialog-h" style="border-top:1px solid var(--line);border-bottom:0"><span style="flex:1"></span><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="make-machine">Make it and switch on</button></div>`, "sm");
actions["make-machine"] = async () => {
  const name = document.getElementById("nm").value.trim().toLowerCase();
  try {
    await post("/api/machines", { name, preset: document.getElementById("np").value, description: document.getElementById("nd").value || undefined });
    close();
    S.current = name; S.view = "machine"; document.documentElement.dataset.view = "machine"; window.dispatchEvent(new Event("nix64-select"));
    toast(`Made ${name}. Switching it on…`);
    await post(`/api/machines/${name}/start`);
  } catch (e) { toast(e.message, "error"); }
};
actions["welcome"] = () => open(`<div class="welcome">${`<div class="logo">${logo(54)}</div>`}<h1>READY.</h1>
  <p>A real Commodore 64 in a window, with a real AI agent that can sit beside you or drive it while you watch. Every machine is one small file. Nothing here is faked: if something cannot be done for real yet, it says so.</p>
  <p class="faint sm">Click the screen to type. Esc is RUN/STOP. Ask the agent for anything in the box on the right.</p>
  <div class="row"><button class="btn primary" data-act="first-machine">Make my first C64</button><button class="btn" data-act="close">I'll look around</button></div></div>`, "sm");
actions["first-machine"] = async () => {
  const name = S.machines.length ? `c64-${S.machines.length + 1}` : "breadbox";
  try {
    await post("/api/machines", { name, preset: "c64c-pal", description: "My first Commodore 64." });
    close(); S.current = name; window.dispatchEvent(new Event("nix64-select"));
    await post(`/api/machines/${name}/start`);
    await put("/api/settings", { firstRunDone: true });
  } catch (e) { toast(e.message, "error"); }
};

// ---------- manual, credits ----------

const DOCS = [["start", "Getting started"], ["keyboard", "The keyboard"], ["machines", "Machines and files"], ["disks", "Drives and disks"], ["agent", "The agent"], ["hardware", "Real hardware"], ["shortcuts", "Shortcuts"], ["trouble", "Troubleshooting"]];
actions["docs"] = (el, ev, topic = "start") => {
  open(`${head("Manual")}<div class="dialog-b" style="grid-template-columns:200px minmax(0,1fr)"><nav class="col scroll" style="gap:3px">${DOCS.map(([id, t]) => `<button class="btn ${id === topic ? "primary" : "ghost"}" style="justify-content:flex-start" data-act="doc-topic" data-topic="${id}">${t}</button>`).join("")}</nav><div class="scroll glass" style="padding:16px 20px;line-height:1.65" id="doc">Loading…</div></div>`);
  fetch(`/docs/${topic}.html`).then((r) => r.text()).then((h) => { document.getElementById("doc").innerHTML = h; });
};
actions["doc-topic"] = (el) => actions["docs"](el, null, el.dataset.topic);
actions["credits"] = async () => {
  const h = await fetch("/docs/credits.html").then((r) => r.text());
  open(`${head("Credits")}<div class="dialog-b" style="grid-template-columns:1fr"><div class="credits"><div class="roll">${h}</div></div></div>`, "");
};

// ---------- shelf library, devices ----------

let archiveResults = [];
actions["shelf-open"] = async () => {
  await loadShelf();
  open(`${head("Library", `<span class="chip">${S.shelf.length} items</span>`)}
    <div class="dialog-b" style="grid-template-columns:minmax(0,1fr) 380px">
      <div class="col" style="min-height:0"><div class="panel-h">Your shelf <span class="sub">${esc("~/Nix64/shelf")}</span></div>
        <div class="grow scroll"><table class="t"><tr><th>Name</th><th>Kind</th><th>Size</th><th>SHA-256</th><th>Title / directory</th></tr>${S.shelf.map((i) => `<tr><td class="mono">${esc(i.name)}</td><td>${i.kind}</td><td>${(i.size / 1024).toFixed(0)} KB</td><td class="mono faint">${esc(i.sha.slice(0, 10))}</td><td class="faint">${esc(i.title ?? "")}</td></tr>`).join("") || `<tr><td colspan=5 class="dim">Nothing yet.</td></tr>`}</table></div>
        <div class="row"><button class="btn" data-act="shelf-import">${icon("upload")} Import files…</button><span class="faint sm">Drop files onto the window too. Nix64 never bundles ROMs or commercial software: what is on your shelf is what you put there.</span></div></div>
      <div class="col" style="min-height:0"><div class="panel-h">Internet Archive</div>
        <div class="faint sm" style="line-height:1.45">Search and fetch media yourself. You choose what to download; make sure you own it or may have it.</div>
        <div class="row"><input class="field" id="aq" placeholder="e.g. Buck Rogers Planet of Zoom" style="flex:1"><button class="btn primary" data-act="archive-search">Search</button></div>
        <div class="chips"><button class="btn sm ghost" data-act="archive-q" data-q="Buck Rogers Planet of Zoom commodore 64">Planet of Zoom</button><button class="btn sm ghost" data-act="archive-q" data-q="Buck Rogers Countdown to Doomsday commodore 64">Countdown to Doomsday</button></div>
        <div class="grow scroll col" id="ares" style="gap:4px"><div class="dim sm">Results appear here.</div></div></div></div>`);
};
actions["archive-q"] = (el) => { document.getElementById("aq").value = el.dataset.q; actions["archive-search"](); };
actions["archive-search"] = async () => {
  const q = document.getElementById("aq").value.trim(), el = document.getElementById("ares");
  if (!q) return;
  el.innerHTML = `<div class="dim sm">Searching…</div>`;
  try {
    archiveResults = (await get(`/api/archive/search?q=${encodeURIComponent(q)}`)).items;
    el.innerHTML = archiveResults.map((r, i) => `<div class="slot" style="grid-template-columns:1fr auto"><div class="col" style="gap:0;min-width:0"><div class="name trunc sm">${esc(r.title)}</div><div class="meta">${esc(r.id)} · ${r.downloads ?? "?"} downloads</div></div><button class="btn sm" data-act="archive-files" data-i="${i}">Files…</button></div>`).join("") || `<div class="dim sm">No results.</div>`;
  } catch (e) { el.innerHTML = `<div class="problems">${esc(e.message)}</div>`; }
};
actions["archive-files"] = async (el) => {
  const r = archiveResults[el.dataset.i], box = document.getElementById("ares");
  box.innerHTML = `<div class="dim sm">Listing ${esc(r.id)}…</div>`;
  try {
    const files = (await get(`/api/archive/files?id=${encodeURIComponent(r.id)}`)).files;
    box.innerHTML = `<button class="btn sm ghost" data-act="archive-search" style="align-self:flex-start">${icon("back")} results</button>` + (files.map((f) => `<div class="slot" style="grid-template-columns:1fr auto"><div class="col" style="gap:0;min-width:0"><div class="name trunc sm" title="${esc(f.name)}">${esc(f.name)}</div><div class="meta">${(f.size / 1024).toFixed(0)} KB</div></div><button class="btn sm" data-act="archive-get" data-id="${esc(r.id)}" data-file="${esc(f.name)}">Fetch</button></div>`).join("") || `<div class="dim sm">No disk, tape or cartridge images in this item.</div>`);
  } catch (e) { box.innerHTML = `<div class="problems">${esc(e.message)}</div>`; }
};
actions["archive-get"] = async (el) => {
  el.disabled = true; el.textContent = "…";
  try { const r = await post("/api/archive/fetch", { id: el.dataset.id, file: el.dataset.file }); toast(`Fetched ${r.name} to the shelf.`, "ok"); el.textContent = "✓"; await loadShelf(); }
  catch (e) { toast(e.message, "error"); el.disabled = false; el.textContent = "Fetch"; }
};

actions["devices"] = async () => {
  open(`${head("Devices", `<span class="faint sm">What is plugged into this computer, and what Nix64 can do with it</span>`)}<div class="dialog-b" style="grid-template-columns:1fr"><div class="scroll" id="devs">Looking…</div></div>`, "fit");
  try {
    const d = await get("/api/devices");
    document.getElementById("devs").innerHTML = `<table class="t"><tr><th>Device</th><th>Found</th><th>How Nix64 uses it</th><th>Status</th></tr>${d.devices.map((x) => `<tr><td><b>${esc(x.name)}</b><div class="faint sm">${esc(x.what)}</div></td><td>${x.found.length ? x.found.map(esc).join("<br>") : `<span class="faint">not plugged in</span>`}</td><td class="sm">${esc(x.how)}</td><td><span class="badge-s ${x.badge}">${esc(x.badgeText)}</span></td></tr>`).join("")}</table>
      <div class="faint sm" style="margin-top:10px;line-height:1.5">Badges: <b>verified</b> means tested on that hardware (with date and model); <b>untested</b> means the path exists in the engine but has not been run against the real thing; <b>not in this build</b> means the engine was built without it. Nothing is ever shown as working that was not tested.</div>`;
  } catch (e) { document.getElementById("devs").innerHTML = `<div class="problems">${esc(e.message)}</div>`; }
};

// ---------- a disk in a drive: directory, history, export ----------

let diskSlot = "";
actions["drive-dir"] = async (el) => {
  diskSlot = el.dataset.slot;
  const name = S.current;
  try {
    const [{ drives }, { history }] = await Promise.all([get(`/api/machines/${name}/drives`), get(`/api/machines/${name}/drives/${diskSlot}/history`)]);
    const d = drives.find((x) => x.slot === diskSlot), dir = d?.disk;
    open(`${head(`Drive ${diskSlot}`, `<span class="chip">${esc(d?.type ?? "")}</span>${dir ? `<span class="chip">“${esc(dir.name)}” ${esc(dir.id)}</span>` : `<span class="chip">empty</span>`}`)}
      <div class="dialog-b" style="grid-template-columns:minmax(0,1fr) 340px">
        <div class="col" style="min-height:0"><div class="panel-h">Directory <span class="sub">${dir ? `${dir.blocksFree} blocks free` : ""}</span></div>
          <div class="grow scroll">${dir ? (dir.entries.length ? `<table class="t"><tr><th>Blocks</th><th>Name</th><th>Type</th></tr>${dir.entries.map((e) => `<tr><td class="mono">${e.blocks}</td><td class="mono">"${esc(e.name)}"</td><td class="mono">${e.type}${e.closed ? "" : "*"}${e.locked ? "<" : ""}</td></tr>`).join("")}</table>` : `<div class="dim" style="padding:10px">A blank, formatted disk: nothing saved on it yet. SAVE"NAME",8 puts a program on it.</div>`) : `<div class="dim" style="padding:10px">No disk in this drive. Drag one from the shelf, or insert a blank one.</div>`}</div>
          <div class="row wrap"><button class="btn" data-act="disk-blank">Insert a blank disk</button><button class="btn" data-act="disk-export" ${dir ? "" : "disabled"}>${icon("upload")} Save a copy to the shelf</button></div></div>
        <div class="col" style="min-height:0"><div class="panel-h">History <span class="sub">writes are kept: nothing is lost</span></div>
          <div class="grow scroll col" style="gap:4px">${history.map((h) => `<div class="slot" style="grid-template-columns:1fr auto"><div><div class="name sm">${new Date(h.time).toLocaleString()}</div><div class="meta">${esc(h.sha)} · ${(h.size / 1024).toFixed(0)} KB</div></div><button class="btn sm" data-act="disk-restore" data-file="${esc(h.file)}">Put back</button></div>`).join("") || `<div class="dim sm" style="padding:6px">The disk has not changed yet. Every earlier state is kept here once it does.</div>`}</div>
          <div class="faint sm" style="line-height:1.45">Disks behave like real disks: a SAVE writes to the disk in the drive. Before anything replaces it, the old contents go to this history.</div></div></div>`);
  } catch (e) { toast(e.message, "error"); }
};
actions["disk-restore"] = async (el) => { try { await post(`/api/machines/${S.current}/drives/${diskSlot}/restore`, { file: el.dataset.file }); toast("Disk put back to that state.", "ok"); close(); window.dispatchEvent(new Event("nix64-select")); } catch (e) { toast(e.message, "error"); } };
actions["disk-export"] = async () => { try { const r = await post(`/api/machines/${S.current}/drives/${diskSlot}/export`, {}); toast(`Saved a copy as ${r.name} on your shelf.`, "ok"); await loadShelf(); } catch (e) { toast(e.message, "error"); } };
actions["disk-blank"] = async () => {
  const label = prompt("Name for the blank disk (up to 16 letters):", "NEW DISK");
  if (label === null) return;
  try { await post(`/api/machines/${S.current}/drives/${diskSlot}/insert`, { blank: label }); toast("Blank disk inserted.", "ok"); close(); window.dispatchEvent(new Event("nix64-select")); } catch (e) { toast(e.message, "error"); }
};
