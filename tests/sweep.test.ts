// Regression tests for the second batch of the 2026-11-21 bug sweep. No engine needed.
// Every test here failed against the code as it was before the fix.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

process.env.NIX64_HOME ??= mkdtempSync(join(tmpdir(), "nix64-sweep-"));
const { Machine, TEL_V1_SIZE } = await import("../src/machine");
const { archiveHost, unzipMedia } = await import("../src/shelf");
const { createD64 } = await import("../src/d64");
const mf = await import("../src/machinefile");
const { paths, ensureDirs, machineFile, generationsDir } = await import("../src/paths");

describe("the memory snapshot is never torn", () => {
  test("a writer that publishes in many small writes never shows up half-written", async () => {
    // A fake engine: a worker thread keeps republishing the whole 64 KB of RAM behind the sequence word, in 4 KB pieces,
    // every byte of one publish holding the same value. A good snapshot has the same value in every byte.
    const dir = mkdtempSync(join(tmpdir(), "nix64-seq-"));
    const file = join(dir, "t.shm");
    const head = Buffer.alloc(TEL_V1_SIZE);
    head.write("NIX64TEL", 0);
    head.writeUInt32LE(2, 8);
    writeFileSync(file, head);
    const code = `
      const { openSync, writeSync } = require("node:fs");
      const fd = openSync(${JSON.stringify(file)}, "r+");
      const w = (buf, at) => writeSync(fd, buf, 0, buf.length, at);
      let seq = 0, v = 1;
      const piece = Buffer.alloc(4096);
      const end = Date.now() + 2500;
      while (Date.now() < end) {
        seq++; w(Buffer.from(new Uint32Array([seq]).buffer), 16); // odd: writing
        piece.fill(v & 255);
        for (let o = 0; o < 65536; o += 4096) w(piece, 1120 + o);
        seq++; w(Buffer.from(new Uint32Array([seq]).buffer), 16); // even: done
        v++;
      }
      postMessage("done");
    `;
    const worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    const done = new Promise<void>((res) => { worker.onmessage = () => res(); });
    await Bun.sleep(100);
    const m = Machine.open(file);
    let torn = 0, good = 0;
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      let s;
      try { s = m.snapshot(); } catch { continue; } // "not publishing" while the writer is mid-publish for a long stretch is fine
      good++;
      const first = s.ram[0];
      for (let i = 1; i < 65536; i++) if (s.ram[i] !== first) { torn++; break; }
    }
    await done;
    m.close();
    rmSync(dir, { recursive: true, force: true });
    expect(good).toBeGreaterThan(100);
    expect(torn).toBe(0);
  }, 20000);
});

