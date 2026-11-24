// The library: a folder you fill yourself (default ~/c64-library) and a catalog of what is in it.
// Nix64 ships no ROMs, disks or tapes and downloads none for you. You point it at a folder, it walks the
// folder once (nix64 library index) and writes a plain JSON catalog; the shell then browses the catalog
// and starts a title by copying that one file to your shelf and loading it the way the shelf does.
//
// Layout it expects, though any folder works:  LIBRARY/SET/...files.  SET is the first folder level
// (ghostware, tosec, manuals ...). Files may be loose, or inside .zip files, which are listed from their
// central directory without unpacking anything. The big original downloads that sit directly in a SET
// folder (LIBRARY/SET/*.zip) are skipped: they are the source of the unpacked files next to them.
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { paths } from "./paths";
import { loadSettings } from "./settings";
import { addToShelf, cleanName, kindOf, listShelf, unzipMedia, type Kind } from "./shelf";

/** What the library lists: the shelf's media kinds, except machine snapshots (those belong to one machine). */
export const LIB_EXT = new Set([".d64", ".d71", ".d81", ".g64", ".x64", ".t64", ".tap", ".crt", ".prg", ".p00", ".sid"]);
const MAX_FILE = 64 * 1024 * 1024; // the shelf's own limit
const MAX_ITEMS = 2_000_000;

/** `path` is the path inside the library as text. When a file name is not valid UTF-8 (old zips store DOS code page 437: "720°", "Amöba"),
 *  `path` shows it decoded as CP437 and `pb` keeps the exact bytes (base64) so the file can still be opened. */
export type LibItem = { id: string; set: string; path: string; pb?: string; zip?: string; /** "7z" when `zip` names a file inside a .7z (the default is a .zip) */ ar?: "7z"; name: string; kind: Kind; size: number };
export type Catalog = { version: 1; root: string; indexedAt: string; ms: number; count: number; sets: Record<string, number>; kinds: Record<string, number>; skipped: { zips: number; unreadable: number; sevenZ: number }; items: LibItem[] };

/** "~" and "~/x" mean your home folder. Anything that is not absolute after that is refused (empty string). */
export function expandPath(p: string): string {
  const home = process.env.HOME ?? "/tmp";
  const t = p.trim();
  const e = t === "~" ? home : t.startsWith("~/") ? join(home, t.slice(2)) : t;
  return e.startsWith("/") ? resolve(e) : "";
}

/** NIX64_LIBRARY, else the library.path setting, else ~/c64-library. */
export function libraryRoot(): string {
  return expandPath(process.env.NIX64_LIBRARY ?? "") || expandPath(loadSettings().library.path) || join(process.env.HOME ?? "/tmp", "c64-library");
}

const catalogFile = () => join(paths.data, "library.json");
const idOf = (path: string | Buffer, zip?: string) => createHash("sha1").update(path).update(`\0${zip ?? ""}`).digest("hex").slice(0, 12);
const SLASH = Buffer.from("/");

// DOS code page 437, bytes 0x80 to 0xFF: how zips written on DOS and Windows name "720°" or "Amöba"
const CP437 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";
export const fromCp437 = (b: Buffer): string => { let o = ""; for (const x of b) o += x < 0x80 ? String.fromCharCode(x) : CP437[x - 0x80]; return o; };
/** Text for a file name's bytes: UTF-8 when it is valid UTF-8, else CP437. */
const nameText = (b: Buffer): { text: string; exact: boolean } => { const t = b.toString("utf8"); return t.includes("\ufffd") ? { text: fromCp437(b), exact: false } : { text: t, exact: true }; };

/** The media names inside a zip, from its central directory only (a zip of a few KB or a few GB costs the same: one small read). */
export function zipNames(file: string | Buffer): { name: string; size: number }[] {
  const fd = openSync(file, "r");
  try {
    const total = statSync(file).size;
    if (total < 22) return [];
    const tailLen = Math.min(total, 65557);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, total - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return [];
    const count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xffffffff || cdSize === 0xffffffff || count === 0xffff || cdSize > 16 * 1024 * 1024 || cdOff + cdSize > total) return []; // zip64 or absurd: not a per-title zip
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOff);
    const out: { name: string; size: number }[] = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const usize = cd.readUInt32LE(p + 24), nlen = cd.readUInt16LE(p + 28), elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      const name = cd.subarray(p + 46, p + 46 + nlen).toString();
      p += 46 + nlen + elen + clen;
      if (!name.endsWith("/") && LIB_EXT.has(extname(name).toLowerCase()) && usize > 0 && usize <= MAX_FILE) out.push({ name, size: usize });
    }
    return out;
  } finally { closeSync(fd); }
}

/** The 7-Zip program, if this machine has one (7z, 7zz or 7za). Without it, .7z archives are left out of the catalog and counted. */
export const sevenZip = (): string | null => Bun.which("7z") ?? Bun.which("7zz") ?? Bun.which("7za");

