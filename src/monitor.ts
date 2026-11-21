// The two VICE monitor doors, used only for the things that have no shared-memory path:
// attaching and ejecting media, resetting, changing a resource (warp, volume), saving a snapshot.
//
// Every call opens the door, does one job, tells the machine to carry on, and closes it. The
// monitor halts the CPU for as long as a connection is open, so nothing here ever stays connected,
// and nothing here is used to WATCH the machine (that is the shared-memory telemetry, no stall).
// Both doors listen on 127.0.0.1 only.
import type { Socket } from "bun";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- the binary monitor ----------

const CMD = { AUTOSTART: 0xdd, DUMP: 0x41, UNDUMP: 0x42, RESOURCE_GET: 0x51, RESOURCE_SET: 0x52, PING: 0x81, EXIT: 0xaa, RESET: 0xcc } as const;
const ERRORS: Record<number, string> = { 0x01: "object missing", 0x02: "invalid memspace", 0x80: "command length is wrong", 0x81: "invalid parameter", 0x82: "API version not supported", 0x83: "unknown command", 0x8f: "command failed" };

type Reply = { type: number; error: number; body: Buffer };

class BinaryClient {
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private waiting = new Map<number, (r: Reply) => void>();
  private sock!: Socket;
  private onClose?: () => void;

  static async connect(port: number, timeoutMs = 3000): Promise<BinaryClient> {
    const c = new BinaryClient();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`the engine's binary monitor on port ${port} did not answer`)), timeoutMs);
      Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(s) { c.sock = s; clearTimeout(t); resolve(); },
          data(_s, d) { c.feed(Buffer.from(d)); },
          close() { c.onClose?.(); },
          error(_s, e) { clearTimeout(t); reject(e); },
          connectError(_s, e) { clearTimeout(t); reject(e); },
        },
      }).catch((e) => { clearTimeout(t); reject(e); });
    });
    return c;
  }

  private feed(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 12) {
      const len = this.buf.readUInt32LE(2);
      if (this.buf.length < 12 + len) return;
      const reply: Reply = { type: this.buf[6], error: this.buf[7], body: Buffer.from(this.buf.subarray(12, 12 + len)) };
      const id = this.buf.readUInt32LE(8);
      this.buf = this.buf.subarray(12 + len);
      this.waiting.get(id)?.(reply); // events (stopped, resumed) carry id 0xffffffff and are ignored
    }
  }

  request(cmd: number, body: Buffer = Buffer.alloc(0), timeoutMs = 5000): Promise<Reply> {
    const id = this.nextId++;
    const head = Buffer.alloc(11);
    head[0] = 2; head[1] = 2;
    head.writeUInt32LE(body.length, 2);
    head.writeUInt32LE(id, 6);
    head[10] = cmd;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(id); reject(new Error(`monitor command 0x${cmd.toString(16)} timed out`)); }, timeoutMs);
      this.waiting.set(id, (r) => {
        clearTimeout(t);
        this.waiting.delete(id);
        if (r.error) reject(new Error(`monitor: ${ERRORS[r.error] ?? `error 0x${r.error.toString(16)}`}`));
        else resolve(r);
      });
      this.sock.write(Buffer.concat([head, body]));
    });
  }

  close(): void {
    try { this.sock.end(); } catch { /* already closed */ }
  }
}

const str = (s: string) => {
  const b = Buffer.from(s);
  return Buffer.concat([Buffer.from([b.length]), b]);
};

/** Open the door, run `job`, always let the machine carry on, close. */
async function withBinary<T>(port: number, job: (c: BinaryClient) => Promise<T>): Promise<T> {
  const c = await BinaryClient.connect(port);
  try {
    return await job(c);
  } finally {
    try { await c.request(CMD.EXIT, Buffer.alloc(0), 1500); } catch { /* it may already be running */ }
    c.close();
  }
}

/** Set an engine resource, e.g. ("WarpMode", "1"). Values go as strings, which VICE parses itself. */
export function setResource(port: number, name: string, value: string): Promise<void> {
  return withBinary(port, async (c) => {
    await c.request(CMD.RESOURCE_SET, Buffer.concat([Buffer.from([0]), str(name), str(value)]));
  });
}

