// Assist: the agent that watches and speaks up when you look stuck. WATCHING is free and local: rules over
// the machine's own screen and memory, read from shared memory (no stall, no model, no network). A model is
// only used when you ask for it ("Do it for me" on something the rules cannot do themselves).
//
// It is eager at first and learns: each card you wave away makes the next one wait longer; each one you
// use resets it. "Quiet" in the top bar (or Settings) means it never speaks unless asked. Experts who
// type fast and clean never see a card at all, because nothing fires when nothing goes wrong.
import { DIALECT, ERRORS, FIRST_LESSON, dialectHint, type Hint } from "./dialect";
import { keysForChar } from "./hostkeys";
import type { Live } from "./live";

export type Card = { id: string; title: string; body: string; actions: { id: string; label: string }[]; hint?: Hint; context?: string; kind: "help" | "guide" };
export type GuideState = { keys: string[]; text: string; idx: number; total: number; line: string; done: boolean };

type Ev = { t: number; msg: string; line: string };
const ERR_RE = /^\?\s*(.+?)\s+ERROR(?:\s+IN\s+(\d+))?\s*$/;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export class Assist {
  cards: Card[] = [];
  guide: GuideState | null = null;
  mode: "eager" | "quiet" | "off" = "eager";

  private lastRows: string[] = [];
  private lastCursor = { row: 0, col: 0 };
  private lastCursorText = "";
  private lastChange = Date.now();
  private errors: Ev[] = [];
  private deletions: number[] = [];
  private seenPairs = new Map<string, number>();
  private cardSeq = 1;
  private cooldownUntil = 0;
  private shown = 0;
  private backoff = 1;
  private lessonOffered = false;
  private bootedAt = Date.now();
  private guideLines: string[] = [];
  private lastGuideSig = "";

  constructor(private live: Live, private emit: (cards: Card[], guide: GuideState | null) => void) {}

  /** The newest card, if any. */
  private offer(card: Omit<Card, "id" | "kind">, certain = false): void {
    if (this.mode !== "eager" || this.guide) return;
    const now = Date.now();
    // a mistake we are CERTAIN about (another BASIC's command) is answered at once while we are still new
    // here; softer guesses (stuck, unsure) wait their turn, and after three cards everything waits
    if (now < this.cooldownUntil && !(certain && this.shown < 3)) return;
    if (this.cards.some((c) => c.title === card.title)) return;
    this.cards = [{ ...card, id: `c${this.cardSeq++}`, kind: "help" }, ...this.cards].slice(0, 3);
    this.shown++;
    // eager at first (the first three cards come as soon as they are earned), then it waits
    this.cooldownUntil = now + (this.shown <= 3 ? 20_000 : 150_000 * this.backoff);
    this.live.say("note", `Offered help: ${card.title}`);
    this.publish();
  }

  private publish(): void {
    this.emit(this.cards, this.guide);
  }

  // ---------- watching ----------

  /** Called a few times a second with the machine's latest state. */
  tick(): void {
    if (this.mode === "off") { if (this.cards.length || this.guide) { this.cards = []; this.guide = null; this.publish(); } return; }
    const m = this.live.machine;
    let rows: string[], cur: { row: number; col: number };
    try { const s = m.snapshot(); rows = m.screen(s); cur = m.cursor(s); } catch { return; }
    const now = Date.now();
    const sig = rows.join("\n");
    if (sig !== this.lastRows.join("\n")) this.lastChange = now;

    // errors: an error row that was not there a moment ago, with the line above it (what was typed)
    const pairs = new Map<string, number>();
    // (on a real C64 the error comes after a blank row: the typed line is the nearest non-blank row above it)
    rows.forEach((r, i) => {
      const e = ERR_RE.exec(norm(r));
      if (!e) return;
      let j = i - 1;
      while (j >= 0 && !norm(rows[j])) j--;
      const k = `${j >= 0 ? norm(rows[j]) : ""}|${e[1]}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    });
    for (const [k, n] of pairs) {
      if (n > (this.seenPairs.get(k) ?? 0)) {
        const [line, msg] = [k.slice(0, k.lastIndexOf("|")), k.slice(k.lastIndexOf("|") + 1)];
        this.errors.push({ t: now, msg, line });
        this.onError(msg, line);
      }
    }
    this.seenPairs = pairs;
    this.errors = this.errors.filter((e) => now - e.t < 180_000);

    // typing a line and clearing it again, twice
    const curText = rows[cur.row] ?? "";
    if (this.lastCursorText.trim().length >= 8 && curText.trim().length <= 1 && cur.row === this.lastCursor.row) {
      this.deletions.push(now);
      this.deletions = this.deletions.filter((t) => now - t < 120_000);
      if (this.deletions.length >= 2) this.onDeleting();
    }
    this.lastCursor = cur; this.lastCursorText = curText;

    // stuck: an error on screen, nothing has moved for a while
    const lastErr = this.errors.at(-1);
    if (lastErr && now - this.lastChange > 20_000 && now - lastErr.t > 20_000 && !this.cards.length) this.onStuck(lastErr);

    // brand new machine, nobody has touched it
    if (!this.lessonOffered && now - this.bootedAt > 40_000 && now - this.lastChange > 30_000 && rows.filter(Boolean).length <= 4) this.onNewcomer();

    if (this.guide) this.stepGuide(rows, cur);
    this.lastRows = rows;
  }

  private onError(msg: string, line: string): void {
    const hit = dialectHint(line);
    if (hit) {
      this.offer({
        title: `I see you are trying to ${hit.hint.intent}`,
        body: `${hit.hint.why} On a C64 it goes like this: ${hit.hint.lines.length ? "`" + hit.hint.lines[0] + "`" : "no single line does it, but I can show you the C64 way"}.`,
        actions: hit.hint.lines.length ? [{ id: "do", label: "Do it for me" }, { id: "guide", label: "Guide me" }, { id: "dismiss", label: "Not now" }] : [{ id: "explain", label: "Explain it" }, { id: "dismiss", label: "Not now" }],
        hint: hit.hint, context: `The user typed "${line}" and the machine answered "?${msg} ERROR".`,
      }, true);
      return;
    }
    const same = this.errors.filter((e) => e.msg === msg).length;
    if (same >= 2) {
      const why = Object.entries(ERRORS).find(([k]) => msg.startsWith(k))?.[1] ?? "The machine rejected the line.";
      this.offer({
        title: `That ${msg.toLowerCase()} error again`,
        body: `${why} Last line: \`${line.slice(0, 60)}\`. Want me to look at it?`,
        actions: [{ id: "do", label: "Fix it for me" }, { id: "explain", label: "Explain it" }, { id: "dismiss", label: "Not now" }],
        context: `The user typed "${line}" and got "?${msg} ERROR" ${same} times.`,
      });
    }
  }

  private onDeleting(): void {
    this.offer({
      title: "You keep typing a line and clearing it",
      body: "If you are not sure how to say something on a C64, tell me what you want to do and I will show you, or do it.",
      actions: [{ id: "do", label: "Ask the agent" }, { id: "dismiss", label: "I'm fine" }],
      context: "The user typed a line twice and cleared it without running it, as if unsure what to type.",
    });
  }

  private onStuck(e: Ev): void {
    const why = Object.entries(ERRORS).find(([k]) => e.msg.startsWith(k))?.[1] ?? "";
    this.offer({
      title: `Stuck on ?${e.msg} ERROR?`,
      body: `${why} The line was \`${e.line.slice(0, 60)}\`.`.trim(),
      actions: [{ id: "do", label: "Fix it for me" }, { id: "explain", label: "Explain it" }, { id: "dismiss", label: "Not now" }],
      context: `The user typed "${e.line}", got "?${e.msg} ERROR", and has not touched the machine for 20 seconds.`,
    });
  }

  private onNewcomer(): void {
    this.lessonOffered = true;
    this.offer({
      title: "New to the C64? I can show you a first program",
      body: "It turns on straight into BASIC. A line with a number in front is kept as a program, without one it runs at once. Want to try?",
      actions: [{ id: "do", label: "Type it for me" }, { id: "guide", label: "Guide me" }, { id: "dismiss", label: "No thanks" }],
      hint: FIRST_LESSON, context: "A brand new machine nobody has typed on yet.",
    });
  }

  // ---------- reacting to a card ----------

  /** The user pressed a button on a card. Returns what the shell should do next. */
  act(id: string, action: string): { kind: "type"; lines: string[]; hint: Hint } | { kind: "agent"; task: string; explainOnly: boolean } | { kind: "none" } {
    const card = this.cards.find((c) => c.id === id);
    if (!card) return { kind: "none" };
    this.cards = this.cards.filter((c) => c.id !== id);
    if (action === "dismiss") {
      this.backoff = Math.min(8, this.backoff * 2);
      this.live.say("note", `Dismissed: ${card.title}. It will wait longer before speaking up again.`);
      this.publish();
      return { kind: "none" };
    }
    this.backoff = 1;
    this.publish();
    if (action === "guide" && card.hint?.lines.length) { this.startGuide(card.hint.lines); return { kind: "none" }; }
    if (action === "do" && card.hint?.lines.length) return { kind: "type", lines: card.hint.lines, hint: card.hint };
    return { kind: "agent", task: card.context ?? card.title, explainOnly: action === "explain" };
  }

  // ---------- guide me: the next key lights on the on-screen keyboard ----------

  startGuide(lines: string[]): void {
    this.guideLines = lines;
    this.guide = { keys: [], text: "", idx: 0, total: lines.length, line: lines[0], done: false };
    this.armed = false;
    this.live.say("note", "Guiding you: type each line yourself, the next key lights up on the keyboard below. Press Stop guiding any time.");
    this.stepGuide(this.lastRows, this.lastCursor);
  }

  stopGuide(): void {
    if (!this.guide) return;
    this.guide = null; this.guideLines = []; this.lastGuideSig = "";
    this.cards = this.cards.filter((c) => c.kind !== "guide");
    this.publish();
  }

  private armed = false;

  private stepGuide(rows: string[], cur: { row: number; col: number }): void {
    const g = this.guide; if (!g) return;
    const want = this.guideLines[g.idx].toUpperCase();
    const typed = (rows[cur.row] ?? "").replace(/\s+$/, "");
    // The line has landed when it was complete on the cursor row and the cursor has since moved on to a
    // fresh, empty row: that is what pressing RETURN does (and it still holds when the line cleared the
    // screen). Backspacing it away leaves a non-empty prefix on the way, which disarms this.
    if (typed === want) this.armed = true;
    else if (typed !== "" && want.startsWith(typed)) this.armed = false;
    if (this.armed && typed === "" && cur.col === 0) {
      this.armed = false;
      g.idx++;
      if (g.idx >= this.guideLines.length) {
        this.guide = null; this.lastGuideSig = "";
        this.cards = [{ id: `c${this.cardSeq++}`, kind: "help", title: "That's how it is done on a C64", body: "You typed every line yourself. Nothing was done for you.", actions: [{ id: "dismiss", label: "Nice" }] }];
        this.live.say("note", "Guide finished: you typed every line yourself.");
        this.publish(); return;
      }
      g.line = this.guideLines[g.idx];
      return this.stepGuide(rows, cur);
    }
    let next: string[] = [], text = "";
    if (typed === want) { next = ["RETURN"]; text = "Press RETURN"; }
    else if (want.startsWith(typed)) { const ch = want[typed.length]; next = keysForChar(ch) ?? []; text = `Next: ${ch === " " ? "SPACE" : ch}`; }
    else { next = ["DEL"]; text = "Not quite: press DEL to take that back"; }
    const wantNow = this.guideLines[g.idx].toUpperCase();
    g.keys = next; g.text = text; g.line = wantNow;
    const sig = `${g.idx}|${text}|${typed}`;
    if (sig === this.lastGuideSig) return;
    this.lastGuideSig = sig;
    this.cards = [{ id: "guide", kind: "guide", title: `Guiding you: step ${g.idx + 1} of ${g.total}`, body: `Type \`${wantNow}\`. ${text}.`, actions: [{ id: "stopguide", label: "Stop guiding" }] }, ...this.cards.filter((c) => c.kind !== "guide")].slice(0, 3);
    this.publish();
  }
}
