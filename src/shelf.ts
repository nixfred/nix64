// The shelf: the disks, tapes and cartridges you own, in one folder you can see (~/Nix64/shelf).
// Nix64 never bundles ROMs or commercial software. What is here is what you put here, by dropping a
// file on the window, importing it, or fetching it yourself from the Internet Archive.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { readDir } from "./d64";
import { paths } from "./paths";

export const MEDIA_EXT = new Set([".d64", ".d71", ".d81", ".g64", ".x64", ".t64", ".tap", ".crt", ".prg", ".p00", ".vsf"]);
export type Kind = "disk" | "tape" | "cart" | "prg" | "snapshot" | "file";
export const kindOf = (name: string): Kind => {
  const e = extname(name).toLowerCase();
  return [".d64", ".d71", ".d81", ".g64", ".x64"].includes(e) ? "disk" : [".tap", ".t64"].includes(e) ? "tape" : e === ".crt" ? "cart" : [".prg", ".p00"].includes(e) ? "prg" : e === ".vsf" ? "snapshot" : "file";
};

export type ShelfItem = { name: string; kind: Kind; size: number; sha: string; title?: string; mtime: number };
const shaCache = new Map<string, { key: string; sha: string; title?: string }>();

export function listShelf(): ShelfItem[] {
  mkdirSync(paths.shelf, { recursive: true });
  const out: ShelfItem[] = [];
  for (const name of readdirSync(paths.shelf).sort()) {
    const f = join(paths.shelf, name), st = statSync(f);
    if (!st.isFile() || !MEDIA_EXT.has(extname(name).toLowerCase())) continue;
    const key = `${st.size}:${st.mtimeMs}`;
    let c = shaCache.get(f);
    if (!c || c.key !== key) {
      const data = readFileSync(f);
      const dir = name.toLowerCase().endsWith(".d64") ? readDir(data) : null;
      c = { key, sha: createHash("sha256").update(data).digest("hex"), title: dir ? `${dir.name} · ${dir.entries.length} files` : undefined };
      shaCache.set(f, c);
    }
    out.push({ name, kind: kindOf(name), size: st.size, sha: c.sha, title: c.title, mtime: st.mtimeMs });
  }
  return out;
}

export function shelfPath(name: string): string {
  if (name !== basename(name) || name.startsWith(".")) throw new Error("not a shelf file name");
  const f = join(paths.shelf, name);
  if (!existsSync(f)) throw new Error(`${name} is not on your shelf`);
  return f;
}

/** A safe file name: no folders, no leading dot, nothing odd. */
export function cleanName(raw: string): string {
  const n = basename(raw).replace(/[^\w.+() -]/g, "_").replace(/^\.+/, "").slice(0, 120);
  if (!n || !MEDIA_EXT.has(extname(n).toLowerCase())) throw new Error(`${raw || "that file"} is not a C64 media file (${[...MEDIA_EXT].join(" ")})`);
  return n;
}

const MAX = 64 * 1024 * 1024;
export function addToShelf(rawName: string, data: Uint8Array): string {
  if (data.length > MAX) throw new Error("that file is larger than 64 MB");
  if (!data.length) throw new Error("that file is empty");
  let name = cleanName(rawName);
  const ext = extname(name), stem = name.slice(0, -ext.length);
  for (let i = 2; existsSync(join(paths.shelf, name)); i++) name = `${stem}-${i}${ext}`;
  mkdirSync(paths.shelf, { recursive: true });
  writeFileSync(join(paths.shelf, name), data);
  return name;
}

export function removeFromShelf(name: string): void {
  rmSync(shelfPath(name));
}

// ---------- zip: archive items are mostly zips of disk images ----------

