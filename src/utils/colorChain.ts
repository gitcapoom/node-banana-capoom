/**
 * Floating-point color pipeline for the chainable color nodes
 * (Color Grade / HSV Correct / Contrast Adjust).
 *
 * ## Why
 * The normal node "wire" is an 8-bit PNG data URL, which clamps every
 * value to [0,1]. Chaining grades through it loses anything that goes
 * super-white or sub-black at an intermediate stage, so a sequence of
 * corrections doesn't compose the way it would in a real grading stack.
 *
 * This module keeps each color node's output as a 16-bit float texture
 * ON the GPU, in a registry keyed by the producing node's id. A
 * downstream color node reads its upstream's float texture directly as
 * input — no clamp, no 8-bit round-trip. Only the visible thumbnail and
 * the output to *non-color* nodes are flattened to clamped 8-bit (a
 * monitor / PNG can't carry out-of-range values anyway).
 *
 * ## Safety / fallback
 * Float-render-target support requires WebGL2 + EXT_color_buffer_float.
 * If that's unavailable, `floatSupported()` returns false and callers
 * fall back to the existing clamped 8-bit path in webglProcess.ts — so
 * the worst case is exactly today's behaviour.
 *
 * Everything runs in its own WebGL2 context, isolated from the 8-bit
 * singleton in webglProcess.ts, and is serialized by a mutex so the
 * shared context is never raced (same black-frame fix as webglProcess).
 */

import { DISPLAY_CLAMP_SHADER } from "./imageShaders";
import { processImageWithShader, type UniformValue } from "./webglProcess";
import type { CompTransform, CompReformat } from "@/types/comp";
import { computePieces, computeFollowPieces, piecesToUniforms } from "./compTransform";

export type ShaderInput = { url: string } | { floatNodeId: string };

/** Node types that participate in the float color chain. `comp` joins so its
 *  inputs read upstream float textures and its output is published as a float
 *  texture (see renderComp below). */
export const COLOR_NODE_TYPES = new Set<string>(["colorGrade", "hsvCorrect", "contrastAdjust", "comp"]);

// u_flipY: 1.0 for canvas-targeted passes (the browser presents the
// default framebuffer top-left, and uploaded images are GL bottom-left,
// so we flip to display upright — same convention as webglProcess).
// 0.0 for FBO-targeted passes (rendering into a float texture must
// PRESERVE the input orientation, so the float texture stays
// interchangeable with an uploaded image texture; flipping here would
// store the float chain upside-down and mirror downstream previews).
const VERT = `
attribute vec2 a_pos;
uniform float u_flipY;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  if (u_flipY > 0.5) v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;
const FRAG_HEADER = `precision highp float;
uniform sampler2D u_tex;
varying vec2 v_uv;
`;

interface FloatTex { tex: WebGLTexture; w: number; h: number; }

interface Ctx {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  quad: WebGLBuffer;
  floatOK: boolean;
}

let ctx: Ctx | null = null;
let initFailed = false;

function getCtx(): Ctx | null {
  if (ctx) return ctx;
  if (initFailed) return null;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) { initFailed = true; return null; }
    // RGBA16F renderability — required to render into a float texture.
    const floatOK = !!gl.getExtension("EXT_color_buffer_float");
    const quad = gl.createBuffer();
    if (!quad) { initFailed = true; return null; }
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      ctx = null;
      floatRegistry.clear();
      urlTexCache = null;
      programCache.clear();
    });
    ctx = { canvas, gl, quad, floatOK };
    return ctx;
  } catch {
    initFailed = true;
    return null;
  }
}

/** True when GPU float chaining is available. */
export function floatSupported(): boolean {
  const c = getCtx();
  return !!c && c.floatOK;
}

// ─── registries ──────────────────────────────────────────────────

const floatRegistry = new Map<string, FloatTex>();
const programCache = new Map<string, WebGLProgram>();
let urlTexCache: { url: string; tex: WebGLTexture; w: number; h: number } | null = null;

export function hasFloat(nodeId: string): boolean {
  return floatRegistry.has(nodeId);
}

/** Free a node's float texture (call on unmount / delete). */
export function releaseColorNode(nodeId: string): void {
  const entry = floatRegistry.get(nodeId);
  if (entry && ctx) ctx.gl.deleteTexture(entry.tex);
  floatRegistry.delete(nodeId);
}

// ─── shader / program ────────────────────────────────────────────

function getProgram(gl: WebGL2RenderingContext, fragBody: string): WebGLProgram {
  const key = fragBody;
  const existing = programCache.get(key);
  if (existing) return existing;
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`colorChain shader compile: ${info}`);
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG_HEADER + fragBody);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`colorChain program link: ${info}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  programCache.set(key, prog);
  return prog;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("colorChain loadImage failed"));
    img.src = src;
  });
}

