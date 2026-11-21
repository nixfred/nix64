// A tiny Chrome DevTools Protocol driver: enough to open the shell in a real (headless) Chromium, click,
// type, wait for things, evaluate JavaScript and take screenshots. No dependencies.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class Page {
  private id = 0;
  private pending = new Map<number, (r: any) => void>();
  readonly console: string[] = [];
  readonly errors: string[] = [];
  constructor(private ws: WebSocket, private session: string) {
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id); }
      else if (m.method === "Runtime.consoleAPICalled") this.console.push(`${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description).join(" ")}`);
      else if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    });
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, method, params, sessionId: this.session }));
    });
  }
  async eval<T = any>(expr: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async viewport(w: number, h: number, scale = 1): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: scale, mobile: false });
  }
  async goto(url: string): Promise<void> { await this.send("Page.navigate", { url }); await Bun.sleep(400); }
  async waitFor(expr: string, ms = 10000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await this.eval(expr)) return true; } catch { /* page not ready */ } await Bun.sleep(100); }
    return false;
  }
  async click(selector: string): Promise<void> {
    const box = await this.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!box) throw new Error(`nothing matches ${selector}`);
    await this.mouse(box.x, box.y);
  }
  async mouse(x: number, y: number): Promise<void> {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
  /** a real key press: down, (char), up. `code` like KeyA, `key` like "a". */
  async key(code: string, key: string, opts: { shift?: boolean } = {}): Promise<void> {
    const mods = opts.shift ? 8 : 0;
    const vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ Enter: 13, Escape: 27, Backspace: 8, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 } as Record<string, number>)[key] ?? 0;
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code, key, windowsVirtualKeyCode: vk, modifiers: mods });
    await Bun.sleep(90);
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: vk, modifiers: mods });
    await Bun.sleep(40);
  }
  async type(text: string): Promise<void> {
    for (const ch of text) {
      const up = ch >= "A" && ch <= "Z";
      if (/[a-z]/i.test(ch)) await this.key(`Key${ch.toUpperCase()}`, ch, { shift: up });
      else if (/[0-9]/.test(ch)) await this.key(`Digit${ch}`, ch);
      else if (ch === " ") await this.key("Space", " ");
      else if (ch === "\n") await this.key("Enter", "Enter");
      else await this.key("Unidentified", ch);
    }
  }
  async shot(path: string): Promise<void> {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(r.data, "base64"));
  }
}

export class Browser {
  private constructor(private proc: ReturnType<typeof Bun.spawn>, private ws: WebSocket, private dir: string) {}
  static async launch(): Promise<Browser> {
    const dir = mkdtempSync(join(tmpdir(), "nix64-chrome-"));
    const proc = Bun.spawn(["chromium", "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--hide-scrollbars", "--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--force-device-scale-factor=1", "--disable-dev-shm-usage", "about:blank"], { stdout: "ignore", stderr: "pipe" });
    let url = "";
    const reader = proc.stderr.getReader(), dec = new TextDecoder();
    let buf = "";
    const end = Date.now() + 15000;
    while (!url && Date.now() < end) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      url = /DevTools listening on (ws:\/\/\S+)/.exec(buf)?.[1] ?? "";
    }
    reader.releaseLock();
    if (!url) { proc.kill(); throw new Error(`chromium did not start: ${buf.slice(-300)}`); }
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("cdp connect failed")); });
    return new Browser(proc, ws, dir);
  }
  async page(): Promise<Page> {
    const call = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve) => {
      const id = Math.floor(Math.random() * 1e9);
      const h = (e: MessageEvent) => { const m = JSON.parse(String(e.data)); if (m.id === id) { this.ws.removeEventListener("message", h); resolve(m.result); } };
      this.ws.addEventListener("message", h);
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    const p = new Page(this.ws, sessionId);
    await p.send("Page.enable"); await p.send("Runtime.enable");
    return p;
  }
  close(): void {
    try { this.ws.close(); } catch { /* closed */ }
    this.proc.kill();
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* still in use */ }
  }
}