/** A process argument must be text: an archive whose own file name is not valid UTF-8 cannot be handed to 7-Zip, so it is refused plainly. */
const archiveArg = (file: Buffer): string => { const t = file.toString("utf8"); if (t.includes("\ufffd")) throw new Error("this archive's file name is not valid UTF-8, so 7-Zip cannot be given it"); return t; };

/** The media files inside a .7z, listed by 7-Zip (`l -slt`): the archive is never unpacked. */
export async function sevenNames(file: Buffer): Promise<{ name: string; size: number }[]> {
  const bin = sevenZip();
  if (!bin) return [];
  const p = Bun.spawn(["nice", "-n", "10", bin, "l", "-ba", "-slt", "-sccUTF-8", "-bd", "--", archiveArg(file)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const text = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error("7z could not list that archive");
  const out: { name: string; size: number }[] = [];
  for (const rec of text.split("\n\n")) {
    const f: Record<string, string> = {};
    for (const line of rec.split("\n")) { const i = line.indexOf(" = "); if (i > 0) f[line.slice(0, i)] = line.slice(i + 3); }
    const name = f.Path, size = Number(f.Size);
    if (!name || f.Folder === "+" || !LIB_EXT.has(extname(name).toLowerCase()) || !(size > 0) || size > MAX_FILE) continue;
    out.push({ name, size });
  }
  return out;
}

/** One file out of a .7z, to memory (`e -so`: no path is ever written to disk). Solid archives decode up to the file, so a big archive takes a while. */
async function sevenExtract(file: Buffer, inner: string): Promise<Uint8Array> {
  const bin = sevenZip() ?? (() => { throw new Error("that title is inside a .7z archive and this machine has no 7z (install 7-Zip: pacman -S 7zip)"); })();
  const p = Bun.spawn(["nice", "-n", "10", bin, "e", "-so", "-spd", "-bd", "-sccUTF-8", "--", archiveArg(file), inner], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => p.kill(), 300_000);
  try {
    const data = new Uint8Array(await new Response(p.stdout).arrayBuffer());
    if ((await p.exited) !== 0 || !data.length) throw new Error(`7z could not read ${inner} out of the archive`);
    if (data.length > MAX_FILE) throw new Error("that file is larger than 64 MB");
    return data;
  } finally { clearTimeout(timer); }
}

/** Walk the library and write the catalog. Never follows a symlink, never opens a file but zips, and gives the event loop back as it goes so a running shell stays alive. */
export async function indexLibrary(root = libraryRoot(), progress?: (n: number) => void): Promise<Catalog> {
  const t0 = Date.now();
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`the library folder ${root} does not exist. Make it and put your files in it, or set another path (Settings, or NIX64_LIBRARY).`);
  const items: LibItem[] = [];
  const skipped = { zips: 0, unreadable: 0, sevenZ: 0 };
  const rootB = Buffer.from(root);
  const stack: Buffer[] = [rootB];
  let seen = 0;
  while (stack.length && items.length < MAX_ITEMS) {
    const dir = stack.pop()!;
    let names: Buffer[];
    try { names = readdirSync(dir, "buffer"); } catch { skipped.unreadable++; continue; }
    names.sort((a, b) => Buffer.compare(b, a)); // popped from the end, so this lists A to Z
    for (const nb of names) {
      if (nb[0] === 0x2e) continue; // dotfiles
      const full = Buffer.concat([dir, SLASH, nb]);
      let st;
      try { st = lstatSync(full); } catch { skipped.unreadable++; continue; }
      if (st.isDirectory()) { stack.push(full); continue; }
      if (!st.isFile()) continue; // symlinks, sockets: not followed
      const relB = full.subarray(rootB.length + 1), rel = nameText(relB);
      const parts = rel.text.split("/"), set = parts.length > 1 ? parts[0] : "";
      const leaf = nameText(nb).text, ext = extname(leaf).toLowerCase();
      const pb = rel.exact ? undefined : relB.toString("base64");
      if (++seen % 400 === 0) { progress?.(items.length); await Bun.sleep(0); }
      if (ext === ".zip") {
        if (parts.length === 2) { skipped.zips++; continue; } // LIBRARY/SET/original-download.zip
        try { for (const z of zipNames(full)) items.push({ id: idOf(relB, z.name), set, path: rel.text, pb, zip: z.name, name: basename(z.name).replace(/\.[^.]+$/, ""), kind: kindOf(z.name), size: z.size }); } catch { skipped.unreadable++; }
      } else if (ext === ".7z") {
        if (parts.length === 2) { skipped.zips++; continue; }
        if (!sevenZip()) { skipped.sevenZ++; continue; }
        try { for (const z of await sevenNames(full)) items.push({ id: idOf(relB, z.name), set, path: rel.text, pb, zip: z.name, ar: "7z", name: basename(z.name).replace(/\.[^.]+$/, ""), kind: kindOf(z.name), size: z.size }); } catch { skipped.unreadable++; }
      } else if (LIB_EXT.has(ext) && st.size > 0 && st.size <= MAX_FILE) {
        items.push({ id: idOf(relB), set, path: rel.text, pb, name: leaf.replace(/\.[^.]+$/, ""), kind: kindOf(leaf), size: st.size });
      }
    }
  }
  const sets: Record<string, number> = {}, kinds: Record<string, number> = {};
  for (const i of items) { sets[i.set || "(top)"] = (sets[i.set || "(top)"] ?? 0) + 1; kinds[i.kind] = (kinds[i.kind] ?? 0) + 1; }
  const cat: Catalog = { version: 1, root, indexedAt: new Date().toISOString(), ms: Date.now() - t0, count: items.length, sets, kinds, skipped, items };
  mkdirSync(paths.data, { recursive: true });
  const tmp = `${catalogFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cat));
  renameSync(tmp, catalogFile()); // a reader sees the old catalog or the new one, never half of one
  loaded = null;
  return cat;
}

let loaded: { key: string; cat: Catalog; hay: string[] } | null = null;

/** The catalog on disk, or null when the library was never indexed (or the file is damaged). Cached until the file changes. */
export function loadCatalog(): (Catalog & { hay: string[] }) | null {
  try {
    const f = catalogFile(), st = statSync(f), key = `${st.size}:${st.mtimeMs}`;
    if (!loaded || loaded.key !== key) {
      const cat = JSON.parse(readFileSync(f, "utf8")) as Catalog;
      if (cat.version !== 1 || !Array.isArray(cat.items)) return null;
      loaded = { key, cat, hay: cat.items.map((i) => `${i.set}/${i.path}/${i.zip ?? ""}`.toLowerCase()) };
    }
    return { ...loaded.cat, hay: loaded.hay };
  } catch { return null; }
}

/** Every word must appear in the title or its path; titles that match in their own name come first, shorter first. */
export function searchLibrary(cat: { items: LibItem[]; hay: string[] }, q: string, opts: { kind?: string; set?: string; limit?: number } = {}): { items: LibItem[]; total: number } {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean), limit = Math.min(500, Math.max(1, opts.limit ?? 50));
  const hits: { i: LibItem; s: number }[] = [];
  for (let n = 0; n < cat.items.length; n++) {
    const it = cat.items[n];
    if (opts.kind && it.kind !== opts.kind) continue;
    if (opts.set && it.set !== opts.set) continue;
    const hay = cat.hay[n];
    if (!words.every((w) => hay.includes(w))) continue;
    const nm = it.name.toLowerCase();
    hits.push({ i: it, s: (words.every((w) => nm.includes(w)) ? 0 : 1e6) + nm.length });
  }
  hits.sort((a, b) => a.s - b.s || (a.i.name < b.i.name ? -1 : 1));
  return { items: hits.slice(0, limit).map((h) => h.i), total: hits.length };
}

/** Put one catalogued title on the shelf and return its shelf name. The path comes from the catalog this process wrote, never from a client, and must still resolve inside the library. */
export async function stageOnShelf(item: LibItem, root = libraryRoot()): Promise<string> {
  const rootB = Buffer.from(root), relB = item.pb ? Buffer.from(item.pb, "base64") : Buffer.from(item.path);
  let real: Buffer, rootReal: Buffer;
  try { real = realpathSync(Buffer.concat([rootB, SLASH, relB]), { encoding: "buffer" }) as Buffer; rootReal = realpathSync(rootB, { encoding: "buffer" }) as Buffer; } catch { throw new Error(`${item.path} is gone from the library. Index again (nix64 library index).`); }
  if (!real.equals(rootReal) && !real.subarray(0, rootReal.length + 1).equals(Buffer.concat([rootReal, SLASH]))) throw new Error("that file is outside the library folder");
  let data: Uint8Array;
  if (item.zip && item.ar === "7z") {
    data = await sevenExtract(real, item.zip);
  } else if (item.zip) {
    const got = unzipMedia(readFileSync(real), item.zip);
    if (!got.length) throw new Error(`${item.zip} could not be read out of ${item.path}`);
    data = got[0].data;
  } else {
    if (statSync(real).size > MAX_FILE) throw new Error("that file is larger than 64 MB");
    data = readFileSync(real);
  }
  // The same title launched twice is one shelf file, not two: look for the same bytes before adding
  const sha = createHash("sha256").update(data).digest("hex");
  const have = listShelf().find((s) => s.sha === sha && s.kind === item.kind);
  if (have) return have.name;
  return addToShelf(cleanName(basename(item.zip ?? item.path)), data);
}
