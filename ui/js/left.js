// The left rail: this machine, its drives, tape and cartridge, and the shelf of media you own.
import { S, on, actions, get, post, del, toast, machine, esc } from "./net.js";
import { icon } from "./icons.js";

let drives = [], media = { tape: null, cart: null }, freezes = [], lastFor = "", shelfFilter = "";

export function init() {
  const el = document.getElementById("left");
  el.innerHTML = `<div class="glass panel mcard" id="mcard"></div><div class="glass panel" id="drives"></div><div class="glass panel" id="tapecart"></div><div class="glass panel grow" id="shelf"></div>`;
  on("machines", () => { render(); refresh(); });
  on("settings", render);
  on("msg:media", () => refresh(true));
  actions["select-shelf-filter"] = null;
  el.addEventListener("input", (e) => {
    if (e.target.id !== "shelf-filter") return;
    const pos = e.target.selectionStart ?? e.target.value.length; // the panel is rebuilt, so put the caret back where it was
    shelfFilter = e.target.value;
    renderShelf();
    const f = document.getElementById("shelf-filter");
    if (f) { f.focus(); f.setSelectionRange(pos, pos); }
  });
  el.addEventListener("dragstart", (e) => { const r = e.target.closest("[data-shelf]"); if (r) e.dataTransfer.setData("text/nix64-shelf", r.dataset.shelf); });
  for (const type of ["dragover", "dragleave", "drop"]) el.addEventListener(type, (e) => {
    const slot = e.target.closest("[data-slot]");
    if (!slot || !e.dataTransfer?.types.includes("text/nix64-shelf")) return;
    e.preventDefault();
    slot.classList.toggle("drop", type === "dragover");
    if (type === "drop") insert(slot.dataset.slot, e.dataTransfer.getData("text/nix64-shelf"));
  });
  render(); refresh(true); loadShelf();
}

export async function loadShelf() {
  try { S.shelf = (await get("/api/shelf")).items; renderShelf(); } catch { /* server too old */ }
}

async function refresh(force) {
  const name = S.current;
  if (!name) return;
  if (!force && lastFor === name + (machine()?.running ? "1" : "0") + (machine()?.gen)) return;
  lastFor = name + (machine()?.running ? "1" : "0") + (machine()?.gen);
  try {
    const d = await get(`/api/machines/${name}/drives`);
    if (name !== S.current) return;
    drives = d.drives; media = d.media; freezes = d.freezes ?? [];
    renderDrives(); renderTapeCart(); renderCard();
  } catch (e) { /* machine has no file yet */ }
}

function render() { renderCard(); renderDrives(); renderTapeCart(); renderShelf(); }

function renderCard() {
  const el = document.getElementById("mcard"), m = machine();
  if (!el) return;
  if (!m) { el.innerHTML = `<h3>Machine</h3><p class="dim sm">No machines yet.</p><button class="btn primary" data-act="new-machine">${icon("plus")} New machine</button>`; return; }
  const fz = [1, 2, 3, 4].map((n) => { const f = freezes.find((x) => x.slot === n); return `<button class="btn sm" data-act="freeze" data-slot="${n}" ${m.running ? "" : f ? "" : "disabled"} title="${f ? `Slot ${n}: saved ${new Date(f.time).toLocaleString()}. Click to ${m.running ? "restore (Shift+click saves over it)" : "restore after power on"}` : `Slot ${n}: empty. Click to freeze the whole machine here`}">${f ? icon("snow", .9) : "·"} ${n}</button>`; }).join("");
  el.innerHTML = `
    <div class="panel-h"><span>Machine</span><span class="sub">gen ${m.gen} · ${esc(m.hash)}</span></div>
    <div class="row" style="justify-content:space-between"><h2 class="trunc">${esc(m.name)}</h2><span class="chip ${m.running ? "ok" : ""}">${m.running ? "ON" : "OFF"}</span></div>
    <div class="desc trunc" title="${esc(m.description)}">${esc(m.description || "")}</div>
    <dl class="kv"><dt>Model</dt><dd>${esc(m.model.toUpperCase())} · ${esc(m.region.toUpperCase())}</dd><dt>SID</dt><dd>${esc(m.sid)}</dd></dl>
    <div class="row wrap"><span class="faint sm mono">FREEZE</span>${fz}</div>
    <div class="btns"><button class="btn sm" data-act="edit-machine">${icon("edit")} Machine file</button><button class="btn sm" data-act="devices">${icon("plug")} Devices</button></div>
    ${m.problems.length ? `<div class="problems">${esc(m.problems[0])}</div>` : ""}`;
}

