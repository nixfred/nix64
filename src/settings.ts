// Settings that belong to the person, not to a machine: how the shell looks and sounds, which agent
// helps, how eager it is. One small JSON file; every key has a default, so a missing file is fine.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths";

export type Settings = {
  display: {
    /** shell UI scale, percent */
    scale: number;
    crt: boolean;
    /** 0..100: how strong the scanlines, mask and glow are */
    crtStrength: number;
    bezel: boolean;
    reducedMotion: "auto" | "on" | "off";
    highContrast: boolean;
  };
  sound: { ui: boolean; muted: boolean };
  keys: { joystickKeys: boolean };
  agent: {
    /** "auto" picks the first agent found, else the name of one: claude, codex, pi, opencode, crush */
    choice: string;
    /** model for the chosen agent; empty = its own default */
    model: string;
    /** a local model server (Ollama, LM Studio) the agent should use, if any */
    localEndpoint: string;
    /** eager: speak up at first and learn; quiet: only when asked; off: never */
    assist: "eager" | "quiet" | "off";
    /** keys per second when the agent types */
    typingSpeed: number;
    /** let the agent write straight into RAM (labelled in the feed). Off by default. */
    directRam: boolean;
  };
  firstRunDone: boolean;
};

export const DEFAULTS: Settings = {
  display: { scale: 100, crt: true, crtStrength: 50, bezel: true, reducedMotion: "auto", highContrast: false },
  sound: { ui: true, muted: false },
  keys: { joystickKeys: false },
  agent: { choice: "auto", model: "", localEndpoint: "", assist: "eager", typingSpeed: 30, directRam: false },
  firstRunDone: false,
};

const file = () => join(paths.config, "settings.json");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Overlay `patch` on `base`, keeping only keys `base` already has and values of the same type. */
function merge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(base)) {
    const b = (base as Record<string, unknown>)[k], p = patch[k];
    if (p === undefined) continue;
    if (isObj(b)) out[k] = merge(b, p);
    else if (typeof p === typeof b) out[k] = p;
  }
  return out as T;
}

export function loadSettings(): Settings {
  try {
    return merge(DEFAULTS, JSON.parse(readFileSync(file(), "utf8")));
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveSettings(patch: unknown): Settings {
  const next = merge(loadSettings(), patch);
  next.agent.typingSpeed = Math.min(120, Math.max(5, Math.round(next.agent.typingSpeed)));
  next.display.scale = Math.min(200, Math.max(70, Math.round(next.display.scale)));
  next.display.crtStrength = Math.min(100, Math.max(0, Math.round(next.display.crtStrength)));
  if (!existsSync(paths.config)) mkdirSync(paths.config, { recursive: true });
  writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}
