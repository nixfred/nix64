// The shelf without an engine: names are cleaned, only C64 media is accepted, and zips from the Internet
// Archive are opened by reading real zip files made by another program (python's zipfile), not by our own writer.
// Run: bun test tests/shelf.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "nix64-shelf-"));
process.env.NIX64_HOME = home;
const { addToShelf, cleanName, listShelf, unzipMedia, removeFromShelf } = await import("../src/shelf");
const { createD64 } = await import("../src/d64");
const python = Bun.spawnSync(["python3", "--version"]).exitCode === 0;

describe("the shelf", () => {
  test("names are cleaned and only C64 media gets in", () => {
    expect(cleanName("../../etc/passwd.d64")).toBe("passwd.d64");
    expect(cleanName("a b (1).D64")).toBe("a b (1).D64");
    expect(() => cleanName("notes.txt")).toThrow(/not a C64 media file/);
    expect(() => cleanName(".d64")).toThrow();
  });
  test("a second file with the same name does not overwrite the first", () => {
    const a = addToShelf("same.d64", createD64("A", "01")), b = addToShelf("same.d64", createD64("B", "02"));
    expect(a).toBe("same.d64");
    expect(b).toBe("same-2.d64");
    expect(listShelf().find((i) => i.name === "same.d64")!.title).toContain("A");
    expect(listShelf().find((i) => i.name === "same-2.d64")!.title).toContain("B");
    removeFromShelf("same-2.d64");
    expect(listShelf().some((i) => i.name === "same-2.d64")).toBe(false);
  });
  test("an empty or oversized file is refused", () => {
    expect(() => addToShelf("e.d64", new Uint8Array(0))).toThrow(/empty/);
    expect(() => addToShelf("big.d64", new Uint8Array(65 * 1024 * 1024))).toThrow(/64 MB/);
  });
});

describe("zip", () => {
  test.skipIf(!python)("media inside a real zip, stored or deflated, comes out byte for byte; other files do not", () => {
    const disk = createD64("ZIPPED", "ab");
    const z = join(home, "t.zip");
    writeFileSync(join(home, "a.d64"), disk);
    writeFileSync(join(home, "readme.txt"), "not media");
    const r = Bun.spawnSync(["python3", "-c", `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],"w")
z.write(sys.argv[2],"dir/disk one.d64",compress_type=zipfile.ZIP_DEFLATED)
z.write(sys.argv[2],"stored.d64",compress_type=zipfile.ZIP_STORED)
z.write(sys.argv[3],"readme.txt",compress_type=zipfile.ZIP_DEFLATED)
z.close()`, z, join(home, "a.d64"), join(home, "readme.txt")]);
    expect(r.exitCode).toBe(0);
    const out = unzipMedia(new Uint8Array(readFileSync(z)));
    expect(out.map((o) => o.name).sort()).toEqual(["disk one.d64", "stored.d64"]);
    for (const o of out) expect(Buffer.from(o.data).equals(disk)).toBe(true);
  });
  test("something that is not a zip is refused", () => {
    expect(() => unzipMedia(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a zip/);
  });
});
