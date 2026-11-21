// Subtle UI sounds, made in the browser (nothing to download): a key click, a soft blip for cards.
// Off with Settings > Sound, or the master mute. They are the shell's, not the C64's: the machine's own
// sound (including the 1541 head clatter) comes from the engine.
import { S } from "./net.js";
let ctx;
function ok() { return S.settings?.sound.ui && !S.settings.sound.muted; }
function tone(freq, dur, type = "square", vol = 0.025, slide = 0) {
  if (!ok()) return;
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  if (slide) o.frequency.linearRampToValueAtTime(freq + slide, ctx.currentTime + dur);
  g.gain.value = vol; g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + dur);
}
export const click = () => tone(1900, 0.022, "square", 0.012);
export const blip = () => { tone(740, 0.08, "triangle", 0.03); setTimeout(() => tone(1110, 0.1, "triangle", 0.03), 70); };
export const bad = () => tone(180, 0.18, "sawtooth", 0.03, -60);
