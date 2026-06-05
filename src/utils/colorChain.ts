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

export type ShaderInput = { url: string } | { floatNodeId: string };

/** Node types that participate in the float color chain. */
export const COLOR_NODE_TYPES = new Set<string>(["colorGrade", "hsvCorrect", "contrastAdjust"]);

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
