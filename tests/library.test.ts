// The library without an engine: a folder you fill yourself is indexed into a catalog, searched, and one
// title at a time is copied to the shelf. The zips are made by python's zipfile (another program), and the
// fixture files are made here: nothing in this test comes from a real collection.
// Run: bun test tests/library.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "nix64-lib-"));
const lib = join(home, "my library"); // a space in the path on purpose
process.env.NIX64_HOME = home;
process.env.NIX64_LIBRARY = lib;
const { expandPath, indexLibrary, libraryRoot, loadCatalog, searchLibrary, sevenZip, stageOnShelf, zipNames } = await import("../src/library");
const { saveSettings, loadSettings } = await import("../src/settings");
const { createD64 } = await import("../src/d64");
const { listShelf } = await import("../src/shelf");
const { paths } = await import("../src/paths"); // whichever home the first test file in this process chose: paths.ts is evaluated once, so never assume ours
const python = Bun.spawnSync(["python3", "--version"]).exitCode === 0;

afterAll(() => rmSync(home, { recursive: true, force: true }));

const put = (rel: string, data: Uint8Array | string) => { const f = join(lib, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, data); };
const disk = (label: string) => createD64(label, "01");
const prg = Buffer.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00]); // a tiny BASIC stub
const makeZip = (path: string, files: Record<string, Uint8Array | string>) => {
  const spec = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString("base64")]));
  mkdirSync(join(path, ".."), { recursive: true });
  const r = Bun.spawnSync(["python3", "-I", "-c", "import sys,json,base64,zipfile\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)\nfor k,v in json.load(sys.stdin).items(): z.writestr(k,base64.b64decode(v))\nz.close()", path], { stdin: Buffer.from(JSON.stringify(spec)) });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

describe("the library path", () => {
  test("~ means home, relative means nothing, NIX64_LIBRARY wins, the default is ~/c64-library", () => {
    expect(expandPath("~/x/y")).toBe(join(process.env.HOME ?? "/tmp", "x/y"));
    expect(expandPath("relative/dir")).toBe("");
    expect(expandPath("")).toBe("");
    expect(libraryRoot()).toBe(lib);
    delete process.env.NIX64_LIBRARY;
    expect(libraryRoot()).toBe(join(process.env.HOME ?? "/tmp", "c64-library"));
    saveSettings({ library: { path: "/srv/c64" } });
    expect(libraryRoot()).toBe("/srv/c64");
    expect(saveSettings({ library: { path: "not/absolute" } }).library.path).toBe(""); // a relative path would mean a different folder to every program
    expect(loadSettings().library.path).toBe("");
    process.env.NIX64_LIBRARY = lib;
  });
});

describe("indexing", () => {
  test("a missing folder is a clear error, not an empty catalog", async () => {
    await expect(indexLibrary(join(home, "nope"))).rejects.toThrow(/does not exist/);
  });

  test.skipIf(!python)("loose files and zipped files are listed; originals, dotfiles, symlinks, other files are not", async () => {
    put("tosec/Commodore 64/Games/Chuck Yeager (1987)(Electronic Arts).d64", disk("CHUCK"));
    put("tosec/Commodore 64/Games/Elite (1985)(Firebird).t64", Buffer.alloc(300, 1));
    put("ghostware/Roms/Zork I (1984)(Infocom).prg", prg);
    put("ghostware/Roms/readme.txt", "hello");
    put("ghostware/Roms/.hidden.d64", disk("HID"));
    put("manuals/Manual.pdf", "%PDF");
    makeZip(join(lib, "tosec/Commodore 64/Zips/Wizball (1987)(Ocean).zip"), { "Wizball (1987)(Ocean).d64": disk("WIZBALL"), "Wizball.nfo": "info", "sub/Wizball side 2.d64": disk("SIDE2") });
    makeZip(join(lib, "tosec/original-download.zip"), { "Should Not Be Listed.d64": disk("NO") }); // sits directly in a SET folder: the download itself
    symlinkSync(join(lib, "ghostware/Roms/Zork I (1984)(Infocom).prg"), join(lib, "ghostware/Roms/link.prg"));
    const cat = await indexLibrary(lib);
    const names = cat.items.map((i) => i.name).sort();
    expect(names).toEqual(["Chuck Yeager (1987)(Electronic Arts)", "Elite (1985)(Firebird)", "Wizball (1987)(Ocean)", "Wizball side 2", "Zork I (1984)(Infocom)"]);
    expect(cat.count).toBe(5);
    expect(cat.sets).toEqual({ tosec: 4, ghostware: 1 });
    expect(cat.kinds).toEqual({ disk: 3, tape: 1, prg: 1 });
    expect(cat.skipped.zips).toBe(1);
    expect(cat.items.find((i) => i.name === "Wizball side 2")!.zip).toBe("sub/Wizball side 2.d64");
    // the catalog on disk is what a later process reads
    const again = loadCatalog()!;
    expect(again.count).toBe(5);
    expect(again.root).toBe(lib);
  });

  test.skipIf(!python)("zipNames reads the central directory only and ignores non-media", () => {
    const z = join(lib, "tosec/Commodore 64/Zips/Wizball (1987)(Ocean).zip");
    expect(zipNames(z).map((e) => e.name).sort()).toEqual(["Wizball (1987)(Ocean).d64", "sub/Wizball side 2.d64"]);
    expect(zipNames(join(lib, "ghostware/Roms/readme.txt"))).toEqual([]); // not a zip at all
  });
});

