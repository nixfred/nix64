// SID music files (.sid): the PSID and RSID formats. Nix64 only READS the header, to tell you what a tune is
// (title, author, how many songs, which chip it wants). The tune itself is played by the machine's own emulated SID chip:
// VICE loads the file, installs a small player and runs it. Format notes: the HVSC / SIDPLAY "SID file format" description.

export type SidInfo = {
  format: "PSID" | "RSID";
  version: number;
  songs: number;
  startSong: number;
  title: string;
  author: string;
  released: string;
  /** which video standard the tune was written for ("either" when it does not care) */
  clock: "pal" | "ntsc" | "either" | "unknown";
  /** which SID chip it was written for */
  model: "6581" | "8580" | "either" | "unknown";
  /** how many SID chips it uses (version 3 files can use 2 or 3) */
  sids: number;
  /** RSID tunes expect a real C64 environment (they may use the interrupts and CIA timers themselves) */
  needsRealC64: boolean;
};

const text = (b: Buffer, at: number, len: number): string => {
  const raw = b.subarray(at, at + len);
  const end = raw.indexOf(0);
  // the header is Latin-1; control characters are noise, never markup
  return raw.subarray(0, end < 0 ? len : end).toString("latin1").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
};

/** Read the header of a .sid file. Throws a plain-words error when it is not a SID file. */
export function parseSid(b: Buffer): SidInfo {
  if (b.length < 0x76) throw new Error("that is too short to be a SID file");
  const magic = b.subarray(0, 4).toString("latin1");
  if (magic !== "PSID" && magic !== "RSID") throw new Error("that is not a SID file (it does not start with PSID or RSID)");
  const version = b.readUInt16BE(4);
  if (version < 1 || version > 4) throw new Error(`SID file version ${version} is not one Nix64 knows`);
  const songs = b.readUInt16BE(14), startSong = b.readUInt16BE(16);
  if (songs < 1 || songs > 256) throw new Error(`a SID file with ${songs} songs is not right`);
  const info: SidInfo = {
    format: magic as "PSID" | "RSID",
    version,
    songs,
    startSong: startSong >= 1 && startSong <= songs ? startSong : 1,
    title: text(b, 0x16, 32),
    author: text(b, 0x36, 32),
    released: text(b, 0x56, 32),
    clock: "unknown",
    model: "unknown",
    sids: 1,
    needsRealC64: magic === "RSID",
  };
  if (version >= 2 && b.length >= 0x7c) {
    const flags = b.readUInt16BE(0x76);
    const clock = (flags >> 2) & 3, model = (flags >> 4) & 3;
    info.clock = clock === 1 ? "pal" : clock === 2 ? "ntsc" : clock === 3 ? "either" : "unknown";
    info.model = model === 1 ? "6581" : model === 2 ? "8580" : model === 3 ? "either" : "unknown";
    if (version >= 3 && b.length >= 0x7c) {
      // a second and third SID: the page they sit at ($D420.. $DFFF); 0 = none
      if (b[0x7a] !== 0) info.sids = 2;
      if (version >= 4 && b[0x7b] !== 0) info.sids = 3;
    }
  }
  return info;
}