const kindOf = (n) => (/\.(d64|d71|d81|g64|x64)$/i.test(n) ? "disk" : /\.(tap|t64)$/i.test(n) ? "tape" : /\.(crt|bin)$/i.test(n) ? "cart" : /\.prg$/i.test(n) ? "prg" : "file");
const kicon = (k) => icon(({ disk: "disk", tape: "tape", cart: "cart", prg: "play", sid: "music", file: "file", snapshot: "snow" })[k] ?? "file");

function renderDrives() {
  const el = document.getElementById("drives"), m = machine();
  if (!el) return;
  if (!m) { el.innerHTML = ""; return; }
  const rows = drives.map((d) => {
    let name = "", meta = "";
    if (d.mode === "image") { name = d.disk ? `“${esc(d.disk.name)}”` : "empty"; meta = d.disk ? `${esc(d.type)} · ${d.disk.entries.length} files · ${d.disk.blocksFree} free` : esc(d.type); }
    else if (d.mode === "folder") { name = esc(d.folder?.split("/").pop() ?? "folder"); meta = `${esc(d.type)} · host folder`; }
    else if (d.mode === "real") { name = "real drive"; meta = `${esc(d.type)} · needs a ZoomFloppy`; }
    return `<div class="slot ${d.mode === "image" && !d.disk ? "empty" : ""}" data-slot="${d.slot}">
      <div class="num">${d.slot}</div>
      <div class="col" style="gap:1px;min-width:0"><div class="name trunc">${name}</div><div class="meta trunc">${meta}</div></div>
      <div class="row" style="gap:3px">${d.mode === "image" ? `<button class="btn sm icon" data-act="drive-dir" data-slot="${d.slot}" title="Directory, history, export">${icon("list")}</button><button class="btn sm icon" data-act="drive-eject" data-slot="${d.slot}" title="Eject the disk" ${d.disk ? "" : "disabled"}>${icon("eject")}</button>` : ""}</div></div>`;
  }).join("");
  el.innerHTML = `<div class="panel-h"><span>Drives</span><span class="sub">drag a disk onto a slot</span></div>${rows || `<div class="dim sm">No drives in this machine.</div>`}`;
}

function renderTapeCart() {
  const el = document.getElementById("tapecart");
  if (!el) return;
  const row = (kind, label, item) => `<div class="slot ${item ? "" : "empty"}" data-media="${kind}"><div class="num">${icon(kind === "tape" ? "tape" : "cart", 1.3)}</div><div class="col" style="gap:1px;min-width:0"><div class="name trunc">${item ? esc(item.name) : `no ${label}`}</div><div class="meta">${label}</div></div>${item ? `<button class="btn sm icon" data-act="media-eject" data-kind="${kind}" title="Remove">${icon("eject")}</button>` : ""}</div>`;
  el.innerHTML = `<div class="panel-h"><span>Tape · Cartridge</span></div>${row("tape", "datasette", media.tape)}${row("cart", "cartridge port", media.cart)}`;
}

function renderShelf() {
  const el = document.getElementById("shelf");
  if (!el) return;
  const q = shelfFilter.toLowerCase();
  const items = S.shelf.filter((i) => !q || i.name.toLowerCase().includes(q));
  el.innerHTML = `<div class="panel-h"><span>Shelf</span><span class="sub">${S.shelf.length} items</span></div>
    <input class="field" id="shelf-filter" placeholder="Search your shelf" value="${esc(shelfFilter)}" aria-label="Search the shelf">
    <div class="grow scroll col" style="gap:3px" id="shelf-list">${items.map((i) => `<div class="slot" draggable="true" data-shelf="${esc(i.name)}" style="grid-template-columns:22px 1fr auto;padding:4px 6px"><div style="text-align:center">${kicon(i.kind)}</div><div class="col" style="gap:0;min-width:0"><div class="name trunc sm" title="${esc(i.name)}">${esc(i.name)}</div><div class="meta trunc" title="${esc(i.title ?? "")}">${i.kind} · ${(i.size / 1024).toFixed(0)} KB${i.title ? " · " + esc(i.title.split(" · ")[0]) : ""}</div></div><button class="btn sm icon" data-act="shelf-item" data-name="${esc(i.name)}" title="Use this">${icon("back")}</button></div>`).join("") || `<div class="dim sm" style="padding:6px">${S.shelf.length ? "Nothing matches." : "Your shelf is empty. Drop a disk, tape or cartridge image onto the window, or import one."}</div>`}</div>
    <div class="row"><button class="btn sm" style="flex:1" data-act="shelf-import">${icon("upload")} Import</button><button class="btn sm" style="flex:1" data-act="shelf-open">${icon("search")} Library</button></div>`;
}

