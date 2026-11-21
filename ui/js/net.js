// State, the socket to the server, and REST. One store; views subscribe to the parts they draw.
export const S = {
  connected: false,
  machines: [],
  mids: Object.create(null),
  settings: null,
  current: null, // the machine in front
  view: "machine", // machine | hub
  status: Object.create(null), // name -> latest status message
  feed: Object.create(null), // name -> feed items
  cards: Object.create(null), // name -> assist cards
  sid: Object.create(null), // name -> the tune playing on that machine (or null)
  guide: Object.create(null), // name -> { keys: [names], text, step }
  agent: { running: {}, detected: [] },
  tool: "keys",
  modal: null,
  shelf: [],
  devices: null,
};

/** click handlers by data-act name: views register theirs here, main.js dispatches */
export const actions = {};

const subs = new Map();
export function on(topic, fn) { (subs.get(topic) ?? subs.set(topic, new Set()).get(topic)).add(fn); return () => subs.get(topic).delete(fn); }
export function emit(topic, arg) { for (const fn of subs.get(topic) ?? []) { try { fn(arg); } catch (e) { console.error(topic, e); } } }

let ws, wantSubs = {}, retry = 0;
export const frameHandlers = new Set(); // (mid, w, h, aspect, lines, frame, palette(48 bytes), pix) for each binary frame

export function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { retry = 0; S.connected = true; emit("conn"); sendSubs(); };
  ws.onclose = () => { S.connected = false; emit("conn"); setTimeout(connect, Math.min(4000, 400 * ++retry)); };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") {
      const b = new Uint8Array(e.data), dv = new DataView(e.data);
      if (b[0] !== 1) return;
      const w = dv.getUint16(2, true), h = dv.getUint16(4, true);
      for (const fn of frameHandlers) fn(b[1], w, h, dv.getUint16(6, true) / 1000, dv.getUint16(8, true), dv.getUint32(10, true), b.subarray(16, 64), b.subarray(64, 64 + w * h));
      return;
    }
    const m = JSON.parse(e.data);
    switch (m.t) {
      case "hello": S.settings = m.settings; S.machines = m.machines; S.mids = m.mids ?? {}; for (const x of m.machines) if (x.mid) S.mids[x.name] = x.mid; ensureCurrent(); emit("settings"); emit("machines"); break;
      case "machines": S.machines = m.list; for (const x of m.list) if (x.mid) S.mids[x.name] = x.mid; ensureCurrent(); emit("machines"); break;
      case "status": S.status[m.name] = m; S.mids[m.name] = m.mid; emit("status", m); break;
      case "settings": S.settings = m.settings; emit("settings"); break;
      case "feed": (S.feed[m.name] ??= []).push(m.item); if (S.feed[m.name].length > 300) S.feed[m.name].shift(); emit("feed", m.name); break;
      case "feed-all": S.feed[m.name] = m.items; emit("feed", m.name); break;
      case "cards": S.cards[m.name] = m.cards; emit("cards", m.name); break;
      case "sid": S.sid[m.name] = m.sid; emit("sid", m.name); break;
      case "guide": S.guide[m.name] = m.guide; emit("guide", m.name); break;
      case "agent": Object.assign(S.agent, m.agent); emit("agent", m.name); break;
      case "toast": toast(m.text, m.kind); break;
      default: emit("msg:" + m.t, m);
    }
  };
}

/** The machine in front: keep it if it still exists, else the first one that is on, else the first. */
function ensureCurrent() {
  if (S.current && S.machines.some((m) => m.name === S.current)) return;
  S.current = (S.machines.find((m) => m.running) ?? S.machines[0])?.name ?? null;
}

export function send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

/** Which machines this window wants pictures of, and how fast: { name: fps }. */
export function subscribe(subs) { wantSubs = subs; sendSubs(); }
function sendSubs() { send({ t: "sub", subs: wantSubs }); }

export async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { "x-nix64": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) { const err = new Error(data.error ?? `HTTP ${res.status}`); err.problems = data.problems; err.status = res.status; err.body = data; throw err; }
  return data;
}
export const get = (p) => api("GET", p), post = (p, b = {}) => api("POST", p, b), put = (p, b) => api("PUT", p, b), del = (p) => api("DELETE", p);

export function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 9000 : 4200);
}
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const machine = (name = S.current) => S.machines.find((m) => m.name === name);
export const running = () => S.machines.filter((m) => m.running);
