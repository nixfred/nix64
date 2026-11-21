// SID tunes without an engine: the header parser and the shelf. (Playing one on a real engine is tests/sid.e2e.test.ts.)
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toneSid } from "./sidfixture";

process.env.NIX64_HOME ??= mkdtempSync(join(tmpdir(), "nix64-sid-"));
const { parseSid } = await import("../src/psid");
const { addToShelf, kindOf, listShelf, MEDIA_EXT } = await import("../src/shelf");
const { ensureDirs } = await import("../src/paths");

describe("reading a SID file's header", () => {
  test("title, author, songs, clock and chip", () => {
    const i = parseSid(toneSid(2));
    expect(i.format).toBe("PSID");
    expect(i.title).toBe("Nix64 test tone");
    expect(i.author).toBe("Larry (Claude)");
    expect(i.songs).toBe(2);
    expect(i.startSong).toBe(1);
    expect(i.clock).toBe("pal");
    expect(i.model).toBe("6581");
    expect(i.sids).toBe(1);
  });
  test("things that are not SID files are refused in plain words", () => {
    expect(() => parseSid(Buffer.from("hello"))).toThrow(/too short/);
    expect(() => parseSid(Buffer.alloc(200))).toThrow(/does not start with PSID or RSID/);
    const bad = toneSid(); bad.writeUInt16BE(0, 14);
    expect(() => parseSid(bad)).toThrow(/songs/);
    const v9 = toneSid(); v9.writeUInt16BE(9, 4);
    expect(() => parseSid(v9)).toThrow(/version 9/);
  });
  test("a start song outside the range falls back to 1, and control characters in names are noise", () => {
    const b = toneSid(2); b.writeUInt16BE(7, 16); b.fill(0, 0x16, 0x36); b.write("A\u0007B\u001bC", 0x16, "latin1");
    const i = parseSid(b);
    expect(i.startSong).toBe(1);
    expect(i.title).toBe("A B C");
  });
});

describe("the shelf takes SID tunes", () => {
  test(".sid is media, with its details and a title, and junk is refused", () => {
    ensureDirs();
    expect(MEDIA_EXT.has(".sid")).toBe(true);
    expect(kindOf("a.SID")).toBe("sid");
    const n = addToShelf("tone.sid", toneSid());
    const item = listShelf().find((x) => x.name === n)!;
    expect(item.kind).toBe("sid");
    expect(item.sid?.songs).toBe(2);
    expect(item.title).toBe("Nix64 test tone · Larry (Claude)");
    expect(() => addToShelf("junk.sid", Buffer.from("not a tune at all, just text that is long enough to pass the length check ".repeat(3)))).toThrow(/not a SID file/);
  });
});

describe("planning how to play a tune (src/sidplayer.ts)", () => {
  test("the tune goes to its load address, the driver into the tape buffer, the vector last", async () => {
    const { planSid, DRIVER_AT } = await import("../src/sidplayer");
    const p = planSid(toneSid(2), 2, "pal");
    expect(p.loadAddress).toBe(0x1000);
    expect(p.initAddress).toBe(0x1000);
    expect(p.playAddress).toBe(0x1030);
    expect(p.writes.map((w) => w.addr)).toEqual([0x1000, DRIVER_AT, 0x0314]);
    expect([...p.writes[2].data]).toEqual([0x40, 0x03]);
    const d = p.writes[1].data;
    expect(d.length).toBe(0x30);
    expect(d[0]).toBe(0xad); // LDA flag
    expect(d[0x2f]).toBe(0); // the flag starts at 0
    expect(d[19]).toBe(1); // LDA #song-1 for song 2
    expect([d[20], d[21], d[22]]).toEqual([0x20, 0x00, 0x10]); // JSR $1000 (init)
    expect([d[26], d[27], d[28]]).toEqual([0x20, 0x30, 0x10]); // JSR $1030 (play)
    expect(p.cia60).toBe(false);
  });
  test("a tune that asks for the 60 Hz CIA timer gets it on a PAL machine, and only there", async () => {
    const { planSid } = await import("../src/sidplayer");
    const b = toneSid(2); b.writeUInt32BE(0b01, 18); // song 1 uses the CIA timer
    expect(planSid(b, 1, "pal").cia60).toBe(true);
    expect(planSid(b, 1, "pal").writes[1].data.subarray(8, 18).toString("hex")).toBe("a9258d04dca9408d05dc"); // CIA 1 timer A latch = $4025 = 60 Hz
    expect(planSid(b, 1, "ntsc").cia60).toBe(false); // an NTSC KERNAL already ticks at 60 Hz
    expect(planSid(b, 2, "pal").cia60).toBe(false); // the bit is per song
  });
  test("what it cannot play wrongly it refuses, in plain words", async () => {
    const { planSid } = await import("../src/sidplayer");
    const under = toneSid(); under.writeUInt16LE(0xa000, 0x7c);
    expect(() => planSid(under, 1, "pal")).toThrow(/under the ROMs or I\/O/);
    const low = toneSid(); low.writeUInt16LE(0x0300, 0x7c);
    expect(() => planSid(low, 1, "pal")).toThrow(/free RAM/);
    const badInit = toneSid(); badInit.writeUInt16BE(0xe000, 10);
    expect(() => planSid(badInit, 1, "pal")).toThrow(/init or play/);
    expect(() => planSid(toneSid(2), 5, "pal")).toThrow(/songs 1 to 2/);
  });
  test("a tune with no play routine only gets its init called, and RSID and multi-SID get a warning", async () => {
    const { planSid } = await import("../src/sidplayer");
    const noPlay = toneSid(); noPlay.writeUInt16BE(0, 12);
    const p = planSid(noPlay, 1, "pal");
    expect(p.writes[1].data.subarray(26, 29).toString("hex")).toBe("eaeaea");
    expect(p.warnings.join(" ")).toContain("own interrupt");
    const rsid = toneSid(); rsid.write("RSID", 0, "latin1");
    expect(planSid(rsid, 1, "pal").warnings.join(" ")).toContain("RSID");
    const two = toneSid(); two.writeUInt16BE(3, 4); two[0x7a] = 0xe4;
    expect(planSid(two, 1, "pal").warnings.join(" ")).toContain("2 SID chips");
  });
});