describe("searching", () => {
  test.skipIf(!python)("every word must match; names first; kind and set narrow it", () => {
    const cat = loadCatalog()!;
    expect(searchLibrary(cat, "wizball").total).toBe(2);
    // the second title sits in the zip named (Ocean): the path counts, but a match in the title itself ranks first
    expect(searchLibrary(cat, "wizball ocean").items.map((i) => i.name)).toEqual(["Wizball (1987)(Ocean)", "Wizball side 2"]);
    expect(searchLibrary(cat, "WIZBALL side").items[0].name).toBe("Wizball side 2");
    expect(searchLibrary(cat, "", { kind: "tape" }).items.map((i) => i.name)).toEqual(["Elite (1985)(Firebird)"]);
    expect(searchLibrary(cat, "", { set: "ghostware" }).total).toBe(1);
    expect(searchLibrary(cat, "zip").total).toBe(2); // the folder named Zips counts: a path is part of what you search
    expect(searchLibrary(cat, "no such title").total).toBe(0);
    expect(searchLibrary(cat, "", { limit: 2 }).items.length).toBe(2);
  });
});

describe("starting a title", () => {
  test.skipIf(!python)("a loose file and a zipped file both land on the shelf byte for byte, and a repeat adds nothing", async () => {
    const cat = loadCatalog()!;
    const loose = cat.items.find((i) => i.name.startsWith("Chuck"))!, zipped = cat.items.find((i) => i.name === "Wizball side 2")!;
    const a = await stageOnShelf(loose, lib), b = await stageOnShelf(zipped, lib);
    expect(listShelf().find((i) => i.name === a)!.kind).toBe("disk");
    expect(readFileSync(join(paths.shelf, a)).equals(disk("CHUCK"))).toBe(true);
    expect(readFileSync(join(paths.shelf, b)).equals(disk("SIDE2"))).toBe(true);
    const before = listShelf().length;
    expect(await stageOnShelf(loose, lib)).toBe(a);
    expect(listShelf().length).toBe(before);
  });

  test.skipIf(!python)("a catalog entry that points outside the library, or at a file that is gone, is refused", async () => {
    const cat = loadCatalog()!;
    const evil = { ...cat.items[0], path: "../outside.d64" };
    writeFileSync(join(home, "outside.d64"), disk("OUT"));
    await expect(stageOnShelf(evil, lib)).rejects.toThrow(/outside the library/);
    rmSync(join(lib, "ghostware/Roms/Zork I (1984)(Infocom).prg"));
    const zork = cat.items.find((i) => i.name.startsWith("Zork"))!;
    await expect(stageOnShelf(zork, lib)).rejects.toThrow(/gone from the library|outside the library/);
    expect(existsSync(join(home, "outside.d64"))).toBe(true); // and nothing was touched
  });
});

describe("names that are not UTF-8", () => {
  test("a file named with DOS code page 437 bytes is catalogued under its real name, and can still be opened", async () => {
    const lib2 = join(home, "lib2");
    mkdirSync(join(lib2, "ghostware"), { recursive: true });
    const raw = Buffer.concat([Buffer.from("720"), Buffer.from([0xf8]), Buffer.from(" (USA).D64")]); // "720° (USA).D64" as the 1990s zip tools stored it
    writeFileSync(Buffer.concat([Buffer.from(join(lib2, "ghostware") + "/"), raw]), disk("SEVENTWENTY"));
    writeFileSync(join(lib2, "ghostware/Plain (USA).D64"), disk("PLAIN"));
    const cat = await indexLibrary(lib2);
    expect(cat.skipped.unreadable).toBe(0);
    expect(cat.items.map((i) => i.name).sort()).toEqual(["720° (USA)", "Plain (USA)"]);
    const odd = cat.items.find((i) => i.name.startsWith("720"))!;
    expect(odd.pb).toBeDefined(); // the exact bytes are kept
    expect(cat.items.find((i) => i.name === "Plain (USA)")!.pb).toBeUndefined(); // an ordinary name carries nothing extra
    expect(searchLibrary(loadCatalog()!, "720°").total).toBe(1);
    const shelf = await stageOnShelf(odd, lib2);
    expect(readFileSync(join(paths.shelf, shelf)).equals(disk("SEVENTWENTY"))).toBe(true);
    await indexLibrary(lib); // leave the catalog as the others expect
  });
});

describe("titles inside .7z archives (TOSEC ships them this way)", () => {
  test.skipIf(!sevenZip())("they are listed without unpacking and one title is read out on Start, byte for byte", async () => {
    const lib3 = join(home, "lib3"), src = join(home, "src7");
    mkdirSync(join(lib3, "tosec/Games [D64]"), { recursive: true });
    mkdirSync(join(src, "Zap [a]"), { recursive: true });
    writeFileSync(join(src, "Zap [a]/Zap [a] (1990)(Nobody).d64"), disk("ZAP"));
    writeFileSync(join(src, "Zap [a]/notes.txt"), "not media");
    writeFileSync(join(src, "Boom (1991)(Nobody).prg"), prg);
    const r = Bun.spawnSync([sevenZip()!, "a", "-bd", join(lib3, "tosec/Games [D64]/Games - [D64].7z"), "."], { cwd: src });
    expect(r.exitCode).toBe(0);
    const cat = await indexLibrary(lib3);
    expect(cat.items.map((i) => i.name).sort()).toEqual(["Boom (1991)(Nobody)", "Zap [a] (1990)(Nobody)"]); // [brackets] are in real TOSEC names
    expect(cat.items.every((i) => i.ar === "7z")).toBe(true);
    const zap = cat.items.find((i) => i.name.startsWith("Zap"))!;
    const shelf = await stageOnShelf(zap, lib3);
    expect(readFileSync(join(paths.shelf, shelf)).equals(disk("ZAP"))).toBe(true);
    await indexLibrary(lib); // leave the catalog as the others expect
  });
});
