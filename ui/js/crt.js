// The tube. The engine hands over palette indices; this turns them into colour, then draws them the way a
// CRT would: bilinear glow, scanlines between the pixel rows, a phosphor mask, a little curvature and
// vignette. Strength 0 is a flat, exact, pixel-perfect picture. All of it is the shell's own shader (the
// engine's CRT filter is off), so it is the same everywhere and can be switched off for exactness.
const VS = `attribute vec2 p; varying vec2 uv; void main(){ uv = vec2(p.x*.5+.5, .5-p.y*.5); gl_Position = vec4(p,0.,1.); }`;
const FS = `precision highp float;
varying vec2 uv; uniform sampler2D tex; uniform vec2 size; uniform float k; uniform vec2 out_px;
vec2 warp(vec2 u){ vec2 c=u*2.-1.; c*= (1.+.022*k*dot(c,c))*(1.-.012*k); return c*.5+.5; }
vec3 samp(vec2 u){ return texture2D(tex,u).rgb; }
void main(){
  vec2 u = warp(uv);
  if(u.x<0.||u.x>1.||u.y<0.||u.y>1.){ gl_FragColor=vec4(0.,0.,0.,1.); return; }
  vec2 px = u*size;
  vec2 t = 1./size;
  vec3 c = samp(u);
  vec3 g = (samp(u+vec2(t.x,0.))+samp(u-vec2(t.x,0.))) * .25 + (samp(u+vec2(2.*t.x,0.))+samp(u-vec2(2.*t.x,0.))) * .125;
  c = mix(c, c*.7+g*.6, .30*k);
  float sl = 1. - k*.34*(.5+.5*cos(6.2831853*px.y));
  c *= sl;
  float m = mod(gl_FragCoord.x,3.);
  vec3 mask = m<1.?vec3(1.,.76,.76):(m<2.?vec3(.76,1.,.76):vec3(.76,.76,1.));
  c *= mix(vec3(1.),mask,.30*k);
  vec2 v = uv-.5; c *= 1.-.40*k*dot(v,v)*2.;
  c *= 1.+.22*k;
  gl_FragColor = vec4(pow(clamp(c,0.,1.),vec3(1./1.02)),1.);
}`;

export class Tube {
  constructor(canvas) {
    this.canvas = canvas;
    this.k = 0.6;
    this.w = 0; this.h = 0;
    this.rgba = null;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: true });
    this.gl = null;
    if (gl) {
      // A shader that will not compile, or a lost graphics context, must not leave a black screen (or take the whole page down with it).
      try {
        this.init(gl); this.gl = gl;
        canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; });
        canvas.addEventListener("webglcontextrestored", () => { try { this.init(gl); this.lost = false; if (this.rgba) this.draw(); } catch { this.fallback(); } });
      } catch (err) { console.error("CRT shader unavailable, drawing plain pixels:", err); this.fallback(); }
    } else this.ctx = canvas.getContext("2d");
  }
  /** Plain 2D drawing, no shader. A canvas that has had a WebGL context cannot give a 2D one, so swap in a fresh canvas. */
  fallback() {
    const old = this.canvas, fresh = document.createElement("canvas");
    fresh.id = old.id; fresh.className = old.className; fresh.tabIndex = old.tabIndex; fresh.setAttribute("style", old.getAttribute("style") ?? "");
    for (const a of old.getAttributeNames()) if (!fresh.hasAttribute(a)) fresh.setAttribute(a, old.getAttribute(a));
    fresh.width = old.width; fresh.height = old.height;
    old.replaceWith(fresh);
    this.canvas = fresh; this.gl = null; this.lost = false; this.ctx = fresh.getContext("2d");
    this.onCanvasReplaced?.(fresh);
    if (this.rgba) this.draw();
  }
  init(gl) {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [a, b] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, a, b);
    this.u = { size: gl.getUniformLocation(prog, "size"), k: gl.getUniformLocation(prog, "k"), tex: gl.getUniformLocation(prog, "tex") };
  }
  /** indices + a 16 x RGB palette -> RGBA bytes (also used by the hub tiles) */
  static toRGBA(pix, pal, w, h, out) {
    const n = w * h;
    if (!out || out.length !== n * 4) out = new Uint8ClampedArray(n * 4);
    const lut = new Uint32Array(16);
    for (let i = 0; i < 16; i++) lut[i] = 0xff000000 | (pal[i * 3 + 2] << 16) | (pal[i * 3 + 1] << 8) | pal[i * 3];
    new Uint32Array(out.buffer).set(Uint32Array.from(pix.subarray(0, n), (v) => lut[v & 15]));
    return out;
  }
  frame(pix, pal, w, h) {
    this.rgba = Tube.toRGBA(pix, pal, w, h, this.rgba);
    this.w = w; this.h = h;
    this.draw();
  }
  setStrength(k) { this.k = k; if (this.rgba) this.draw(); }
  resize(cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(2, Math.round(cssW * dpr)), H = Math.max(2, Math.round(cssH * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; if (this.rgba) this.draw(); }
  }
  draw() {
    const { gl, canvas } = this;
    if (!this.rgba || this.lost) return; // while the context is lost there is nothing to draw on; the restore handler draws again
    if (!gl) {
      const c = this.ctx; c.imageSmoothingEnabled = false;
      if (!this.off) this.off = document.createElement("canvas");
      this.off.width = this.w; this.off.height = this.h;
      this.off.getContext("2d").putImageData(new ImageData(this.rgba, this.w, this.h), 0, 0);
      c.drawImage(this.off, 0, 0, canvas.width, canvas.height);
      return;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(this.rgba.buffer));
    gl.uniform2f(this.u.size, this.w, this.h);
    gl.uniform1f(this.u.k, this.k);
    gl.uniform1i(this.u.tex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