export function getResource(port: number, name: string): Promise<string | number> {
  return withBinary(port, async (c) => {
    const r = await c.request(CMD.RESOURCE_GET, str(name));
    // body: type u8, length u8, value (a string, or a little-endian int)
    return r.body[0] === 0 ? r.body.subarray(2, 2 + r.body[1]).toString() : r.body.readInt32LE(2);
  });
}

/** Save the whole machine (CPU, RAM, chips, and the attached disks) as a VICE snapshot file. */
export function saveSnapshot(port: number, file: string, withDisks = true): Promise<void> {
  return withBinary(port, async (c) => {
    await c.request(CMD.DUMP, Buffer.concat([Buffer.from([0, withDisks ? 1 : 0]), str(file)]), 20000);
  });
}

export function loadSnapshot(port: number, file: string): Promise<void> {
  return withBinary(port, async (c) => {
    await c.request(CMD.UNDUMP, str(file), 20000);
  });
}

/** VICE's own autostart: attach and run `file` (a disk, tape or .prg). A host-assisted shortcut, not typing. */
export function autostart(port: number, file: string, run = true): Promise<void> {
  return withBinary(port, async (c) => {
    const name = Buffer.from(file);
    await c.request(CMD.AUTOSTART, Buffer.concat([Buffer.from([run ? 1 : 0, 0, 0, name.length]), name]), 20000);
  });
}

/** 0 = soft reset (the reset button), 1 = hard reset (power cycle). */
export function reset(port: number, hard = false): Promise<void> {
  return withBinary(port, async (c) => {
    await c.request(CMD.RESET, Buffer.from([hard ? 1 : 0]));
  });
}

// ---------- the text monitor ----------

/**
 * Run monitor commands (attach, detach, ...) through the text door and return what it said.
 * The door prints its prompt `(C:$xxxx) ` only once it has read a first line, and then once after
 * every command, so k commands are done when k + 1 prompts have been seen. The last thing sent is
 * `x`, which resumes the machine.
 */
export async function textMonitor(port: number, commands: string[], timeoutMs = 5000): Promise<string> {
  let all = "";
  let wake: (() => void) | undefined;
  const promptRe = /\([CD]:\$[0-9a-f]{4}\) /g;
  const prompts = () => (all.match(promptRe) ?? []).length;
  const sock: Socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, d) { all += Buffer.from(d).toString(); wake?.(); },
      open() {}, close() {}, error() {}, connectError() {},
    },
  });
  const until = (n: number) => new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the engine's monitor did not answer")), timeoutMs);
    const check = () => { if (prompts() >= n && promptRe.lastIndex >= 0 && /\) $/.test(all)) { clearTimeout(t); wake = undefined; resolve(); return true; } return false; };
    if (!check()) wake = check;
  });
  try {
    let said = "";
    for (let k = 0; k < commands.length; k++) {
      const from = all.length;
      sock.write(commands[k] + "\n");
      await until(k + 2);
      said += all.slice(from).replace(promptRe, "").trim() + "\n";
    }
    return said.trim();
  } finally {
    try { sock.write("x\n"); await sleep(50); sock.end(); } catch { /* closed */ }
  }
}

const quote = (p: string) => `"${p.replaceAll('"', "")}"`;
/** Attach a file to a device. The engine answers "Failed." in plain text when it cannot (a damaged or wrong-kind image): say so, do not report success. */
export async function attach(port: number, file: string, device: number): Promise<string> {
  const out = await textMonitor(port, [`attach ${quote(file)} ${device}`]);
  if (/\bfailed\b/i.test(out)) throw new Error(`the engine could not attach ${file.split("/").pop()} to device ${device}: ${out.replace(/\(C:\$[0-9a-f]+\)/gi, "").trim().slice(0, 200)}`);
  return out;
}
export const detach = (port: number, device: number) => textMonitor(port, [`detach ${device}`]);