/** Resolve a ShaderInput to a bound-able input texture. Returns null when
 *  a float input was requested but its texture isn't in the registry. */
async function resolveInput(gl: WebGL2RenderingContext, input: ShaderInput): Promise<FloatTex | null> {
  if ("floatNodeId" in input) {
    return floatRegistry.get(input.floatNodeId) ?? null;
  }
  // 8-bit URL upload, one-slot cache.
  if (urlTexCache && urlTexCache.url === input.url) {
    return { tex: urlTexCache.tex, w: urlTexCache.w, h: urlTexCache.h };
  }
  if (urlTexCache) gl.deleteTexture(urlTexCache.tex);
  const img = await loadImage(input.url);
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  urlTexCache = { url: input.url, tex, w: img.naturalWidth, h: img.naturalHeight };
  return { tex, w: img.naturalWidth, h: img.naturalHeight };
}

function setUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram, uniforms: Record<string, UniformValue>) {
  for (const [name, value] of Object.entries(uniforms)) {
    const loc = gl.getUniformLocation(prog, name);
    if (loc == null) continue;
    if (typeof value === "number") gl.uniform1f(loc, value);
    else if (value.length === 2) gl.uniform2f(loc, value[0], value[1]);
    else if (value.length === 3) gl.uniform3f(loc, value[0], value[1], value[2]);
    else if (value.length === 4) gl.uniform4f(loc, value[0], value[1], value[2], value[3]);
  }
}

function bindQuad(gl: WebGL2RenderingContext, prog: WebGLProgram, quad: WebGLBuffer) {
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  const loc = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
}

// ─── serialization ───────────────────────────────────────────────
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn);
  lock = run.then(() => undefined, () => undefined);
  return run;
}

// ─── public: float render (chain output) ─────────────────────────

/**
 * Run a color-node shader on `input` and store the result as this node's
 * float texture in the registry (under `destNodeId`). Returns the output
 * dimensions, or null if float isn't supported / the input float texture
 * was missing (caller should fall back to the 8-bit path).
 */
