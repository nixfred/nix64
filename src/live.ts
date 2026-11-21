// One running machine as the shell sees it: the shared-memory handle, the keyboard, the joystick,
// the frame rate, the activity feed. Reading is free (shared memory, no stall); everything the shell
// does TO the machine goes through the input ring or, rarely, the monitor doors.
import { HostKeyboard } from "./hostkeys";
import { joyValue, keyMatrix } from "./keys";
import { Machine, type Picture } from "./machine";
import type { RunState } from "./engine";

export type FeedItem = {
  id: number;
  time: number;
  /** what happened: the agent said something (say) or the local rules explained something, no model involved (hint), did something on the machine, did a LABELLED host-side step, or the rules noticed */
  kind: "say" | "hint" | "machine" | "host" | "note" | "error" | "user";
  text: string;
  /** for kind "machine": the real channel used, e.g. "keyboard" */
  via?: string;
};

/** Frames a key must be seen up before the same key can go down again. */
const RELEASE_FRAMES = 2;

export class Live {
  readonly machine: Machine;
  readonly keyboard: HostKeyboard;
  lastFrame = 0;
  /** Counts picture changes, so each window can tell whether it already has the newest one. */
  picSeq = 0;
  lastPicture?: { frame: number; w: number; h: number; pal: Buffer; pix: Buffer };
  fps = 0;
  warp = false;
  joy: [number, number] = [0, 0];
  /** arrows + space + ctrl act as a joystick instead of as keys (a game is running) */
  keysAsJoystick: 0 | 1 | 2 = 0;
  feed: FeedItem[] = [];
  /** the tune Nix64 started on this machine, if it is still playing (Stop, reset or another program clears it) */
  sid: import("./media").NowPlaying | null = null;
  private feedId = 1;
  private fpsMark = { t: performance.now(), f: 0 };
  /** hooks other modules attach: called on every new feed item */
  onFeed?: (item: FeedItem) => void;

  constructor(readonly state: RunState) {
    this.machine = Machine.open(state.shm);
    this.keyboard = new HostKeyboard(
      (row, col, down) => this.pushKey(row, col, down),
      (down) => { if (this.machine.hasControl) this.machine.push(0, 4, down ? 1 : 0); },
    );
    this.lastFrame = this.machine.frame();
    this.fpsMark = { t: performance.now(), f: this.lastFrame };
  }

  get name(): string { return this.state.name; }

  close(): void {
    this.keyboard.releaseAll();
    this.machine.close();
  }

  /**
   * The C64 only looks at the keyboard once a frame, so a key that goes down and up inside one frame is
   * never seen. A fast tap, a paste of key events or a macro would vanish. So every key is held for at
   * least three frames, and events are stamped so they stay in order: a burst of keys is spread out
   * (about 20 keys a second at most) instead of being applied all in the same frame.
   */
  private downAt = new Map<number, number>();
  /** the frame each key was last let go (stamped like the events), so the next press can be kept apart from it */
  private upAt = new Map<number, number>();
  private tailAt = 0;
  private pushKey(row: number, col: number, down: boolean): void {
    const id = row * 8 + col, f = this.machine.frame();
    if (this.tailAt <= f) this.tailAt = 0; // nothing queued ahead of now
    let at = this.tailAt;
    if (down) {
      // The KERNAL tells a new press of a key from a held one only if it saw the key UP in between, and it scans once a frame.
      // Pressing the same key again less than a couple of frames after letting go (a fast Backspace, a double letter) was
      // applied inside one frame and lost: about 1 press in 10 at 130 ms apart, over half at 60 ms apart.
      const u = this.upAt.get(id);
      if (u !== undefined && u + RELEASE_FRAMES > Math.max(at, f)) at = u + RELEASE_FRAMES;
      this.downAt.set(id, at || f);
    } else {
      const d = this.downAt.get(id);
      this.downAt.delete(id);
      if (d !== undefined) at = Math.max(at, d + 3);
      if (at <= f) at = 0;
      this.upAt.set(id, at || f);
    }
    this.tailAt = at;
    try { this.machine.push(at, 1, row, col, down ? 1 : 0); } catch { /* ring full: dropped */ }
  }

  /** The ring was flushed: forget what was stamped ahead. */
  queueCleared(): void {
    this.tailAt = 0;
    this.downAt.clear();
    this.upAt.clear();
  }

  /** Press or release a C64 key by name (the on-screen keyboard, the agent's hands). */
  key(name: string, down: boolean): boolean {
    const k = keyMatrix(name);
    if (!k) return false;
    this.pushKey(k.row, k.col, down);
    return true;
  }

  joystick(port: 1 | 2, spec: string): void {
    const v = joyValue(spec);
    this.joy[port - 1] = v;
    this.machine.setJoystick(port, spec);
  }

  setWarp(on: boolean): void {
    this.warp = on;
    this.machine.setWarp(on);
  }

  /** Called when the frame counter moves. Keeps a smoothed emulated-frames-per-second. */
  sampleFps(f: number): void {
    const now = performance.now();
    if (now - this.fpsMark.t >= 1000) {
      this.fps = ((f - this.fpsMark.f) * 1000) / (now - this.fpsMark.t);
      this.fpsMark = { t: now, f };
    }
  }

  /** The newest picture, as bytes ready to send, or null if it has not changed since `sinceFrame`. */
  picture(): Picture | null {
    return this.machine.picture();
  }

  say(kind: FeedItem["kind"], text: string, via?: string): FeedItem {
    const item: FeedItem = { id: this.feedId++, time: Date.now(), kind, text, via };
    this.feed.push(item);
    if (this.feed.length > 300) this.feed.splice(0, this.feed.length - 300);
    this.onFeed?.(item);
    return item;
  }
}