/** Pull the media files out of a zip. Reads the central directory; handles stored and deflated entries. */
export function unzipMedia(zip: Uint8Array): { name: string; data: Uint8Array }[] {
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) break;
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), usize = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28), elen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), lho = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nlen).toString();
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/") || !MEDIA_EXT.has(extname(name).toLowerCase()) || usize > MAX) continue;
    const dstart = lho + 30 + b.readUInt16LE(lho + 26) + b.readUInt16LE(lho + 28);
    const raw = b.subarray(dstart, dstart + csize);
    // the size a zip DECLARES is the author's word: cap what inflate may really produce, or a few KB can expand to gigabytes
    let data: Uint8Array | null;
    try { data = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX }) : null; } catch { data = null; } // too big or damaged: skip this entry
    if (data) out.push({ name: basename(name), data: new Uint8Array(data) });
  }
  return out;
}

// ---------- the Internet Archive (only when you ask) ----------

const ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const FILE_OK = /^[^\\\0]{1,200}$/;

export async function archiveSearch(q: string): Promise<{ id: string; title: string; downloads?: number }[]> {
  const u = new URL("https://archive.org/advancedsearch.php");
  u.searchParams.set("q", `(${q.replace(/[()"]/g, " ")}) AND mediatype:(software OR data)`);
  for (const f of ["identifier", "title", "downloads"]) u.searchParams.append("fl[]", f);
  u.searchParams.set("rows", "20"); u.searchParams.set("output", "json");
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`the Internet Archive answered ${r.status}`);
  const j = (await r.json()) as { response: { docs: { identifier: string; title?: string; downloads?: number }[] } };
  return j.response.docs.map((d) => ({ id: d.identifier, title: d.title ?? d.identifier, downloads: d.downloads }));
}

export async function archiveFiles(id: string): Promise<{ name: string; size: number }[]> {
  if (!ID_OK.test(id)) throw new Error("bad item id");
  const r = await fetch(`https://archive.org/metadata/${id}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`the Internet Archive answered ${r.status}`);
  const j = (await r.json()) as { files?: { name: string; size?: string }[] };
  return (j.files ?? [])
    .filter((f) => /\.(d64|g64|d71|d81|t64|tap|crt|prg|zip)$/i.test(f.name))
    .map((f) => ({ name: f.name, size: Number(f.size ?? 0) }))
    .filter((f) => f.size > 0 && f.size <= 200 * 1024 * 1024);
}

const MAX_DOWNLOAD = 200 * 1024 * 1024;
/** https, and archive.org itself or one of its subdomains (the Archive serves downloads from its own storage hosts, e.g. ia800000.us.archive.org). */
export function archiveHost(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && (x.hostname === "archive.org" || x.hostname.endsWith(".archive.org"));
  } catch { return false; }
}

/** Download one file from an archive item onto the shelf. Zips are opened and their media files added. */
export async function archiveFetch(id: string, file: string): Promise<string[]> {
  if (!ID_OK.test(id) || !FILE_OK.test(file)) throw new Error("bad item or file name");
  const url = `https://archive.org/download/${id}/${file.split("/").map(encodeURIComponent).join("/")}`;
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`the Internet Archive answered ${r.status} for ${file}`);
  if (!archiveHost(r.url)) { void r.body?.cancel(); throw new Error("the download was sent somewhere other than archive.org: refused"); }
  const declared = Number(r.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD) { void r.body?.cancel(); throw new Error(`that file is ${Math.round(declared / 1048576)} MB: too large to fetch (the limit is ${MAX_DOWNLOAD / 1048576} MB)`); }
  const data = new Uint8Array(await r.arrayBuffer());
  if (data.length > MAX_DOWNLOAD) throw new Error(`that download is larger than ${MAX_DOWNLOAD / 1048576} MB: refused`);
  if (/\.zip$/i.test(file)) {
    const media = unzipMedia(data);
    if (!media.length) throw new Error("that zip has no disk, tape or cartridge images in it");
    return media.map((m) => addToShelf(m.name, m.data));
  }
  return [addToShelf(basename(file), data)];
}