export function renderColorNodeToFloat(
  input: ShaderInput,
  fragBody: string,
  uniforms: Record<string, UniformValue>,
  destNodeId: string,
): Promise<{ w: number; h: number } | null> {
  return withLock(async () => {
    const c = getCtx();
    if (!c || !c.floatOK) return null;
    const { gl, quad } = c;
    const inTex = await resolveInput(gl, input);
    if (!inTex) return null;
    const { w, h } = inTex;

    // (Re)create this node's output float texture at the right size.
    const prev = floatRegistry.get(destNodeId);
    let outTex = prev?.tex;
    if (!outTex || prev!.w !== w || prev!.h !== h) {
      if (outTex) gl.deleteTexture(outTex);
      outTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, outTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    }
    floatRegistry.set(destNodeId, { tex: outTex, w, h });

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      floatRegistry.delete(destNodeId);
      gl.deleteTexture(outTex);
      return null;
    }

    const prog = getProgram(gl, fragBody);
    gl.useProgram(prog);
    bindQuad(gl, prog, quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inTex.tex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
    setUniforms(gl, prog, uniforms);
    // FBO pass: preserve orientation (no flip), so this float texture is
    // interchangeable with an uploaded image texture.
    gl.uniform1f(gl.getUniformLocation(prog, "u_flipY"), 0.0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    return { w, h };
  });
}

/**
 * Flatten a node's stored float texture to a clamped 8-bit PNG data URL
 * for display / output to non-color nodes. Returns null if there's no
 * float texture for that node.
 */
export function floatNodeToDataUrl(nodeId: string): Promise<string | null> {
  return withLock(async () => {
    const c = getCtx();
    if (!c) return null;
    const { gl, quad, canvas } = c;
    const entry = floatRegistry.get(nodeId);
    if (!entry) return null;
    const { tex, w, h } = entry;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const prog = getProgram(gl, DISPLAY_CLAMP_SHADER);
    gl.useProgram(prog);
    bindQuad(gl, prog, quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
    gl.uniform1f(gl.getUniformLocation(prog, "u_flipY"), 1.0); // canvas → flip for upright display
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return canvas.toDataURL("image/png");
  });
}

/**
 * Commit path shared by the live hook AND the workflow executors:
 * produce this node's float texture (for the chain) and return the 8-bit
 * display URL to store in `outputImage`. Falls back to the clamped 8-bit
 * path when float is unavailable. Never throws — returns `fallbackUrl`
 * on any error so the node always has *some* output.
 *
 * `effUniforms` must already include u_clampLow / u_clampHigh.
 */
export async function commitColorNode(
  input: ShaderInput,
  fragBody: string,
  effUniforms: Record<string, UniformValue>,
  nodeId: string,
  isIdentity: boolean,
  fallbackUrl: string,
): Promise<string> {
  try {
    if (floatSupported()) {
      const res = await renderColorNodeToFloat(input, fragBody, effUniforms, nodeId);
      if (res) {
        if (isIdentity) return fallbackUrl;
        return (await floatNodeToDataUrl(nodeId)) ?? fallbackUrl;
      }
    }
    if (isIdentity) return fallbackUrl;
    return await processImageWithShader(fallbackUrl, fragBody, effUniforms);
  } catch (err) {
    console.error("commitColorNode failed:", err);
    return fallbackUrl;
  }
}

/**
 * Live preview: run the node shader on `input` and blit the (display-
 * clamped) result into a visible 2D canvas. Returns false if float
 * isn't supported or the float input was missing — caller falls back to
 * the 8-bit webglProcess path.
 */
export function renderColorNodeToCanvas(
  input: ShaderInput,
  fragBody: string,
  uniforms: Record<string, UniformValue>,
  destCanvas: HTMLCanvasElement,
): Promise<boolean> {
  return withLock(async () => {
    const c = getCtx();
    if (!c) return false;
    const { gl, quad, canvas } = c;
    const inTex = await resolveInput(gl, input);
    if (!inTex) return false;
    const { w, h } = inTex;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const prog = getProgram(gl, fragBody);
    gl.useProgram(prog);
    bindQuad(gl, prog, quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inTex.tex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
    setUniforms(gl, prog, uniforms);
    gl.uniform1f(gl.getUniformLocation(prog, "u_flipY"), 1.0); // canvas → flip for upright display
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    // The 8-bit canvas inherently clamps to [0,1] for display.
    if (destCanvas.width !== w) destCanvas.width = w;
    if (destCanvas.height !== h) destCanvas.height = h;
    const dctx = destCanvas.getContext("2d");
    if (!dctx) return false;
    dctx.clearRect(0, 0, w, h);
    dctx.drawImage(canvas, 0, 0);
    return true;
  });
}

// ─── Comp (Nuke Merge clone) — multi-input float compositor ───────────────

export type CompResolvable = { url: string } | { floatNodeId: string };
export interface CompRenderInputs {
  bg: CompResolvable | null;
  fg: CompResolvable | null;
  fgAlpha: CompResolvable | null;
  matte: CompResolvable | null;
}
export interface CompRenderParams {
  op: number; // COMP_OP_INDEX value
  fgTransform: CompTransform;
  fgAlphaTransform: CompTransform;
  matteTransform: CompTransform;
  fgAlphaReformat: CompReformat;
  matteReformat: CompReformat;
}

/**
 * Comp fragment shader. Samples BG at v_uv (passthrough orientation, so the
 * output float texture is interchangeable with image/chain textures); maps
 * each transformed input via inverse affine (bottom-left origin); selects FG
 * alpha (FG_Alpha luminance overrides FG's own); applies the merge op; then
 * lerps the whole merge by the matte. Straight alpha; `over` kept straight,
 * compositing ops use guarded premult round-trips. (FRAG_HEADER already
 * declares `precision`, `varying v_uv`, and an unused `u_tex`.)
 */
const COMP_FRAG = `
uniform vec2 u_outSize;
uniform sampler2D u_bg;
uniform sampler2D u_fg;
uniform sampler2D u_fa;
uniform sampler2D u_mt;
uniform float u_fg_has, u_fa_has, u_mt_has, u_op;
uniform vec2 u_fg_rot, u_fg_c, u_fg_t, u_fg_invs, u_fg_size;
uniform vec2 u_fa_rot, u_fa_c, u_fa_t, u_fa_invs, u_fa_size;
uniform vec2 u_mt_rot, u_mt_c, u_mt_t, u_mt_invs, u_mt_size;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// output bottom-left px O -> input uv (top-left); .z = inside flag
vec3 invSample(vec2 O, vec2 rot, vec2 c, vec2 t, vec2 invs, vec2 size) {
  vec2 d = O - c;
  vec2 p = vec2(rot.x * d.x + rot.y * d.y, -rot.y * d.x + rot.x * d.y) + c - t;
  vec2 s = p * invs;
  float inside = (s.x >= 0.0 && s.x <= size.x && s.y >= 0.0 && s.y <= size.y) ? 1.0 : 0.0;
  return vec3(s.x / size.x, 1.0 - s.y / size.y, inside);
}
float ovl(float b, float a){ return b < 0.5 ? 2.0*a*b : 1.0 - 2.0*(1.0-a)*(1.0-b); }
float sft(float b, float s){
  float d = (b < 0.25) ? ((16.0*b - 12.0)*b + 4.0)*b : sqrt(b);
  return (s < 0.5) ? b - (1.0 - 2.0*s)*b*(1.0 - b) : b + (2.0*s - 1.0)*(d - b);
}
void main() {
  vec2 O = vec2(v_uv.x * u_outSize.x, (1.0 - v_uv.y) * u_outSize.y);
  vec4 B = texture2D(u_bg, v_uv);
  float b = B.a;

  vec3 A = vec3(0.0);
  float fgInside = 0.0;
  float fgAlphaOwn = 1.0;
  if (u_fg_has > 0.5) {
    vec3 r = invSample(O, u_fg_rot, u_fg_c, u_fg_t, u_fg_invs, u_fg_size);
    fgInside = r.z;
    vec4 fgTex = texture2D(u_fg, r.xy);
    A = fgTex.rgb; fgAlphaOwn = fgTex.a;
  }
  float a;
  if (u_fa_has > 0.5) {
    vec3 rfa = invSample(O, u_fa_rot, u_fa_c, u_fa_t, u_fa_invs, u_fa_size);
    a = dot(texture2D(u_fa, rfa.xy).rgb, LUMA) * rfa.z * fgInside;
  } else {
    a = fgAlphaOwn * fgInside;
  }

  vec3 outRgb; float outA;
  int op = int(u_op + 0.5);
  if (op == 0)      { outRgb = A*a + B.rgb*(1.0-a);          outA = a + b*(1.0-a); }      // over
  else if (op == 1) { outRgb = A*a + B.rgb;                  outA = clamp(a+b,0.0,1.0); } // add/plus
  else if (op == 2 || op == 14) { outRgb = B.rgb - A;        outA = b; }                  // minus / from
  else if (op == 3) { outRgb = abs(A - B.rgb);              outA = max(a,b); }            // difference
  else if (op == 4) { outRgb = mix(B.rgb, A*B.rgb, a);      outA = b; }                   // multiply
  else if (op == 5) { outRgb = mix(B.rgb, A+B.rgb-A*B.rgb, a); outA = a + b*(1.0-a); }    // screen
  else if (op == 6) { outRgb = mix(B.rgb, vec3(ovl(B.r,A.r),ovl(B.g,A.g),ovl(B.b,A.b)), a); outA = a + b*(1.0-a); } // overlay
  else if (op == 7) { outRgb = mix(B.rgb, vec3(sft(B.r,A.r),sft(B.g,A.g),sft(B.b,A.b)), a); outA = a + b*(1.0-a); } // softlight
  else if (op == 8) { outRgb = mix(B.rgb, vec3(ovl(A.r,B.r),ovl(A.g,B.g),ovl(A.b,B.b)), a); outA = a + b*(1.0-a); } // hardlight
  else if (op == 9) { outRgb = mix(B.rgb, max(A,B.rgb), a); outA = max(a,b); }            // lighten
  else if (op == 10){ outRgb = mix(B.rgb, min(A,B.rgb), a); outA = b; }                   // darken
  else if (op == 11){ outRgb = mix(B.rgb, B.rgb / max(A, vec3(1e-4)), a); outA = b; }     // divide
  else if (op == 12){ outRgb = B.rgb - A*a;                 outA = b; }                   // subtract
  else if (op == 13){ outRgb = mix(B.rgb, A + B.rgb - 2.0*A*B.rgb, a); outA = a + b*(1.0-a); } // exclusion
  else if (op == 15){ outRgb = A;                           outA = a*b; }                 // in
  else if (op == 16){ outRgb = A;                           outA = a*(1.0-b); }           // out
  else if (op == 17){ outA = b; vec3 pm = A*a*b + B.rgb*b*(1.0-a); outRgb = (outA>1e-4)? pm/outA : vec3(0.0); } // atop
  else if (op == 18){ outA = a*(1.0-b) + b*(1.0-a); vec3 pm = A*a*(1.0-b) + B.rgb*b*(1.0-a); outRgb = (outA>1e-4)? pm/outA : vec3(0.0); } // xor
  else if (op == 19){ outRgb = B.rgb;                       outA = b*a; }                 // mask
  else if (op == 20){ outRgb = B.rgb;                       outA = b*(1.0-a); }           // stencil
  else if (op == 21){ outRgb = A;                           outA = a; }                   // copy
  else              { outRgb = A*a + B.rgb*(1.0-a);         outA = a + b*(1.0-a); }       // default over

  float m = 1.0;
  if (u_mt_has > 0.5) {
    vec3 rmt = invSample(O, u_mt_rot, u_mt_c, u_mt_t, u_mt_invs, u_mt_size);
    m = dot(texture2D(u_mt, rmt.xy).rgb, LUMA) * rmt.z;
  }
  gl_FragColor = vec4(mix(B.rgb, outRgb, m), mix(b, outA, m));
}
`;

// Multi-slot URL texture cache for comp inputs (the single urlTexCache can't
// hold 4 distinct inputs at once). Keyed by url; capped to avoid leaks.
const compUrlCache = new Map<string, FloatTex>();
let dummyTex: WebGLTexture | null = null;

function getDummyTex(gl: WebGL2RenderingContext): WebGLTexture {
  if (dummyTex) return dummyTex;
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  dummyTex = tex;
  return tex;
}

async function resolveComp(gl: WebGL2RenderingContext, input: CompResolvable | null): Promise<FloatTex | null> {
  if (!input) return null;
  if ("floatNodeId" in input) return floatRegistry.get(input.floatNodeId) ?? null;
  const hit = compUrlCache.get(input.url);
  if (hit) return hit;
  const img = await loadImage(input.url);
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  const entry = { tex, w: img.naturalWidth, h: img.naturalHeight };
  compUrlCache.set(input.url, entry);
  // Evict oldest beyond a small cap.
  if (compUrlCache.size > 12) {
    const firstKey = compUrlCache.keys().next().value as string | undefined;
    if (firstKey && firstKey !== input.url) {
      const old = compUrlCache.get(firstKey);
      if (old) gl.deleteTexture(old.tex);
      compUrlCache.delete(firstKey);
    }
  }
  return entry;
}

function compUniforms(
  params: CompRenderParams, outW: number, outH: number,
  fg: FloatTex | null, fa: FloatTex | null, mt: FloatTex | null,
): Record<string, UniformValue> {
  const u: Record<string, UniformValue> = {
    u_outSize: [outW, outH],
    u_op: params.op,
    u_fg_has: fg ? 1 : 0,
    u_fa_has: fa ? 1 : 0,
    u_mt_has: mt ? 1 : 0,
  };
  if (fg) Object.assign(u, piecesToUniforms("u_fg", computePieces(params.fgTransform, "none", fg.w, fg.h, fg.w, fg.h)));
  if (fa) {
    const faPieces = params.fgAlphaTransform.enabled
      ? computePieces(params.fgAlphaTransform, params.fgAlphaReformat, fg?.w ?? fa.w, fg?.h ?? fa.h, fa.w, fa.h)
      : computeFollowPieces(params.fgTransform, fg?.w ?? fa.w, fg?.h ?? fa.h, params.fgAlphaReformat, fa.w, fa.h);
    Object.assign(u, piecesToUniforms("u_fa", faPieces));
  }
  if (mt) Object.assign(u, piecesToUniforms("u_mt", computePieces(params.matteTransform, params.matteReformat, outW, outH, mt.w, mt.h)));
  return u;
}

/** Internal (no lock): render the comp into destNodeId's float texture. */
async function renderCompUnlocked(c: Ctx, inputs: CompRenderInputs, params: CompRenderParams, destNodeId: string): Promise<{ w: number; h: number } | null> {
  const { gl, quad } = c;
  const bg = await resolveComp(gl, inputs.bg);
  if (!bg) return null;
  const w = bg.w, h = bg.h;
  const fg = await resolveComp(gl, inputs.fg);
  const fa = await resolveComp(gl, inputs.fgAlpha);
  const mt = await resolveComp(gl, inputs.matte);

  const prev = floatRegistry.get(destNodeId);
  let outTex = prev?.tex;
  if (!outTex || prev!.w !== w || prev!.h !== h) {
    if (outTex) gl.deleteTexture(outTex);
    outTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, outTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  }
  floatRegistry.set(destNodeId, { tex: outTex, w, h });

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fbo);
    floatRegistry.delete(destNodeId); gl.deleteTexture(outTex);
    return null;
  }
  const prog = getProgram(gl, COMP_FRAG);
  gl.useProgram(prog);
  bindQuad(gl, prog, quad);
  const dummy = getDummyTex(gl);
  const bind = (unit: number, t: FloatTex | null, name: string) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t ? t.tex : dummy);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
  };
  bind(0, bg, "u_bg"); bind(1, fg, "u_fg"); bind(2, fa, "u_fa"); bind(3, mt, "u_mt");
  setUniforms(gl, prog, compUniforms(params, w, h, fg, fa, mt));
  gl.uniform1f(gl.getUniformLocation(prog, "u_flipY"), 0.0); // FBO: preserve orientation
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  return { w, h };
}

