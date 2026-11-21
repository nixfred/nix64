// What is plugged into this computer, and what this build of the engine can do with it.
// Nothing here claims a device works. A badge says VERIFIED only when someone tested it on that
// hardware and recorded the date and model in VERIFIED below; the table starts empty because, as of
// this writing, none of the real-hardware paths has been run against real hardware.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findEngine } from "./engine";

/** Input device names that are game controllers. A bare "Pad" must not match "TouchPad" or "Keypad". */
export const PAD_RE = /Name="([^"]*(?:Joystick|Gamepad|Controller|(?<![A-Za-z])Pad\b)[^"]*)"/gi;

export type Badge = "verified" | "untested" | "exp" | "no";
export type DeviceRow = { id: string; name: string; what: string; found: string[]; how: string; badge: Badge; badgeText: string };

/** Hardware that has really been tried: id -> "model, date, what was seen". Add a line only after a real test. */
export const VERIFIED: Record<string, string> = {};

const read = (p: string) => { try { return readFileSync(p, "utf8").trim(); } catch { return ""; } };

export function usbDevices(): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const root = "/sys/bus/usb/devices";
  if (!existsSync(root)) return out;
  for (const d of readdirSync(root)) {
    const vid = read(join(root, d, "idVendor")), pid = read(join(root, d, "idProduct"));
    if (!vid) continue;
    out.push({ id: `${vid}:${pid}`, name: `${read(join(root, d, "manufacturer"))} ${read(join(root, d, "product"))}`.trim() });
  }
  return out;
}

function engineHelp(): string {
  const e = findEngine();
  if (!e) return "";
  const r = Bun.spawnSync([e, "+logcolorize", "-help"], { env: { ...process.env, SDL_VIDEODRIVER: "dummy" } });
  return r.stdout.toString() + r.stderr.toString();
}
const ldcache = () => Bun.spawnSync(["ldconfig", "-p"]).stdout.toString();
let ldCache: string | undefined;
const hasLib = (name: string) => (ldCache ??= ldcache()).includes(name);
let helpCache: string | undefined;
const help = () => (helpCache ??= engineHelp());

export function devices(): DeviceRow[] {
  const usb = usbDevices(), h = help();
  const find = (pred: (d: { id: string; name: string }) => boolean) => usb.filter(pred).map((d) => `${d.name || "USB device"} (${d.id})`);
  const net = existsSync("/sys/class/net") ? readdirSync("/sys/class/net").filter((n) => n !== "lo") : [];
  const ser = existsSync("/dev") ? readdirSync("/dev").filter((n) => /^tty(USB|ACM)\d+$/.test(n)).map((n) => `/dev/${n}`) : [];
  const pads = (read("/proc/bus/input/devices").match(PAD_RE) ?? []).map((s) => s.slice(6, -1));
  const row = (id: string, name: string, what: string, found: string[], how: string, supported: boolean | "maybe", noteIfNot: string): DeviceRow => {
    const v = VERIFIED[id];
    return { id, name, what, found, how: supported ? how : `${how} ${noteIfNot}`.trim(), badge: v ? "verified" : supported ? (supported === "maybe" ? "exp" : "untested") : "no", badgeText: v ?? (supported ? (supported === "maybe" ? "experimental" : "untested") : "not in this build") };
  };
  return [
    row("realdrive", "Real disk drive", "1541, 1571 or 1581 on a ZoomFloppy / XUM1541 USB adapter", find((d) => /^16d0:0504$|^03eb:204b$/.test(d.id) || /xum1541|zoomfloppy/i.test(d.name)),
      "Drive slot mode \"real\": the engine talks to the drive over OpenCBM.", /opencbm/i.test(h) && hasLib("libopencbm"), "The OpenCBM library is not installed (on Arch it is in the AUR as opencbm), so a real drive cannot be used yet."),
    row("realsid", "Real SID chip", "USBSID-Pico, HardSID, ParSID", find((d) => /usbsid|hardsid|parsid/i.test(d.name) || d.id === "cafe:4011"),
      "Replaces the emulated SID when attached; reSID stays as the fallback.", /hardsid|parsid|usbsid/i.test(h), "No real-SID driver is compiled into this engine."),
    row("keyrah", "C64 keyboard on USB", "Keyrah", find((d) => /keyrah/i.test(d.name)),
      "A positional keyboard map (the keys are where the C64's are).", false, "Not wired yet: the shell's keyboard is symbolic. A real C64 keyboard still types, as a USB keyboard."),
    row("gamepad", "Joystick or gamepad", "Any controller the browser can read", pads,
      "Detected by the shell and sent as a joystick in port 2 (arrows + Space work without one).", true, ""),
    row("wic64", "WiC64", "WiFi userport device: the C64 on the internet", [],
      "Machine file: devices.wic64 = true.", /wic64/i.test(h), "This engine was built without WiC64."),
    row("ethernet", "Ethernet cartridge", "RRNet / ETH64 / Silver Surfer on a real network card", net.map((n) => `network interface ${n}`),
      "Machine file: devices.ethernet. Needs a pcap build and permission to open the card (a capability, not root).", /rrnet|eth64|ethernet/i.test(h.replace(/ethernet-?\s*\w*\s*cable/i, "")) && hasLib("libpcap"), "This engine was built without the Ethernet cartridge (needs pcap)."),
    row("modem", "Modem to a BBS", "RS232 userport modem to a TCP connection: dial a real BBS", ser.length ? ser : [],
      "Machine file: devices.modem; the engine's RS232 over TCP (ip232) reaches a modem bridge.", /ip232/i.test(h) ? "maybe" : false, "This engine has no ip232 support."),
    row("reu", "RAM expansion", "REU 128 KiB to 16 MiB (emulated)", [], "Machine file: devices.reu.", /-reu\b/.test(h), ""),
  ];
}
