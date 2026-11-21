// The agent, beside the picture and never over it. It has two modes and one stop key:
//   ASSIST: it watches (local rules, free) and, when you seem stuck, a card slides in beside the screen:
//           "I see you are trying to ... Do it for me / Guide me". Eager at first, learns, one key to quiet.
//   DRIVE:  you type what you want in the prompt; the agent drives the real machine through the real
//           keyboard where you can watch. Everything it does lands in the feed, and anything it does NOT
//           do through the machine's own inputs is labelled HOST STEP.
//   STOP:   throws away everything queued and lets go of every key, instantly.
import { S, on, send, get, post, actions, toast, machine, esc } from "./net.js";
import { icon } from "./icons.js";
import { blip } from "./sounds.js";

const TAGS = { machine: "ON C64", host: "HOST STEP", say: "AGENT", hint: "HINT", note: "NOTE", error: "ERROR", user: "YOU" };
let seenCards = new Set();

export function init() {
  const el = document.getElementById("right");
  el.innerHTML = `<div class="glass agent">
    <div class="agent-head"><span class="thinking" id="think" hidden></span><span class="who" id="who">Agent</span><span class="spacer"></span>
      <div class="seg" id="modeseg" role="group" aria-label="Assist mode"></div></div>
    <div class="cards" id="cards"></div>
    <div class="panel-h"><span>Activity</span><span class="sub" id="feedsub">everything it does shows here</span></div>
    <div class="feed scroll" id="feed" aria-live="polite"></div>
    <div class="prompt">
      <div class="chips" id="chips"></div>
      <textarea id="prompt" placeholder="Tell the agent what to make or do on this C64…  (Enter to send, Shift+Enter for a new line)" aria-label="Prompt for the agent"></textarea>
      <div class="row"><button class="btn primary" style="flex:1" data-act="agent-send" id="sendbtn">${icon("play")} Drive the C64</button><button class="btn stopbtn" data-act="stop" id="stopbtn" title="Stop: throw away everything queued and let go of the keys (Esc in the prompt)">${icon("stop")} STOP</button></div>
    </div></div>`;
  const ta = el.querySelector("#prompt");
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); actions["agent-send"](); }
    if (e.key === "Escape") { actions["stop"](); }
    e.stopPropagation();
  });
  on("machines", () => { renderHead(); renderFeed(true); renderCards(); });
  on("settings", renderHead);
  on("feed", (n) => { if (n === S.current) renderFeed(); });
  on("cards", (n) => { if (n === S.current) renderCards(); });
  on("agent", () => renderHead());
  renderHead(); renderFeed(true); renderCards();
}

function renderHead() {
  const s = S.settings; if (!s) return;
  const a = S.agent, run = a.running?.[S.current];
  document.getElementById("who").textContent = a.current ? a.current.name : "No agent found";
  document.getElementById("think").hidden = !run;
  document.getElementById("modeseg").innerHTML = ["eager", "quiet", "off"].map((m) => `<button aria-pressed="${s.agent.assist === m}" data-act="assist" data-mode="${m}" title="${m === "eager" ? "Speaks up when you look stuck; learns and backs off" : m === "quiet" ? "Only speaks when you ask" : "Never watches"}">${m}</button>`).join("");
  const stop = document.getElementById("stopbtn"), send_ = document.getElementById("sendbtn");
  stop.hidden = !run; send_.disabled = !!run || !machine()?.running || !a.current;
  send_.innerHTML = run ? "Working…" : `${icon("play")} Drive the C64`;
  document.getElementById("chips").innerHTML = (machine()?.running ? ["Write a program that bounces a ball", "Explain the last error", "Draw a border that changes colour", "Make a sprite and move it"] : []).map((c) => `<button class="btn sm ghost" data-act="chip" data-text="${esc(c)}" style="border-color:var(--line)">${esc(c)}</button>`).join("");
  document.getElementById("prompt").disabled = !machine()?.running || !a.current;
  document.getElementById("prompt").placeholder = !a.current ? "No agent found. Open Settings > Agent to set one up." : machine()?.running ? "Tell the agent what to make or do on this C64…  (Enter to send, Shift+Enter for a new line)" : "Power the machine on to give the agent a C64 to drive.";
}

function renderFeed(replace) {
  const el = document.getElementById("feed"), items = S.feed[S.current] ?? [];
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = items.length ? items.map((i) => `<div class="fi ${i.kind}"><span class="tag">${TAGS[i.kind] ?? i.kind}</span><span>${fmt(i.text)}${i.via ? ` <span class="via">via ${esc(i.via)}</span>` : ""}</span></div>`).join("") : `<div class="dim sm" style="padding:6px">Nothing yet. Ask the agent for something, or just type on the C64: it is watching quietly and will only speak up if you seem stuck.</div>`;
  if (near || replace) el.scrollTop = el.scrollHeight;
}
const fmt = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>");

function renderCards() {
  const el = document.getElementById("cards"), cards = (S.cards[S.current] ?? []).slice(0, 2);
  for (const c of cards) if (!seenCards.has(c.id)) { seenCards.add(c.id); blip(); }
  el.innerHTML = cards.map((c) => `<div class="card" role="alert"><div class="t">${fmt(c.title)}</div><div class="b">${fmt(c.body)}</div><div class="row wrap">${c.actions.map((a, i) => `<button class="btn sm ${i === 0 ? "primary" : ""}" data-act="card" data-id="${esc(c.id)}" data-action="${esc(a.id)}">${esc(a.label)}</button>`).join("")}</div></div>`).join("");
}

actions["assist"] = async (el) => { try { await fetch("/api/settings", { method: "PUT", headers: { "x-nix64": "1", "content-type": "application/json" }, body: JSON.stringify({ agent: { assist: el.dataset.mode } }) }); } catch (e) { toast(e.message, "error"); } };
actions["quiet"] = () => { if (!S.settings) return; const m = S.settings.agent.assist === "quiet" ? "eager" : "quiet"; actions["assist"]({ dataset: { mode: m } }); toast(m === "quiet" ? "Quiet: the agent will only speak when you ask." : "The agent will speak up when you look stuck."); };
actions["chip"] = (el) => { const ta = document.getElementById("prompt"); ta.value = el.dataset.text; ta.focus(); };
actions["stop"] = () => send({ t: "stop", name: S.current });
actions["card"] = (el) => send({ t: "card", name: S.current, id: el.dataset.id, action: el.dataset.action });
actions["agent-send"] = async () => {
  const ta = document.getElementById("prompt"), text = ta.value.trim();
  if (!text) return;
  try { await post(`/api/machines/${S.current}/agent/prompt`, { text }); ta.value = ""; } catch (e) { toast(e.message, "error"); }
};