// ---------- actions ----------

async function insert(slot, name) {
  if (!name) return;
  try {
    await post(`/api/machines/${S.current}/drives/${slot}/insert`, { shelf: name });
    toast(`Inserted ${name} in drive ${slot}.`, "ok");
    await refresh(true);
  } catch (e) { toast(e.message, "error"); }
}
export { insert as insertDisk };

actions["drive-eject"] = async (el) => { try { await post(`/api/machines/${S.current}/drives/${el.dataset.slot}/eject`); await refresh(true); } catch (e) { toast(e.message, "error"); } };
actions["media-eject"] = async (el) => { try { await post(`/api/machines/${S.current}/media/${el.dataset.kind}`, { eject: true }); await refresh(true); } catch (e) { toast(e.message, "error"); } };
actions["freeze"] = async (el, ev) => {
  const slot = Number(el.dataset.slot), has = freezes.find((x) => x.slot === slot);
  try {
    if (has && !ev.shiftKey) { await post(`/api/machines/${S.current}/thaw`, { slot }); toast(`Restored freeze slot ${slot}.`, "ok"); }
    else { await post(`/api/machines/${S.current}/freeze`, { slot }); toast(`Machine frozen in slot ${slot}.`, "ok"); }
    await refresh(true);
  } catch (e) { toast(e.message, "error"); }
};
actions["shelf-import"] = () => { const i = document.createElement("input"); i.type = "file"; i.multiple = true; i.onchange = () => importFiles([...i.files]); i.click(); };

export async function importFiles(files) {
  for (const f of files) {
    try {
      const res = await fetch("/api/shelf/import", { method: "POST", headers: { "x-nix64": "1", "x-filename": encodeURIComponent(f.name) }, body: f });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      toast(`Added ${j.name} to the shelf.`, "ok");
    } catch (e) { toast(`${f.name}: ${e.message}`, "error"); }
  }
  await loadShelf();
}

// a click on a shelf item: choose what to do with it
actions["shelf-item"] = (el) => {
  const name = el.dataset.name, kind = kindOf(name), m = machine();
  const opts = [];
  if (kind === "disk") for (const d of drives.filter((x) => x.mode === "image")) opts.push([`Insert in drive ${d.slot}`, () => insert(d.slot, name)]);
  if (kind === "disk" || kind === "prg") opts.push(["Load and run (types LOAD for you)", async () => { try { await post(`/api/machines/${S.current}/run`, { shelf: name }); toast(`Loading ${name}…`, "ok"); await refresh(true); } catch (e) { toast(e.message, "error"); } }]);
  if (kind === "tape") opts.push(["Put in the datasette", async () => { try { await post(`/api/machines/${S.current}/media/tape`, { shelf: name }); await refresh(true); } catch (e) { toast(e.message, "error"); } }]);
  if (kind === "cart") opts.push(["Put in the cartridge port", async () => { try { await post(`/api/machines/${S.current}/media/cart`, { shelf: name }); await refresh(true); } catch (e) { toast(e.message, "error"); } }]);
  opts.push(["Remove from the shelf…", async () => { if (confirm(`Remove ${name} from your shelf? The file is deleted.`)) { try { await del(`/api/shelf/${encodeURIComponent(name)}`); await loadShelf(); } catch (e) { toast(e.message, "error"); } } }]);
  openMenu(el, name, opts, !!m?.running);
};

function openMenu(anchor, title, opts, running) {
  document.getElementById("ctxmenu")?.remove();
  const m = document.createElement("div");
  m.id = "ctxmenu"; m.className = "glass"; m.style.cssText = "position:fixed;z-index:15;padding:6px;display:flex;flex-direction:column;gap:3px;min-width:240px";
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.min(r.right + 6, innerWidth - 260)}px`; m.style.top = `${Math.min(r.top, innerHeight - 40 - opts.length * 34)}px`;
  m.innerHTML = `<div class="faint sm mono trunc" style="padding:3px 8px">${esc(title)}</div>` + opts.map((o, i) => `<button class="btn sm ghost" style="justify-content:flex-start" data-i="${i}" ${running || /Remove/.test(o[0]) ? "" : "disabled"}>${esc(o[0])}</button>`).join("") + (running ? "" : `<div class="faint sm" style="padding:3px 8px">Power the machine on to use media.</div>`);
  m.onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) { m.remove(); opts[b.dataset.i][1](); } };
  document.body.append(m);
  setTimeout(() => document.addEventListener("pointerdown", function h(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", h); } }), 0);
}
