// The audio itself: play the test tune and record what the engine's SID emulation produces into a WAV file (VICE's own sound
// recorder), then find the strongest frequency in it. If it is 440 Hz for song 1 and 880 Hz for song 2, the whole chain
// shelf -> Play -> tune's 6502 code -> emulated SID -> audio samples works, with numbers rather than an ear.
// Opt-in, and it needs an engine that has an audio path (the SDL build that nix64-vice installs; the headless development
// build has only dummy sound devices and records nothing):
//   NIX64_AUDIO=1 SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy NIX64_X64SC=/usr/lib/nix64/bin/x64sc bun test tests/sid.audio.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toneSid } from "./sidfixture";

const on = !!process.env.NIX64_X64SC && process.env.NIX64_AUDIO === "1";
const home = mkdtempSync(join(tmpdir(), "nix64-audio-"));
process.env.NIX64_HOME = home;
process.env.NIX64_NO_SYSTEMD = "1";
mkdirSync(join(home, "ui"), { recursive: true });
writeFileSync(join(home, "ui/index.html"), "ok");
process.env.NIX64_UI = join(home, "ui");
const suite = on ? describe : describe.skip;
const { createHub } = await import("../src/server");
const { setResource } = await import("../src/monitor");
const { readState } = await import("../src/engine");

/** the 16 bit mono samples of a PCM WAV, and its sample rate (stereo is mixed down) */
function readWav(file: string): { rate: number; samples: Float64Array } {
  const b = readFileSync(file);
  expect(b.subarray(0, 4).toString()).toBe("RIFF");
  const channels = b.readUInt16LE(22), rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  expect(bits).toBe(16);
  let at = 12, data = Buffer.alloc(0);
  while (at + 8 <= b.length) {
    const id = b.subarray(at, at + 4).toString(), len = b.readUInt32LE(at + 4);
    if (id === "data") { data = b.subarray(at + 8, Math.min(b.length, at + 8 + len)); break; }
    at += 8 + len + (len & 1);
  }
  const n = Math.floor(data.length / 2 / channels), out = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < channels; c++) s += data.readInt16LE((i * channels + c) * 2); out[i] = s / channels; }
  return { rate, samples: out };
}

/** RMS loudness of each half second of the recording, so a test can see where the sound is */
function levels(rate: number, samples: Float64Array): number[] {
  const step = Math.floor(rate / 2), out: number[] = [];
  for (let at = 0; at + step <= samples.length; at += step) { let e = 0; for (let i = 0; i < step; i++) e += samples[at + i] ** 2; out.push(Math.sqrt(e / step)); }
  return out;
}

/** the loudest frequency between 100 and 2000 Hz (Goertzel, 1 Hz steps) in the loudest second of the recording */
function peakHz(rate: number, samples: Float64Array): { hz: number; level: number; at: number } {
  const lv = levels(rate, samples);
  let bestAt = 0, bestE = -1;
  for (let i = 0; i + 1 < lv.length; i++) { const e = lv[i] + lv[i + 1]; if (e > bestE) { bestE = e; bestAt = i; } }
  const start = Math.floor(bestAt * (rate / 2)), len = Math.min(samples.length - start, rate);
  expect(len).toBeGreaterThan(rate / 2);
  let best = { hz: 0, level: 0, at: bestAt / 2 };
  for (let hz = 100; hz <= 2000; hz++) {
    const w = (2 * Math.PI * hz) / rate, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < len; i++) { const s0 = samples[start + i] + c * s1 - s2; s2 = s1; s1 = s0; }
    const level = Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / len;
    if (level > best.level) best = { hz, level, at: bestAt / 2 };
  }
  return best;
}

suite("the SID audio, recorded from the engine", () => {
  let hub: Awaited<ReturnType<typeof createHub>>;
  let base = "", cookie = "";
  const api = (path: string, body?: object, method = "POST") => fetch(base + path, { method, headers: { cookie, "x-nix64": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const port = () => readState("aud")!.binaryPort;

  beforeAll(async () => {
    hub = await createHub();
    const server = hub.start(0);
    base = `http://127.0.0.1:${server.port}`;
    cookie = (await fetch(`${base}/?t=${hub.token}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
    await api("/api/machines", { name: "aud" });
    expect((await api("/api/machines/aud/start")).status).toBe(200);
    expect(await hub.lives.get("aud")!.machine.waitForText("READY.", 30000)).not.toBeNull();
    const imp = await fetch(`${base}/api/shelf/import`, { method: "POST", headers: { cookie, "x-nix64": "1", "x-filename": "tone.sid" }, body: toneSid(2) });
    expect(imp.status).toBe(200);
  }, 90000);

  afterAll(async () => {
    await api("/api/machines/aud/stop").catch(() => {});
    hub.stop();
    rmSync(home, { recursive: true, force: true });
  });

  /** Close the WAV: pointing the recorder at /dev/null makes VICE finish the file it was writing (the monitor cannot send an empty recorder name, and an unknown one upsets the SDL sound driver). */
  async function stopRecording(): Promise<void> {
    await setResource(port(), "SoundRecordDeviceArg", "/dev/null");
    await Bun.sleep(1200);
  }

  async function record(song: number, file: string): Promise<{ rate: number; samples: Float64Array }> {
    await setResource(port(), "SoundRecordDeviceArg", file);
    await setResource(port(), "SoundRecordDeviceName", "wav");
    const r = await (await api("/api/machines/aud/sid", { shelf: "tone.sid", song, force: true })).json() as any;
    expect(r.error ?? r.ok).toBe(true);
    await Bun.sleep(4500);
    await stopRecording();
    return readWav(file);
  }

  test("song 1 is a 440 Hz tone in the audio the engine produces", async () => {
    const { rate, samples } = await record(1, join(home, "s1.wav"));
    const p = peakHz(rate, samples);
    console.log(`song 1: strongest frequency ${p.hz} Hz, level ${p.level.toFixed(1)} at ${p.at}s, ${samples.length} samples at ${rate} Hz; loudness per half second: ${levels(rate, samples).map((x) => Math.round(x)).join(" ")}`);
    expect(Math.abs(p.hz - 440)).toBeLessThanOrEqual(3);
    expect(p.level).toBeGreaterThan(50);
  }, 60000);

  test("song 2 is an 880 Hz tone", async () => {
    const { rate, samples } = await record(2, join(home, "s2.wav"));
    const p = peakHz(rate, samples);
    console.log(`song 2: strongest frequency ${p.hz} Hz, level ${p.level.toFixed(1)}`);
    expect(Math.abs(p.hz - 880)).toBeLessThanOrEqual(5);
  }, 60000);

  test("after Stop the engine's audio is silent", async () => {
    await api("/api/machines/aud/sid/stop");
    await setResource(port(), "SoundRecordDeviceArg", join(home, "s3.wav"));
    await setResource(port(), "SoundRecordDeviceName", "wav");
    await Bun.sleep(2500);
    await stopRecording();
    const { samples } = readWav(join(home, "s3.wav"));
    let peak = 0;
    for (let i = Math.floor(samples.length / 3); i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    console.log(`after Stop: loudest sample ${peak}`);
    expect(peak).toBeLessThan(200);
  }, 60000);
});