describe("zips from the Internet Archive", () => {
  // a one-entry zip whose declared size is a lie (10 bytes) while the deflated data expands to `real` bytes
  function zipOf(name: string, payload: Buffer, declared: number): Uint8Array {
    const data = deflateRawSync(payload);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(declared, 22); lh.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(declared, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(0, 42);
    const body = Buffer.concat([lh, n, data]);
    const cdir = Buffer.concat([cd, n]);
    const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(cdir.length, 12); eo.writeUInt32LE(body.length, 16);
    return new Uint8Array(Buffer.concat([body, cdir, eo]));
  }
  test("an honest small zip still opens", () => {
    const d = createD64("OK", "01");
    const out = unzipMedia(zipOf("ok.d64", Buffer.from(d), d.length));
    expect(out.length).toBe(1);
    expect(out[0].name).toBe("ok.d64");
    expect(out[0].data.length).toBe(d.length);
  });
  test("a zip that declares 10 bytes but expands past the 64 MB limit is skipped, not inflated into memory", () => {
    const before = process.memoryUsage().rss;
    const out = unzipMedia(zipOf("bomb.d64", Buffer.alloc(200 * 1024 * 1024), 10));
    expect(out.length).toBe(0);
    expect(process.memoryUsage().rss - before).toBeLessThan(400 * 1024 * 1024); // the old code grew by about 2 GB at this size
  }, 30000);
});

describe("which download hosts are accepted", () => {
  test("archive.org and its own storage hosts over https, nothing that only ends the same way", () => {
    expect(archiveHost("https://archive.org/download/x/y.zip")).toBe(true);
    expect(archiveHost("https://ia800000.us.archive.org/1/items/x/y.zip")).toBe(true);
    expect(archiveHost("https://evilarchive.org/y.zip")).toBe(false);
    expect(archiveHost("https://archive.org.evil.com/y.zip")).toBe(false);
    expect(archiveHost("http://archive.org/y.zip")).toBe(false);
    expect(archiveHost("not a url")).toBe(false);
  });
});

describe("machine files say no to what the engine would choke on", () => {
  const base = (extra: string, drive = `type = "1541-II"\nmode = "image"`) => `name = "t"\nmodel = "c64c"\nregion = "pal"\n[drive.8]\n${drive}\n${extra}`;
  test("REU sizes must be ones VICE accepts", () => {
    expect(() => mf.evaluate(base("[devices.reu]\nenabled = true\nsize = 300"), "t")).toThrow(/devices\.reu\.size/);
    expect(mf.evaluate(base("[devices.reu]\nenabled = true\nsize = 1024"), "t").devices.reu.size).toBe(1024);
  });
  test("a 1581 needs a .d81, and a .d81 needs a 1581", () => {
    expect(() => mf.evaluate(base("", `type = "1581"\nmode = "image"`), "t")).toThrow(/1581/);
    ensureDirs();
    writeFileSync(join(paths.shelf, "k.d81"), Buffer.alloc(819200));
    writeFileSync(join(paths.shelf, "k.d64"), createD64("K", "01"));
    expect(mf.evaluate(base("", `type = "1581"\nmode = "image"\nimage = "shelf:k.d81"`), "t").drives["8"].type).toBe("1581");
    expect(() => mf.evaluate(base("", `type = "1581"\nmode = "image"\nimage = "shelf:k.d64"`), "t")).toThrow(/\.d64/);
    expect(() => mf.evaluate(base("", `type = "1541-II"\nmode = "image"\nimage = "shelf:k.d81"`), "t")).toThrow(/1581/);
  });
});

describe("rollback brings the pinned disk back, not whatever the shelf holds now", () => {
  test("switch after a rollback is not a new generation", () => {
    ensureDirs();
    writeFileSync(join(paths.shelf, "game.d64"), createD64("ONE", "01"));
    mf.createMachine("rb", "rollback test", "c64c-pal");
    const withDisk = (d: string) => Bun.file(machineFile("rb")).text().then((t) => t.replace(/^#? ?image = .*$/m, `image = "shelf:game.d64"`).replace(/^description = .*$/m, `description = "${d}"`));
    return (async () => {
      writeFileSync(machineFile("rb"), await withDisk("first"));
      const g1 = mf.switchMachine("rb").gen;
      writeFileSync(join(paths.shelf, "game.d64"), createD64("TWO", "02")); // the shelf file changes under the same name
      writeFileSync(machineFile("rb"), await withDisk("second"));
      const g2 = mf.switchMachine("rb").gen;
      expect(g2.n).toBe(2);
      expect(g2.def.drives["8"].image?.sha256).not.toBe(g1.def.drives["8"].image?.sha256);
      mf.rollback("rb", 1);
      const again = mf.switchMachine("rb");
      expect(again.changed).toBe(false); // it used to make a generation 3 pinned to the NEW shelf file
      expect(again.gen.n).toBe(1);
      expect(again.gen.def.drives["8"].image?.sha256).toBe(g1.def.drives["8"].image?.sha256);
      expect(mf.listGenerations("rb").length).toBe(2);
      // and an edit after the rollback is still a normal new generation
      writeFileSync(machineFile("rb"), (await Bun.file(machineFile("rb")).text()).replace(/^description = .*$/m, 'description = "third"'));
      expect(mf.switchMachine("rb").gen.n).toBe(3);
    })();
  });
});

describe("c64ctl refuses numbers it cannot use", () => {
  const dir = mkdtempSync(join(tmpdir(), "nix64-ctl-"));
  const file = join(dir, "t.shm");
  const h = Buffer.alloc(TEL_V1_SIZE);
  h.write("NIX64TEL", 0); h.writeUInt32LE(2, 8);
  writeFileSync(file, h);
  const run = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "../bin/c64ctl.ts"), "--path", file, ...args], { env: { ...process.env, NIX64_CPS: "abc" } });
  test("asking for help is not a failure (an agent's tool result was flagged as an error)", () => {
    expect(run("--help").exitCode).toBe(0);
    expect(run("help").exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", join(import.meta.dir, "../bin/c64ctl.ts")]).exitCode).toBe(1); // nothing asked for
  });
  test("--timeout 30s is an error at once, not a wait that never ends", () => {
    const t = Date.now();
    const r = run("wait", "NEVER", "--timeout", "30s");
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("--timeout needs a positive number");
    expect(Date.now() - t).toBeLessThan(8000);
  });
  test("--cps 0 and --hold abc are errors, and a bad NIX64_CPS in the environment falls back to the default", () => {
    expect(run("type", "A", "--cps", "0").exitCode).toBe(2);
    expect(run("key", "A", "--hold", "abc").exitCode).toBe(2);
    const r = run("status"); // NIX64_CPS=abc must not break a plain command
    expect(r.exitCode).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a key pressed again right after it was let go (2026-11-21 sweep)", () => {
  // The KERNAL scans the keyboard once a frame and only notices a new press if it saw the key up in between. A fast Backspace
  // (down, up, down within a frame or two) was applied inside one frame and lost: 5 in 48 at 130 ms apart, 26 in 48 at 60 ms.
  test("the second press is stamped at least two frames after the release", async () => {
    const { Live } = await import("../src/live");
    const { TEL_V2_SIZE } = await import("../src/machine");
    const dir = mkdtempSync(join(tmpdir(), "nix64-key-"));
    const file = join(dir, "t.shm");
    const h = Buffer.alloc(TEL_V2_SIZE);
    h.write("NIX64TEL", 0); h.writeUInt32LE(2, 8);
    writeFileSync(file, h);
    const live = new Live({ name: "k", shm: file } as any);
    const setFrame = (n: number) => { const fd = require("node:fs").openSync(file, "r+"); require("node:fs").writeSync(fd, Buffer.from(new Uint32Array([n]).buffer), 0, 4, 20); require("node:fs").closeSync(fd); };
    const events = () => {
      const b = require("node:fs").readFileSync(file) as Buffer;
      const tail = b.readUInt32LE(TEL_V1_SIZE + 4);
      return Array.from({ length: tail }, (_, i) => { const o = TEL_V1_SIZE + 16 + i * 8; return { at: b.readUInt32LE(o), down: b[o + 7] === 1 }; });
    };
    setFrame(1000); live.key("DEL", true);
    setFrame(1005); live.key("DEL", false);
    setFrame(1006); live.key("DEL", true); // one frame after letting go
    const e = events();
    expect(e.length).toBe(3);
    const upAt = e[1].at || 1005; // 0 means "now"
    expect(e[2].down).toBe(true);
    expect(e[2].at).toBeGreaterThanOrEqual(upAt + 2);
    live.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("small robustness fixes (2026-11-21)", () => {
  test("joystick direction 'constructor' is an error, not nothing", async () => {
    const { joyValue } = await import("../src/keys");
    expect(() => joyValue("constructor")).toThrow(/unknown joystick direction/);
    expect(joyValue("up+fire")).toBe(17);
  });
  test("a TouchPad or a Keypad is not a game controller", async () => {
    const { PAD_RE } = await import("../src/devices");
    const names = ['Name="Synaptics TouchPad"', 'Name="USB Keypad"', 'Name="Logitech Gamepad F310"', 'Name="Xbox Wireless Controller"', 'Name="8BitDo Pro Pad"'];
    const hit = names.filter((n) => (n.match(PAD_RE) ?? []).length > 0);
    expect(hit).toEqual(['Name="Logitech Gamepad F310"', 'Name="Xbox Wireless Controller"', 'Name="8BitDo Pro Pad"']);
  });
  test("a control character in a description cannot make the machine file invalid TOML", () => {
    const text = mf.TEMPLATE("ctl", "bad\u007fdesc\u0001here");
    expect(() => Bun.TOML.parse(text)).not.toThrow();
  });
  test("a torn generation file is skipped, so the machine can still start and switch", () => {
    ensureDirs();
    mf.createMachine("torn", "x", "c64c-pal");
    mf.switchMachine("torn");
    const dir = generationsDir("torn");
    const f = require("node:fs").readdirSync(dir).find((x: string) => /^\d+\.json$/.test(x));
    writeFileSync(join(dir, "7.json"), '{"n":7,"time":"x","ha'); // a write that was cut off
    expect(() => mf.listGenerations("torn")).not.toThrow();
    expect(mf.listGenerations("torn").some((g) => g.n === 7)).toBe(false);
    expect(f).toBeDefined();
  });
  test("only C64 media can be removed from the shelf", async () => {
    const { removeFromShelf } = await import("../src/shelf");
    ensureDirs();
    writeFileSync(join(paths.shelf, "notes.txt"), "mine");
    expect(() => removeFromShelf("notes.txt")).toThrow(/only C64 media/);
    expect(await Bun.file(join(paths.shelf, "notes.txt")).exists()).toBe(true);
  });
});