/** Display-clamp a float texture to a visible 2D canvas (no lock). */
function blitFloatToCanvasUnlocked(c: Ctx, nodeId: string, destCanvas: HTMLCanvasElement): boolean {
  const { gl, quad, canvas } = c;
  const entry = floatRegistry.get(nodeId);
  if (!entry) return false;
  const { tex, w, h } = entry;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const prog = getProgram(gl, DISPLAY_CLAMP_SHADER);
  gl.useProgram(prog);
  bindQuad(gl, prog, quad);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
  gl.uniform1f(gl.getUniformLocation(prog, "u_flipY"), 1.0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  if (destCanvas.width !== w) destCanvas.width = w;
  if (destCanvas.height !== h) destCanvas.height = h;
  const dctx = destCanvas.getContext("2d");
  if (!dctx) return false;
  dctx.clearRect(0, 0, w, h);
  dctx.drawImage(canvas, 0, 0);
  return true;
}

/** Render the comp into destNodeId's float texture (for the chain). null ⇒
 *  float unsupported / no BG (caller falls back). */
export function renderComp(inputs: CompRenderInputs, params: CompRenderParams, destNodeId: string): Promise<{ w: number; h: number } | null> {
  return withLock(async () => {
    const c = getCtx();
    if (!c || !c.floatOK) return null;
    return renderCompUnlocked(c, inputs, params, destNodeId);
  });
}

/** Render the comp and blit the display-clamped result to a visible canvas. */
export function renderCompToCanvas(inputs: CompRenderInputs, params: CompRenderParams, destNodeId: string, destCanvas: HTMLCanvasElement): Promise<boolean> {
  return withLock(async () => {
    const c = getCtx();
    if (!c || !c.floatOK) return false;
    const res = await renderCompUnlocked(c, inputs, params, destNodeId);
    if (!res) return false;
    return blitFloatToCanvasUnlocked(c, destNodeId, destCanvas);
  });
}
