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

import { DISPLAY_CLAMP_SHADER, GRADE_SHADER, HSV_SHADER } from "./imageShaders";
import { processImageWithShader, type UniformValue } from "./webglProcess";
import { isIdentityGrade } from "./colorGrade";
import type { CompTransform, CompReformat, CompInputFilter, CompResampleFilter, CompLayerColor } from "@/types/comp";
import { compResampleIndex } from "@/types/comp";
import { TexCache } from "@/utils/texCache";
import { computePieces, computeAlignedPieces, computeFollowPieces, deriveAlignBase, piecesToUniforms, type CompAlignSpec } from "./compTransform";

export type ShaderInput = { url: string } | { floatNodeId: string };

/** Node types that participate in the float color chain. `comp` joins so its
 *  inputs read upstream float textures and its output is published as a float
 *  texture (see renderComp below); `blur` likewise (see renderBlurNode). */
export const COLOR_NODE_TYPES = new Set<string>(["colorGrade", "hsvCorrect", "contrastAdjust", "comp", "blur"]);

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
      blurTexPool.clear();
      // Replace rather than clear(): the context is gone, so the textures are
      // already destroyed and calling deleteTexture on them is meaningless.
      // clear() would run the disposer over every entry for nothing.
      compUrlCache = newCompTexCache();
      dummyTex = null;
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

/** Free a node's float texture + any pooled blur scratch (unmount / delete). */
export function releaseColorNode(nodeId: string): void {
  const entry = floatRegistry.get(nodeId);
  if (entry && ctx) ctx.gl.deleteTexture(entry.tex);
  floatRegistry.delete(nodeId);
  for (const [key, tex] of blurTexPool) {
    if (key.startsWith(`${nodeId}:`)) {
      if (ctx) ctx.gl.deleteTexture(tex.tex);
      blurTexPool.delete(key);
    }
  }
}

/**
 * Drop every GPU resource this module holds. Call when the graph those resources
 * described is replaced — i.e. on workflow load.
 *
 * Without this, each successive open in a session inherited the previous
 * workflow's textures: the comp input cache alone could retain 1.16 GB, and node
 * ids repeat across workflows so the commit-signature caches cross-contaminated
 * (workflow B's `comp-1` adopting workflow A's committed state). Opens got
 * progressively slower until the context was lost.
 *
 * Distinct from the `webglcontextlost` handler, which clears the same maps but
 * must NOT delete: there the context is already gone.
 */
export function resetColorChainCaches(): void {
  const c = ctx;
  if (c) {
    for (const entry of floatRegistry.values()) c.gl.deleteTexture(entry.tex);
    for (const entry of blurTexPool.values()) c.gl.deleteTexture(entry.tex);
    if (urlTexCache) c.gl.deleteTexture(urlTexCache.tex);
  }
  floatRegistry.clear();
  blurTexPool.clear();
  urlTexCache = null;
  compUrlCache.clear();
  previewGeneration.clear();
  // Programs are keyed by shader source and are workflow-independent — keeping
  // them avoids recompiling every shader on each open.
}

/** Bytes currently held in GPU textures by this module. GL memory is invisible to
 *  devtools, so this is the only way to see whether the budget is working. */
export function colorChainTextureBytes(): { comp: number; float: number; pool: number; total: number } {
  let flt = 0;
  for (const e of floatRegistry.values()) flt += e.w * e.h * 8; // RGBA16F
  let pool = 0;
  for (const [k, e] of blurTexPool.entries()) {
    // `:preview` is RGBA8 (display-only); every other pool slot is RGBA16F.
    pool += e.w * e.h * (k.endsWith(":preview") ? 4 : 8);
  }
  const comp = compUrlCache.bytes;
  return { comp, float: flt, pool, total: comp + flt + pool };
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

/** Either decode product; both are valid `texImage2D` sources. */
type DecodedImage = ImageBitmap | HTMLImageElement;

function decodedW(d: DecodedImage): number { return "naturalWidth" in d ? d.naturalWidth : d.width; }
function decodedH(d: DecodedImage): number { return "naturalHeight" in d ? d.naturalHeight : d.height; }
/** ImageBitmaps pin their pixels (~96MB for a 24MP frame) until closed. */
function closeDecoded(d: DecodedImage): void {
  if ("close" in d && typeof d.close === "function") d.close();
}

/**
 * EVERY option here is set deliberately. The committed pixels of every existing
 * project depend on this decode matching what an <img> upload produced, and the
 * defaults do not.
 *
 * Verified in Chrome by uploading both decodes into an RGBA8 texture with
 * identical unpack state and reading the texels back:
 *
 *  - premultiplyAlpha:"none" is byte-identical to <img>. Leaving it to the UA
 *    default is NOT harmless — on a full alpha ramp 72% of bytes differed, max
 *    delta 254. That is every soft edge in the comp silently wrong, and no test
 *    in jsdom can see it.
 *  - colorSpaceConversion:"default" and imageOrientation:"from-image" are what
 *    match <img> + BROWSER_DEFAULT_WEBGL. The "none"/"none" pair measured
 *    identical too, but only because nothing in the test project carries an ICC
 *    profile or an EXIF orientation (checked: 0 PNGs with iCCP, 0 JPEGs with an
 *    orientation tag). A phone photo dropped on an imageInput has both, and
 *    "none" would upload it unrotated and unconverted.
 */
const BITMAP_OPTS: ImageBitmapOptions = {
  premultiplyAlpha: "none",
  colorSpaceConversion: "default",
  imageOrientation: "from-image",
};

/**
 * Decode to a texture-uploadable image, off the main thread when possible.
 *
 * `new Image()` decodes on the main thread and, because resolveComp used to
 * await it while holding the GL mutex, 35 of them ran strictly one after
 * another. createImageBitmap decodes on a worker thread and lets the five
 * inputs of a comp overlap.
 *
 * Falls back to <img> on any failure — an unsupported blob source, a fetch
 * rejection — so the decode path can never become the reason a comp fails to
 * render.
 */
async function decodeImage(src: string): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const blob = await (await fetch(src)).blob();
      return await createImageBitmap(blob, BITMAP_OPTS);
    } catch {
      // fall through
    }
  }
  return loadImage(src);
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
  const img = await decodeImage(input.url);
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  const iw = decodedW(img), ih = decodedH(img);
  closeDecoded(img);
  urlTexCache = { url: input.url, tex, w: iw, h: ih };
  return { tex, w: iw, h: ih };
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

/** Scratch 2D canvas for downscaled readbacks (one per module, reused). */
let thumbCanvas: HTMLCanvasElement | null = null;

/**
 * Flatten a node's float texture straight to a THUMBNAIL-resolution data URL.
 *
 * The display path — a node body preview a few dozen px wide — was being fed by
 * `floatNodeToDataUrl`, which encodes the texture at its native size. On this
 * project's comps that is 6554x3686, and a 24MP PNG encode costs ~1.0s of
 * blocked main thread EACH; the old thumbnail path then decoded that PNG again
 * and re-encoded it small, for another ~300ms. Nine of those is most of the
 * time it took to open a workflow.
 *
 * The GPU draw is not the expensive part — `toDataURL` is. So this renders the
 * display-clamp pass exactly as before, then downscales off the GL canvas into
 * a small 2D canvas and encodes THAT. Same drawImage downscale the old
 * `createImageThumbnailWithMeta` did, so the result is pixel-comparable; it
 * just skips the full-res encode and the decode that followed it.
 *
 * Returns the thumb plus the SOURCE dimensions (free here, and the only place
 * they're cheaply available — see createImageThumbnail for why that matters).
 * Null when the node has no float texture.
 */
export function floatNodeToThumbDataUrl(
  nodeId: string,
  maxDim: number,
  format: "png" | "jpeg" = "png",
  quality = 0.72,
): Promise<{ thumb: string; width: number; height: number } | null> {
  return withLock(async () => {
    const c = getCtx();
    if (!c) return null;
    const { gl, quad, canvas } = c;
    const entry = floatRegistry.get(nodeId);
    if (!entry) return null;
    const { tex, w, h } = entry;

    // Full-res display-clamp draw into the GL canvas — GPU work, ~free.
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

    // Downscale, then encode the SMALL canvas.
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    if (!thumbCanvas) thumbCanvas = document.createElement("canvas");
    const tc = thumbCanvas;
    if (tc.width !== tw) tc.width = tw;
    if (tc.height !== th) tc.height = th;
    const tctx = tc.getContext("2d");
    if (!tctx) return null;
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = "high";
    tctx.clearRect(0, 0, tw, th);
    tctx.drawImage(canvas, 0, 0, tw, th);
    return {
      // PNG by default: comp output carries alpha, and JPEG would flatten it to
      // black (same reason createImageThumbnail defaults comps to png).
      thumb: format === "png" ? tc.toDataURL("image/png") : tc.toDataURL("image/jpeg", quality),
      width: w,
      height: h,
    };
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

/** A sub-rectangle of the comp output, in output px, TOP-LEFT origin (the same
 *  space the editor lays its Konva image out in). */
export interface CompRoi { x: number; y: number; w: number; h: number }
export interface CompRenderInputs {
  bg: CompResolvable | null;
  bgAlpha: CompResolvable | null;
  fg: CompResolvable | null;
  fgAlpha: CompResolvable | null;
  matte: CompResolvable | null;
}
export interface CompRenderParams {
  op: number; // COMP_OP_INDEX value
  bgTransform: CompTransform;
  bgAlphaTransform: CompTransform;
  fgTransform: CompTransform;
  fgAlphaTransform: CompTransform;
  matteTransform: CompTransform;
  bgAlphaReformat: CompReformat;
  fgAlphaReformat: CompReformat;
  matteReformat: CompReformat;
  premultFg: boolean;     // multiply FG rgb by its alpha before the merge
  premultBg: boolean;     // multiply BG rgb by its alpha before the merge
  bgBlackOutside: boolean; // transparent (true) vs edge-hold (false) outside BG
  fgBlackOutside: boolean;
  swapBgFg: boolean;       // swap BG/FG roles (+ their alphas) in the merge
  outputResolution: "bg" | "fg"; // which input's size defines the output
  /** FG auto-align: drop the FG back onto the region its crop metadata came
   *  from, at whatever resolution the generator returned. Present only when the
   *  comp has usable metadata and align is on (see resolveFgAlign); the scale
   *  itself is finished in compUniforms, which is what holds the decoded sizes. */
  fgAlign?: CompAlignSpec;
  bgOpacity: number;       // 0..1, scales BG alpha before the merge
  fgOpacity: number;       // 0..1, scales FG alpha before the merge
  /** Feather the FG's coverage inward from its footprint edge, in OUTPUT px.
   *  0 / absent ⇒ the hard-edged rectangle this has always produced. The
   *  FG_Alpha-connected gate lives in compUniforms, which is the only place that
   *  knows whether that pin actually RESOLVED to a texture. */
  fgSoftness?: number;
  /** Per-layer colour correction (Grade → HSV) for the BG / FG plates, run as a
   *  pre-pass BEFORE the blur filter and before the transform samples the
   *  input. Absent/identity ⇒ no pass and no texture. BG and FG only: the alpha
   *  and matte pins are masks, and grading a mask is a bug generator. */
  bgColor?: CompLayerColor;
  fgColor?: CompLayerColor;
  /** Per-input blur/defocus filters, applied to each input's texture before
   *  the merge shader samples it. Absent/identity ⇒ no pre-pass. */
  filters?: {
    bg: CompInputFilter;
    bgAlpha: CompInputFilter;
    fg: CompInputFilter;
    fgAlpha: CompInputFilter;
    matte: CompInputFilter;
  };
  /** Per-input RECONSTRUCTION filter used while the transform resamples that
   *  input. Different thing from `filters` above — this is the kernel that
   *  rebuilds the source under scale/rotation, not a blur applied after. */
  resample?: {
    bg: CompResampleFilter;
    bgAlpha: CompResampleFilter;
    fg: CompResampleFilter;
    fgAlpha: CompResampleFilter;
    matte: CompResampleFilter;
  };
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
// Sub-rectangle of the output this pass actually renders, in output px,
// bottom-left origin. Commit passes the whole frame (origin 0, size u_outSize)
// and is therefore bit-identical to having no ROI at all; the editor's preview
// passes only what is on screen, so zooming IN costs no more than zooming out.
uniform vec2 u_roiOrigin;
uniform vec2 u_roiSize;
uniform sampler2D u_bg;
uniform sampler2D u_ba;
uniform sampler2D u_fg;
uniform sampler2D u_fa;
uniform sampler2D u_mt;
uniform float u_ba_has, u_fg_has, u_fa_has, u_mt_has, u_op, u_premultFg, u_premultBg, u_bg_bo, u_fg_bo, u_swap, u_bgOpacity, u_fgOpacity;
// FG edge softness, in OUTPUT px. 0 disables the ramp entirely.
uniform float u_fg_soft;
uniform vec2 u_bg_rot, u_bg_c, u_bg_t, u_bg_invs, u_bg_size;
uniform vec2 u_ba_rot, u_ba_c, u_ba_t, u_ba_invs, u_ba_size;
uniform vec2 u_fg_rot, u_fg_c, u_fg_t, u_fg_invs, u_fg_size;
uniform vec2 u_fa_rot, u_fa_c, u_fa_t, u_fa_invs, u_fa_size;
uniform vec2 u_mt_rot, u_mt_c, u_mt_t, u_mt_invs, u_mt_size;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
uniform float u_bg_flt, u_ba_flt, u_fg_flt, u_fa_flt, u_mt_flt;
// 1 when that input's sampling is NOT identity, i.e. the kernel can matter.
uniform float u_bg_xf, u_ba_xf, u_fg_xf, u_fa_xf, u_mt_xf;

// ── reconstruction filters ────────────────────────────────────────
//
// Which kernel rebuilds the source when a transform resamples it. Doing this
// explicitly (rather than leaning on the texture's GL filter) matters twice
// over: it makes the choice a parameter, and it fixes float-chain inputs, whose
// registry textures are NEAREST — so before this, scaling or rotating the
// output of another GPU node resampled it nearest-neighbour.
//
// Only has an effect where the sampling grid misses the source grid — under
// scale, rotation or sub-pixel translation. At identity every kernel here
// returns the original texel.

// Mitchell-Netravali family: Keys (0,1/2), Mitchell (1/3,1/3), Parzen (1,0).
float cubicW(float x, float B, float C) {
  x = abs(x);
  float x2 = x * x; float x3 = x2 * x;
  if (x < 1.0) return ((12.0 - 9.0*B - 6.0*C)*x3 + (-18.0 + 12.0*B + 6.0*C)*x2 + (6.0 - 2.0*B)) / 6.0;
  if (x < 2.0) return ((-B - 6.0*C)*x3 + (6.0*B + 30.0*C)*x2 + (-12.0*B - 48.0*C)*x + (8.0*B + 24.0*C)) / 6.0;
  return 0.0;
}
float sinc1(float x) { return abs(x) < 1e-5 ? 1.0 : sin(3.14159265 * x) / (3.14159265 * x); }
float lanczosW(float x, float a) { return abs(x) >= a ? 0.0 : sinc1(x) * sinc1(x / a); }

float tentW(float x) { x = abs(x); return x < 1.0 ? 1.0 - x : 0.0; }
// sigma 0.5 over a radius of 2, so the kernel is ~4 sigma wide and tapers to
// nothing at the edge instead of being cut off mid-slope.
float gaussianW(float x) { x = abs(x); return x >= 2.0 ? 0.0 : exp(-(x * x) / 0.5); }

// 1=bilinear(tent) 2=keys 3=mitchell 4=parzen 5=lanczos4(a=2) 6=lanczos6(a=3) 7=gaussian
float kernelW(float x, float mode) {
  if (mode < 1.5) return tentW(x);
  if (mode < 2.5) return cubicW(x, 0.0, 0.5);
  if (mode < 3.5) return cubicW(x, 0.3333333, 0.3333333);
  if (mode < 4.5) return cubicW(x, 1.0, 0.0);
  if (mode < 5.5) return lanczosW(x, 2.0);
  if (mode < 6.5) return lanczosW(x, 3.0);
  return gaussianW(x);
}

vec4 sampleFiltered(sampler2D tex, vec2 uv, vec2 size, float mode, float xf, vec2 invs) {
  // NOT TRANSFORMED (xf = 0): the sampling grid lines up with the source grid,
  // so every kernel here reduces to the texel under the pixel. Take it in one
  // hardware fetch. This is not a micro-optimisation — without it the kernel
  // ran for every input on every pixel regardless, so a comp with five inputs
  // on Keys paid 80 texture fetches per pixel to reproduce what one fetch
  // gives, and a 24MP commit paid it billions of times.
  if (xf < 0.5) return texture2D(tex, uv);

  vec2 texel = 1.0 / size;
  // 0 = impulse. Snap to the texel centre so the result can't depend on
  // whatever GL filter the texture carries. Deliberately never widened —
  // "impulse" means no filtering, including no anti-aliasing.
  if (mode < 0.5) return texture2D(tex, (floor(uv * size) + 0.5) * texel);

  // MINIFICATION WIDENING. invs is source pixels per output pixel, so when an
  // input is shrunk (invs > 1) one output pixel covers several source texels.
  //
  // Every kernel here is a RECONSTRUCTION filter: its support is fixed in
  // source texels. Used unchanged while minifying it interpolates between
  // texels and low-passes nothing, so the frequencies above the output's
  // Nyquist alias straight through — and because all the kernels then sample
  // the same tiny neighbourhood, changing the filter did nothing visible.
  // Measured against a correct box downsample at 4x: bilinear was off by 14.9
  // mean levels, lanczos6 by 22.3 — WORSE than bilinear, because a sharpening
  // lobe amplifies the aliasing it should be removing.
  //
  // Dividing the kernel argument by the scale stretches the same weights across
  // the whole footprint, which is what turns them into resampling filters. Taps
  // stay on integer texels so nothing is skipped, and the tap COUNT is
  // unchanged — this costs nothing. The same measurement after: bilinear 7.3,
  // lanczos6 7.8, a 51-65% error reduction across the kernels.
  //
  // The 6-tap grid spans +/-3 texels, so the footprint is fully covered up to
  // about 6x. Past that the stretched kernel is truncated toward a box over
  // those 6 texels — degraded, but still filtered, where before it aliased.
  vec2 wide = max(vec2(1.0), abs(invs));

  // Magnifying (wide == 1) leaves bilinear exactly as the hardware LINEAR
  // filter, which is what it was before and is free.
  if (mode < 1.5 && wide.x <= 1.0 && wide.y <= 1.0) return texture2D(tex, uv);

  vec2 t = uv * size - 0.5;
  vec2 base = floor(t);
  vec2 f = t - base;

  // Lanczos6 reaches 3, the tent 1, everything else 2. One fixed 6x6 loop with
  // zero weights outside the radius keeps the bounds constant, as GLSL ES 1.00
  // requires.
  float radius = (mode < 1.5) ? 1.0 : ((mode > 5.5 && mode < 6.5) ? 3.0 : 2.0);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int j = -2; j <= 3; j++) {
    float dy = (float(j) - f.y) / wide.y;
    float wy = (abs(dy) > radius) ? 0.0 : kernelW(dy, mode);
    for (int i = -2; i <= 3; i++) {
      float dx = (float(i) - f.x) / wide.x;
      float w = (abs(dx) > radius) ? 0.0 : wy * kernelW(dx, mode);
      acc += texture2D(tex, (base + vec2(float(i), float(j)) + 0.5) * texel) * w;
      wsum += w;
    }
  }
  return wsum > 0.0 ? acc / wsum : texture2D(tex, uv);
}

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
  vec2 O = u_roiOrigin + vec2(v_uv.x * u_roiSize.x, (1.0 - v_uv.y) * u_roiSize.y);

  // BG (transformed; default identity = passthrough). Black-outside controls
  // whether outside the BG footprint is transparent (bo=1) or edge-held (bo=0).
  vec3 rbg = invSample(O, u_bg_rot, u_bg_c, u_bg_t, u_bg_invs, u_bg_size);
  float bgCov = (u_bg_bo > 0.5) ? rbg.z : 1.0;
  vec4 bgTex = sampleFiltered(u_bg, rbg.xy, u_bg_size, u_bg_flt, u_bg_xf, u_bg_invs);
  vec3 Brgb = bgTex.rgb * bgCov;
  float bAlphaOwn = bgTex.a;
  float b;
  if (u_ba_has > 0.5) {
    vec3 rba = invSample(O, u_ba_rot, u_ba_c, u_ba_t, u_ba_invs, u_ba_size);
    b = dot(sampleFiltered(u_ba, rba.xy, u_ba_size, u_ba_flt, u_ba_xf, u_ba_invs).rgb, LUMA) * rba.z;
  } else {
    b = bAlphaOwn;
  }
  b *= bgCov;
  b *= u_bgOpacity;                  // per-layer BG opacity
  if (u_premultBg > 0.5) Brgb = Brgb * b; // premultiply BG by its alpha

  // FG
  vec3 A = vec3(0.0);
  float fgInside = 0.0;
  float fgAlphaOwn = 1.0;
  float fgSoft = 1.0;
  if (u_fg_has > 0.5) {
    vec3 r = invSample(O, u_fg_rot, u_fg_c, u_fg_t, u_fg_invs, u_fg_size);
    fgInside = r.z;
    vec4 fgTex = sampleFiltered(u_fg, r.xy, u_fg_size, u_fg_flt, u_fg_xf, u_fg_invs);
    A = fgTex.rgb; fgAlphaOwn = fgTex.a;

    // Edge softness: ramp the coverage in over the first u_fg_soft OUTPUT px of
    // the FG's footprint. Measured in output px on purpose — align scales a
    // generated patch by whatever the generator returned, so a ramp measured in
    // source px would silently mean a different width at every scale.
    //
    // invSample hands back normalised uv, so recover the SOURCE px it came from
    // rather than widening its signature (all five inputs share it): .x is
    // s.x/size.x and .y is 1 - s.y/size.y, comp source y being bottom-up.
    // (min(s, size - s) is symmetric about the centre, so the flip cancels — but
    // it is written out rather than dropped, because the next person to reuse
    // this recovery for something asymmetric needs the convention stated.)
    // D output px is D * |1/scale| source px, and u_fg_invs is exactly 1/scale
    // per axis — which is what makes a non-uniformly scaled FG feather the same
    // number of OUTPUT px on all four edges.
    if (u_fg_soft > 0.0 && u_fg_bo > 0.5) {
      vec2 s = vec2(r.x * u_fg_size.x, (1.0 - r.y) * u_fg_size.y);
      vec2 softSrc = max(abs(u_fg_invs) * u_fg_soft, vec2(1e-6));
      vec2 e = min(s, u_fg_size - s) / softSrc;
      fgSoft = clamp(min(e.x, e.y), 0.0, 1.0);
    }
  }
  // Two coverages, deliberately. fgHard is the binary in/out flag and answers
  // only "may this pixel show FG colour at all"; fgCov carries the ramp and
  // belongs to the ALPHA. Applying the ramp to both (which is what "A *= fgCov"
  // below used to do, on top of the alpha already carrying it) squares it on the
  // premultiplied path and drags the straight path's feathered edge toward BLACK
  // instead of toward the BG — a dark halo exactly where softness is meant to
  // remove one. Harmless while coverage was only ever 0 or 1; not once it ramps.
  float fgHard = (u_fg_has > 0.5) ? ((u_fg_bo > 0.5) ? fgInside : 1.0) : 0.0;
  float fgCov = fgHard * fgSoft;
  float a;
  if (u_fa_has > 0.5) {
    vec3 rfa = invSample(O, u_fa_rot, u_fa_c, u_fa_t, u_fa_invs, u_fa_size);
    a = dot(sampleFiltered(u_fa, rfa.xy, u_fa_size, u_fa_flt, u_fa_xf, u_fa_invs).rgb, LUMA) * rfa.z * fgCov;
  } else {
    a = fgAlphaOwn * fgCov;
  }
  a *= u_fgOpacity;                  // per-layer FG opacity
  if (u_premultFg > 0.5) A = A * a; // premultiply FG by its alpha
  A *= fgHard;                       // black-outside / no-coverage ⇒ no FG color

  // Swap BG/FG roles (and their alphas) for the merge.
  if (u_swap > 0.5) { vec3 tc = A; A = Brgb; Brgb = tc; float ta = a; a = b; b = ta; }

  vec3 outRgb; float outA;
  int op = int(u_op + 0.5);
  if (op == 0)      { outRgb = A*a + Brgb*(1.0-a);          outA = a + b*(1.0-a); }      // over
  else if (op == 1) { outRgb = A*a + Brgb;                  outA = clamp(a+b,0.0,1.0); } // add/plus
  else if (op == 2 || op == 14) { outRgb = Brgb - A;        outA = b; }                  // minus / from
  else if (op == 3) { outRgb = abs(A - Brgb);              outA = max(a,b); }            // difference
  else if (op == 4) { outRgb = mix(Brgb, A*Brgb, a);       outA = b; }                   // multiply
  else if (op == 5) { outRgb = mix(Brgb, A+Brgb-A*Brgb, a); outA = a + b*(1.0-a); }      // screen
  else if (op == 6) { outRgb = mix(Brgb, vec3(ovl(Brgb.r,A.r),ovl(Brgb.g,A.g),ovl(Brgb.b,A.b)), a); outA = a + b*(1.0-a); } // overlay
  else if (op == 7) { outRgb = mix(Brgb, vec3(sft(Brgb.r,A.r),sft(Brgb.g,A.g),sft(Brgb.b,A.b)), a); outA = a + b*(1.0-a); } // softlight
  else if (op == 8) { outRgb = mix(Brgb, vec3(ovl(A.r,Brgb.r),ovl(A.g,Brgb.g),ovl(A.b,Brgb.b)), a); outA = a + b*(1.0-a); } // hardlight
  else if (op == 9) { outRgb = mix(Brgb, max(A,Brgb), a);  outA = max(a,b); }            // lighten
  else if (op == 10){ outRgb = mix(Brgb, min(A,Brgb), a);  outA = b; }                   // darken
  else if (op == 11){ outRgb = mix(Brgb, Brgb / max(A, vec3(1e-4)), a); outA = b; }      // divide
  else if (op == 12){ outRgb = Brgb - A*a;                 outA = b; }                   // subtract
  else if (op == 13){ outRgb = mix(Brgb, A + Brgb - 2.0*A*Brgb, a); outA = a + b*(1.0-a); } // exclusion
  else if (op == 15){ outRgb = A;                          outA = a*b; }                 // in
  else if (op == 16){ outRgb = A;                          outA = a*(1.0-b); }           // out
  else if (op == 17){ outA = b; vec3 pm = A*a*b + Brgb*b*(1.0-a); outRgb = (outA>1e-4)? pm/outA : vec3(0.0); } // atop
  else if (op == 18){ outA = a*(1.0-b) + b*(1.0-a); vec3 pm = A*a*(1.0-b) + Brgb*b*(1.0-a); outRgb = (outA>1e-4)? pm/outA : vec3(0.0); } // xor
  else if (op == 19){ outRgb = Brgb;                       outA = b*a; }                 // mask
  else if (op == 20){ outRgb = Brgb;                       outA = b*(1.0-a); }           // stencil
  else if (op == 21){ outRgb = A;                          outA = a; }                   // copy
  else              { outRgb = A*a + Brgb*(1.0-a);         outA = a + b*(1.0-a); }       // default over

  float m = 1.0;
  if (u_mt_has > 0.5) {
    vec3 rmt = invSample(O, u_mt_rot, u_mt_c, u_mt_t, u_mt_invs, u_mt_size);
    m = dot(sampleFiltered(u_mt, rmt.xy, u_mt_size, u_mt_flt, u_mt_xf, u_mt_invs).rgb, LUMA) * rmt.z;
  }
  gl_FragColor = vec4(mix(Brgb, outRgb, m), mix(b, outA, m));
}
`;

/**
 * Multi-slot URL texture cache for comp inputs (the single urlTexCache can't hold
 * 4 distinct inputs at once).
 *
 * Budgeted in BYTES and evicted LRU. It used to cap at 12 ENTRIES with FIFO
 * eviction, which at 6554x3686 RGBA8 is 1.16 GB of VRAM, and — because `Map.get`
 * does not reorder — evicted hot entries while cold ones survived. With ~29
 * distinct inputs on a large graph the hit rate was ~0, and every miss decoded a
 * 24MP image inside the render mutex.
 */
const COMP_TEX_BUDGET_BYTES = 600 * 1024 * 1024;
const newCompTexCache = () =>
  new TexCache<FloatTex>(COMP_TEX_BUDGET_BYTES, (t) => {
    // Read ctx lazily: on context loss the cache is REPLACED rather than cleared,
    // so this never runs against a dead context.
    if (ctx) ctx.gl.deleteTexture(t.tex);
  });
let compUrlCache = newCompTexCache();
let dummyTex: WebGLTexture | null = null;

function getDummyTex(gl: WebGL2RenderingContext): WebGLTexture {
  if (dummyTex) return dummyTex;
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  dummyTex = tex;
  return tex;
}

async function resolveComp(
  gl: WebGL2RenderingContext,
  input: CompResolvable | null,
  decoded?: Map<string, DecodedImage>,
): Promise<FloatTex | null> {
  if (!input) return null;
  if ("floatNodeId" in input) {
    // NOT mipmapped, deliberately.
    //
    // These are RENDER TARGETS. Every render writes level 0 through an FBO and
    // leaves levels 1..n holding whatever was generated last time, so a sampler
    // set to LINEAR_MIPMAP_LINEAR reads PREVIOUS frames' pixels at any LOD > 0.
    // Regenerating on use does not save it either: the commit path renders into
    // level 0 and downstream consumers sample before anything refreshes the
    // chain. The result is ghosting that compounds frame over frame, varies
    // with zoom (zoom picks the LOD) and gets baked into the committed output.
    //
    // Prefiltering these still needs solving — see the minification note in
    // sampleFiltered — but it has to go through a texture the chain does not
    // also render into.
    const entry = floatRegistry.get(input.floatNodeId);
    if (!entry) return null;
    // Assert the filter state rather than assume it. Registry textures are
    // created NEAREST and then REUSED across renders — the creation path only
    // runs on a size change — so a texture that was switched to
    // LINEAR_MIPMAP_LINEAR earlier in the session keeps it, stale mip levels
    // and all, until the page reloads. Setting it here makes recovery
    // immediate instead of requiring a reload.
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return entry;
  }
  const hit = compUrlCache.get(input.url);
  if (hit) return hit;
  // Decoded before the lock was taken, when possible — see predecodeComp.
  const pre = decoded?.get(input.url);
  const img = pre ?? await decodeImage(input.url);
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // NOT mipmapped. Mipmapping these looked like the right prefilter for
  // minification, but sampleFiltered derives its tap coordinates from floor(),
  // which is piecewise-constant — so the screen-space derivatives GL uses to
  // pick a LOD are 0 inside a texel and jump at every boundary, and the level
  // chosen is meaningless near 1:1. The visible result was per-texel blotching
  // that changed with zoom and, because a comp's committed output becomes the
  // next comp's URL input, accumulated across renders.
  //
  // Minification here is therefore still unfiltered and will alias. That needs
  // a real prefilter (an explicit downsample pass producing its own texture),
  // not a mip chain sampled through a floor()-based kernel.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  const entry = { tex, w: decodedW(img), h: decodedH(img) };
  // A pre-decoded image belongs to the caller's map and is closed there; one we
  // decoded ourselves is ours to release the moment it is on the GPU.
  if (!pre) closeDecoded(img);
  // RGBA8 upload above, so 4 bytes per texel.
  compUrlCache.set(input.url, entry, entry.w * entry.h * 4);
  return entry;
}

function compUniforms(
  params: CompRenderParams, outW: number, outH: number,
  bg: FloatTex, ba: FloatTex | null, fg: FloatTex | null, fa: FloatTex | null, mt: FloatTex | null,
): Record<string, UniformValue> {
  const u: Record<string, UniformValue> = {
    u_outSize: [outW, outH],
    // Whole frame by default — renderCompUnlocked overrides these for a
    // preview that only needs the visible sub-rect.
    u_roiOrigin: [0, 0],
    u_roiSize: [outW, outH],
    u_op: params.op,
    u_premultFg: params.premultFg ? 1 : 0,
    u_premultBg: params.premultBg ? 1 : 0,
    u_bg_bo: params.bgBlackOutside ? 1 : 0,
    u_fg_bo: params.fgBlackOutside ? 1 : 0,
    u_swap: params.swapBgFg ? 1 : 0,
    u_bgOpacity: params.bgOpacity,
    u_fgOpacity: params.fgOpacity,
    // FG edge softness (output px), silenced when an FG_Alpha pin is in play —
    // that pin REPLACES the FG's own alpha, so feathering a coverage it has
    // already overridden would only fight the matte the user connected.
    //
    // Gated HERE rather than in buildCompParams because `fa` is the resolved
    // TEXTURE, which is the same signal the shader's u_fa_has comes from.
    // buildCompParams would have to read data.fgAlphaImage, and that mirror is
    // lazily null for the first render after a workflow opens even though the
    // edge exists — softness would flicker on for one frame on every load.
    u_fg_soft: fa ? 0 : Math.max(0, params.fgSoftness ?? 0),
    u_ba_has: ba ? 1 : 0,
    u_fg_has: fg ? 1 : 0,
    u_fa_has: fa ? 1 : 0,
    u_mt_has: mt ? 1 : 0,
    // Reconstruction filter per input — see CompResampleFilter.
    u_bg_flt: compResampleIndex(params.resample?.bg),
    u_ba_flt: compResampleIndex(params.resample?.bgAlpha),
    u_fg_flt: compResampleIndex(params.resample?.fg),
    u_fa_flt: compResampleIndex(params.resample?.fgAlpha),
    u_mt_flt: compResampleIndex(params.resample?.matte),
  };
  Object.assign(u, piecesToUniforms("u_bg", computePieces(params.bgTransform, "none", bg.w, bg.h, bg.w, bg.h)));
  if (ba) {
    const baPieces = params.bgAlphaTransform.enabled
      ? computePieces(params.bgAlphaTransform, params.bgAlphaReformat, bg.w, bg.h, ba.w, ba.h)
      : computeFollowPieces(params.bgTransform, bg.w, bg.h, params.bgAlphaReformat, ba.w, ba.h);
    Object.assign(u, piecesToUniforms("u_ba", baPieces));
  }
  // FG auto-align. This is the only place that holds the params AND the decoded
  // FG size, so it is where the description from buildCompParams becomes a
  // placement. A null base means the BG is not this crop's source (different
  // aspect) — fall back to the un-aligned path rather than inventing a rect.
  const fgAlignBase = fg && params.fgAlign
    ? deriveAlignBase({ ...params.fgAlign, fgW: fg.w, fgH: fg.h, outW, outH })
    : null;
  if (fg) {
    const fgPieces = fgAlignBase
      ? computeAlignedPieces(params.fgTransform, fgAlignBase, fg.w, fg.h)
      : computePieces(params.fgTransform, "none", fg.w, fg.h, fg.w, fg.h);
    Object.assign(u, piecesToUniforms("u_fg", fgPieces));
  }
  if (fa) {
    const faPieces = params.fgAlphaTransform.enabled
      ? computePieces(params.fgAlphaTransform, params.fgAlphaReformat, fg?.w ?? fa.w, fg?.h ?? fa.h, fa.w, fa.h)
      // The base goes through too: a FOLLOWED FG_Alpha that ignored it would sit
      // in the un-aligned position while the FG it mattes moves.
      : computeFollowPieces(params.fgTransform, fg?.w ?? fa.w, fg?.h ?? fa.h, params.fgAlphaReformat, fa.w, fa.h, fgAlignBase ?? undefined);
    Object.assign(u, piecesToUniforms("u_fa", faPieces));
  }
  if (mt) Object.assign(u, piecesToUniforms("u_mt", computePieces(params.matteTransform, params.matteReformat, bg.w, bg.h, mt.w, mt.h)));

  // Which inputs are actually resampled. An input whose sampling is exactly
  // 1:1 — no rotation, unit scale, no translation, and the same size as the
  // output — lands on source texel centres, so every reconstruction kernel
  // returns that texel and running one is pure cost. Flagging it lets the
  // shader take a single hardware fetch instead.
  const isIdentity = (prefix: string, src: FloatTex | null): number => {
    if (!src) return 0;
    const rot = u[`${prefix}_rot`] as number[] | undefined;
    const inv = u[`${prefix}_invs`] as number[] | undefined;
    const tr = u[`${prefix}_t`] as number[] | undefined;
    if (!rot || !inv || !tr) return 0;
    const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    const identity =
      eq(rot[0], 1) && eq(rot[1], 0) &&
      eq(inv[0], 1) && eq(inv[1], 1) &&
      eq(tr[0], 0) && eq(tr[1], 0) &&
      src.w === outW && src.h === outH;
    return identity ? 0 : 1; // u_*_xf: 1 means "transformed, filter it"
  };
  u.u_bg_xf = isIdentity("u_bg", bg);
  u.u_ba_xf = isIdentity("u_ba", ba);
  u.u_fg_xf = isIdentity("u_fg", fg);
  u.u_fa_xf = isIdentity("u_fa", fa);
  u.u_mt_xf = isIdentity("u_mt", mt);
  return u;
}

/**
 * Internal (no lock): render the comp.
 *
 * COMMIT (preview omitted) writes destNodeId's float texture in the registry —
 * that texture is DATA: downstream colour nodes chain off it and `outputImage`
 * is derived from it, so it must always be full-res.
 *
 * PREVIEW writes a pooled scratch texture at `preview.scale` and never touches
 * the registry, so a proxy render can never leak into the chain or onto disk.
 * `u_outSize` stays the SOURCE size while only the viewport shrinks, which
 * makes this a plain downsample — every transform, reformat and black-outside
 * calculation is expressed against u_outSize and is therefore untouched.
 */
/**
 * Decode a comp's URL inputs CONCURRENTLY, before the GL mutex is taken.
 *
 * resolveComp used to await its decode inside the lock, so a comp's five inputs
 * decoded one after another and every other comp on the canvas queued behind
 * them. Decoding here means the five overlap, on worker threads, while the lock
 * is free for someone else's render.
 *
 * Skips URLs whose texture is already cached — that path never decodes. A
 * failure is swallowed on purpose: resolveComp will simply decode it itself
 * inside the lock, which is the old behaviour, not an error.
 *
 * The returned map is owned by the caller, which MUST close it (bitmaps pin
 * their pixels). Keeping it local rather than module-level is deliberate:
 * concurrent renders cannot then close each other's images.
 */
async function predecodeComp(inputs: CompRenderInputs): Promise<Map<string, DecodedImage>> {
  const urls = new Set<string>();
  for (const i of [inputs.bg, inputs.bgAlpha, inputs.fg, inputs.fgAlpha, inputs.matte]) {
    if (i && "url" in i && !compUrlCache.has(i.url)) urls.add(i.url);
  }
  const out = new Map<string, DecodedImage>();
  await Promise.all(
    [...urls].map(async (u) => {
      try { out.set(u, await decodeImage(u)); } catch { /* resolveComp retries */ }
    }),
  );
  return out;
}

/** Release every image in a predecode map. */
function closeDecodedMap(m: Map<string, DecodedImage>): void {
  for (const d of m.values()) closeDecoded(d);
  m.clear();
}

async function renderCompUnlocked(
  c: Ctx,
  inputs: CompRenderInputs,
  params: CompRenderParams,
  destNodeId: string,
  preview?: { scale: number; roi?: CompRoi },
  decoded?: Map<string, DecodedImage>,
): Promise<{ w: number; h: number; entry: FloatTex; roi: CompRoi } | null> {
  const { gl, quad } = c;
  let bg = await resolveComp(gl, inputs.bg, decoded);
  if (!bg) return null;
  let ba = await resolveComp(gl, inputs.bgAlpha, decoded);
  let fg = await resolveComp(gl, inputs.fg, decoded);
  let fa = await resolveComp(gl, inputs.fgAlpha, decoded);
  let mt = await resolveComp(gl, inputs.matte, decoded);

  // Per-layer colour pre-pass (BG / FG only), BEFORE the blur and before the
  // transform resamples anything.
  //
  // A nonlinear point op does NOT commute with a linear resample: Grade carries
  // a pow and HSV a hue wrap, so grading after a 0.25x minification grades the
  // AVERAGED pixels, while grading first grades the originals and then averages
  // them. An in-comp grade means "fix this plate's look" — a property of the
  // plate's own pixels — so it belongs on the source, ahead of the sampling.
  // Grade → HSV → blur is also the physical order: you defocus a graded image,
  // you do not grade a defocus.
  bg = colorIntoUnlocked(c, bg, params.bgColor, `${destNodeId}:c_bg`);
  if (fg) fg = colorIntoUnlocked(c, fg, params.fgColor, `${destNodeId}:c_fg`);

  // Per-input filter pre-passes (no-ops for identity params). Dims unchanged,
  // so the transform math downstream is unaffected.
  const F = params.filters;
  if (F) {
    bg = blurIntoUnlocked(c, bg, F.bg, `${destNodeId}:f_bg`);
    if (ba) ba = blurIntoUnlocked(c, ba, F.bgAlpha, `${destNodeId}:f_ba`);
    if (fg) fg = blurIntoUnlocked(c, fg, F.fg, `${destNodeId}:f_fg`);
    if (fa) fa = blurIntoUnlocked(c, fa, F.fgAlpha, `${destNodeId}:f_fa`);
    if (mt) mt = blurIntoUnlocked(c, mt, F.matte, `${destNodeId}:f_mt`);
  }
  // Output resolution from BG (default) or FG.
  const sizeSrc = params.outputResolution === "fg" && fg ? fg : bg;
  const w = sizeSrc.w, h = sizeSrc.h;

  // Region actually rendered, in output px. Commit always renders the whole
  // frame; a preview renders only the visible sub-rect, clamped to the frame.
  const roiTL = preview?.roi
    ? {
        x: Math.max(0, Math.min(w, preview.roi.x)),
        y: Math.max(0, Math.min(h, preview.roi.y)),
        w: Math.max(1, Math.min(w, preview.roi.w)),
        h: Math.max(1, Math.min(h, preview.roi.h)),
      }
    : { x: 0, y: 0, w, h };
  // Don't let a ROI run off the right/bottom edge.
  roiTL.w = Math.max(1, Math.min(roiTL.w, w - roiTL.x));
  roiTL.h = Math.max(1, Math.min(roiTL.h, h - roiTL.y));

  // Framebuffer size: full-res on commit, ROI x zoom on preview.
  const dw = preview ? Math.max(1, Math.round(roiTL.w * preview.scale)) : w;
  const dh = preview ? Math.max(1, Math.round(roiTL.h * preview.scale)) : h;

  let target: FloatTex;
  if (preview) {
    target = ensureBlurTex(c, `${destNodeId}:preview`, dw, dh, /* eightBit */ true);
  } else {
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
    target = { tex: outTex, w, h };
    floatRegistry.set(destNodeId, target);
  }

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fbo);
    if (!preview) { floatRegistry.delete(destNodeId); gl.deleteTexture(target.tex); }
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
  bind(0, bg, "u_bg"); bind(1, fg, "u_fg"); bind(2, fa, "u_fa"); bind(3, mt, "u_mt"); bind(4, ba, "u_ba");
  // u_outSize is the SOURCE size in both modes — it defines the coordinate
  // space the transforms are solved in, not the framebuffer. The ROI selects
  // which part of that space this pass covers (y flipped to the shader's
  // bottom-left origin).
  setUniforms(gl, prog, {
    ...compUniforms(params, w, h, bg, ba, fg, fa, mt),
    u_roiOrigin: [roiTL.x, h - (roiTL.y + roiTL.h)],
    u_roiSize: [roiTL.w, roiTL.h],
  });
  gl.uniform1f(gl.getUniformLocation(prog, "u_flipY"), 0.0); // FBO: preserve orientation
  gl.viewport(0, 0, dw, dh);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  return { w, h, entry: target, roi: roiTL };
}

/**
 * Display-clamp a float texture to a visible 2D canvas (no lock).
 *
 * `maxDim` caps the DESTINATION only. The comp editor showed a 6554x3686
 * result in a ~1150px viewport, and this blit sized the destination to the
 * full 24MP — a 96MB backing store, a 24MP clearRect + drawImage per frame
 * (~390MB of pixel traffic), which Konva then filter-downscaled 5.7x again on
 * every redraw. The GL draw stays 1:1 because the float textures are NEAREST
 * and point-sampling them small aliases into noise; only the copy shrinks.
 */
function blitFloatToCanvasUnlocked(c: Ctx, nodeId: string, destCanvas: HTMLCanvasElement, maxDim?: number): boolean {
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
  const s = maxDim && maxDim > 0 ? Math.min(1, maxDim / Math.max(w, h)) : 1;
  const dw = Math.max(1, Math.round(w * s));
  const dh = Math.max(1, Math.round(h * s));
  if (destCanvas.width !== dw) destCanvas.width = dw;
  if (destCanvas.height !== dh) destCanvas.height = dh;
  const dctx = destCanvas.getContext("2d");
  if (!dctx) return false;
  if (s < 1) { dctx.imageSmoothingEnabled = true; dctx.imageSmoothingQuality = "high"; }
  dctx.clearRect(0, 0, dw, dh);
  dctx.drawImage(canvas, 0, 0, dw, dh);
  return true;
}

/** Render the comp into destNodeId's float texture (for the chain). null ⇒
 *  float unsupported / no BG (caller falls back). */
export async function renderComp(inputs: CompRenderInputs, params: CompRenderParams, destNodeId: string): Promise<{ w: number; h: number } | null> {
  const decoded = await predecodeComp(inputs);
  try {
    return await withLock(async () => {
      const c = getCtx();
      if (!c || !c.floatOK) return null;
      return renderCompUnlocked(c, inputs, params, destNodeId, undefined, decoded);
    });
  } finally {
    closeDecodedMap(decoded);
  }
}

/**
 * Render the comp FULL-RES (publishing the float texture) and blit the
 * display-clamped result to a visible canvas. `maxDim` caps the DESTINATION
 * canvas only — see blitFloatToCanvasUnlocked.
 *
 * For interactive editing prefer renderCompPreviewToCanvas, which composites at
 * the viewport's resolution instead of the source's.
 */
export async function renderCompToCanvas(inputs: CompRenderInputs, params: CompRenderParams, destNodeId: string, destCanvas: HTMLCanvasElement, maxDim?: number): Promise<boolean> {
  const decoded = await predecodeComp(inputs);
  try {
    return await withLock(async () => {
      const c = getCtx();
      if (!c || !c.floatOK) return false;
      const res = await renderCompUnlocked(c, inputs, params, destNodeId, undefined, decoded);
      if (!res) return false;
      return blitFloatToCanvasUnlocked(c, destNodeId, destCanvas, maxDim);
    });
  } finally {
    closeDecodedMap(decoded);
  }
}

/** Newest requested preview per node — anything older bails at the lock. */
const previewGeneration = new Map<string, number>();

/**
 * PREVIEW render: composite at `scale` into a scratch texture and blit it to a
 * visible canvas. Never touches the float registry, so the chain and everything
 * derived from it (downstream colour nodes, `outputImage`, the saved asset)
 * only ever see a full-res commit.
 *
 * `scale` should track the editor's zoom: at fit-to-window on a 6554x3686 comp
 * that is ~0.29, which is ~12x less pixel work than compositing at source
 * resolution to fill a ~1150px viewport.
 *
 * Superseded renders are dropped rather than run: withLock serialises calls,
 * and without a generation check every intermediate frame of a drag still paid
 * for a full composite before the newest one could start.
 */
export async function renderCompPreviewToCanvas(
  inputs: CompRenderInputs,
  params: CompRenderParams,
  destNodeId: string,
  destCanvas: HTMLCanvasElement,
  scale: number,
  roi?: CompRoi,
): Promise<CompRoi | null> {
  const gen = (previewGeneration.get(destNodeId) ?? 0) + 1;
  previewGeneration.set(destNodeId, gen);
  // Decode before the lock. The generation bump above still happens first, so a
  // newer request supersedes this one even while its decode is in flight.
  const decoded = await predecodeComp(inputs);
  try {
    return await withLock(async () => {
      if (previewGeneration.get(destNodeId) !== gen) return null; // superseded while queued
      const c = getCtx();
      if (!c || !c.floatOK) return null;
      const res = await renderCompUnlocked(c, inputs, params, destNodeId, {
        scale: Math.max(0.02, Math.min(1, scale)),
        roi,
      }, decoded);
      if (!res) return null;
      // The caller must lay the result out at the ROI it actually got back —
      // clamping may have shrunk the requested rect at the frame edges.
      return blitEntryToCanvasUnlocked(c, res.entry, destCanvas) ? res.roi : null;
    });
  } finally {
    closeDecodedMap(decoded);
  }
}

// ─── Blur passes (Blur node + comp per-input filters) ─────────────────────
//
// All five filters run as texture→texture GPU passes so they compose with the
// float chain (no 8-bit round-trip). Gaussian/box are separable two-pass;
// motion/zoom/spin are single-pass 33-tap accumulations. Out-of-bounds samples
// edge-hold via CLAMP_TO_EDGE.

export type BlurPassParams = CompInputFilter;

/** Blur-node params: pass params + matte handling + global mix. */
export interface BlurNodeParams extends CompInputFilter {
  invertMatte: boolean;
  mixAmount: number; // 0..1
}

// Separable pass (gaussian / box). 33 taps max; u_half bounds the live taps,
// u_stepUv is the per-tap uv step along the pass direction. Gaussian sigma is
// fixed at half the tap extent (support ≈ ±2σ = ±radius).
const SEP_BLUR_FRAG = `
uniform vec2 u_stepUv;
uniform float u_half;
uniform float u_gauss;
void main() {
  float sigma = max(u_half * 0.5, 0.35);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -16; i <= 16; i++) {
    float fi = float(i);
    if (abs(fi) > u_half + 0.5) continue;
    float w = (u_gauss > 0.5) ? exp(-0.5 * fi * fi / (sigma * sigma)) : 1.0;
    acc += texture2D(u_tex, v_uv + u_stepUv * fi) * w;
    wsum += w;
  }
  gl_FragColor = acc / max(wsum, 1e-6);
}
`;

// Directional pass: motion (0) = line, zoom (1) = scale about center,
// spin (2) = rotation about center. Aspect-correct (works in pixel space).
const DIR_BLUR_FRAG = `
uniform vec2 u_texSize;
uniform float u_mode;
uniform vec2 u_vec;
uniform float u_amt;
void main() {
  vec2 ctr = u_texSize * 0.5;
  vec2 p0 = v_uv * u_texSize;
  vec4 acc = vec4(0.0);
  for (int i = -16; i <= 16; i++) {
    float t = float(i) / 16.0;
    vec2 p;
    if (u_mode < 0.5) {
      p = p0 + u_vec * t;
    } else if (u_mode < 1.5) {
      p = ctr + (p0 - ctr) * (1.0 + u_amt * t);
    } else {
      float a = u_amt * t;
      float cs = cos(a), sn = sin(a);
      vec2 d = p0 - ctr;
      p = ctr + vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
    }
    acc += texture2D(u_tex, p / u_texSize);
  }
  gl_FragColor = acc / 33.0;
}
`;

// Final Blur-node pass: lerp source→blurred by matte luminance × mix. The
// matte stretches to the source via v_uv, so any matte resolution works.
const BLUR_MIX_FRAG = `
uniform sampler2D u_blur;
uniform sampler2D u_mt;
uniform float u_mt_has, u_invert, u_mix;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec4 src = texture2D(u_tex, v_uv);
  vec4 blr = texture2D(u_blur, v_uv);
  float m = 1.0;
  if (u_mt_has > 0.5) m = dot(texture2D(u_mt, v_uv).rgb, LUMA);
  if (u_invert > 0.5) m = 1.0 - m;
  gl_FragColor = mix(src, blr, clamp(m * u_mix, 0.0, 1.0));
}
`;

/** Pooled pass targets, keyed `${nodeId}:${slot}` (freed by releaseColorNode). */
const blurTexPool = new Map<string, FloatTex>();

/**
 * `eightBit` forces RGBA8 for targets that are DISPLAY-ONLY.
 *
 * The pool defaults to RGBA16F because most of these slots feed the chain, where
 * unclamped intermediates are the whole point. The comp editor's `:preview`
 * target is the exception: it is blitted straight to a 2D canvas, which is 8-bit
 * by definition, so half its bytes were being thrown away at the last step. At
 * 6554x3686 that is 193 MB down to 97 MB per open editor, for no quality change
 * whatsoever. Do NOT pass it for the `:a`/`:b`/`f_*` slots.
 */
function ensureBlurTex(c: Ctx, key: string, w: number, h: number, eightBit = false): FloatTex {
  const { gl } = c;
  const prev = blurTexPool.get(key);
  if (prev && prev.w === w && prev.h === h) return prev;
  if (prev) gl.deleteTexture(prev.tex);
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // LINEAR — blur passes sample between texels (fractional steps).
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (c.floatOK && !eightBit) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  const entry = { tex, w, h };
  blurTexPool.set(key, entry);
  return entry;
}

/** Draw a full-viewport pass with `prog` into `out` (FBO). Caller binds textures/uniforms after useProgram via the returned program. */
function drawPassInto(c: Ctx, prog: WebGLProgram, out: FloatTex): boolean {
  const { gl, quad } = c;
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out.tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    return false;
  }
  bindQuad(gl, prog, quad);
  gl.uniform1f(gl.getUniformLocation(prog, "u_flipY"), 0.0); // FBO: preserve orientation
  gl.viewport(0, 0, out.w, out.h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  return true;
}

/** True when the filter would change nothing. */
export function isBlurIdentity(f: CompInputFilter | undefined | null): boolean {
  return !f || f.filter === "none" || !(f.radius > 0);
}

/**
 * Blur `src` into pooled textures under `poolKey`. Returns `src` unchanged for
 * identity params or on pass failure. NOT locked — internal use only.
 */
function blurIntoUnlocked(c: Ctx, src: FloatTex, f: CompInputFilter, poolKey: string): FloatTex {
  if (isBlurIdentity(f)) return src;
  const { gl } = c;
  const { w, h } = src;

  // Sample the source LINEAR for the pass, restoring its own filter after
  // (registry float textures are NEAREST; comp URL uploads are LINEAR).
  const withLinear = (tex: WebGLTexture, run: () => boolean): boolean => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const prevMin = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER) as number;
    const prevMag = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER) as number;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const ok = run();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, prevMin);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, prevMag);
    return ok;
  };

  const bindSrc = (prog: WebGLProgram, tex: WebGLTexture) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
  };

  if (f.filter === "gaussian" || f.filter === "box") {
    const halfTaps = Math.min(16, Math.max(1, Math.ceil(f.radius)));
    const stepPx = f.radius / halfTaps;
    const prog = getProgram(gl, SEP_BLUR_FRAG);
    const a = ensureBlurTex(c, `${poolKey}:a`, w, h);
    const b = ensureBlurTex(c, `${poolKey}:b`, w, h);
    const pass = (from: WebGLTexture, to: FloatTex, dirUv: [number, number]) => {
      gl.useProgram(prog);
      bindSrc(prog, from);
      setUniforms(gl, prog, { u_stepUv: dirUv, u_half: halfTaps, u_gauss: f.filter === "gaussian" ? 1 : 0 });
      return drawPassInto(c, prog, to);
    };
    const ok = withLinear(src.tex, () => pass(src.tex, a, [stepPx / w, 0]))
      && pass(a.tex, b, [0, stepPx / h]);
    return ok ? b : src;
  }

  // motion / zoom / spin — single directional pass.
  const prog = getProgram(gl, DIR_BLUR_FRAG);
  const b = ensureBlurTex(c, `${poolKey}:b`, w, h);
  const mode = f.filter === "motion" ? 0 : f.filter === "zoom" ? 1 : 2;
  const angleRad = (f.angle * Math.PI) / 180;
  const uniforms: Record<string, UniformValue> = {
    u_texSize: [w, h],
    u_mode: mode,
    // motion: total streak ≈ radius px (half-extent each way).
    u_vec: [Math.cos(angleRad) * f.radius * 0.5, Math.sin(angleRad) * f.radius * 0.5],
    // zoom: ±0.3% scale per radius unit; spin: ±0.006 rad per radius unit.
    u_amt: f.filter === "zoom" ? f.radius * 0.003 : f.radius * 0.006,
  };
  const ok = withLinear(src.tex, () => {
    gl.useProgram(prog);
    bindSrc(prog, src.tex);
    setUniforms(gl, prog, uniforms);
    return drawPassInto(c, prog, b);
  });
  return ok ? b : src;
}

// ─── Comp per-layer colour (Grade → HSV) pre-pass ─────────────────────────

/** True when the HSV block would change nothing even if it is switched on.
 *  Exported so the Canvas2D fallback can gate on exactly the same predicate the
 *  GPU path does, rather than on the enable flag alone. */
export function isIdentityHsv(c: CompLayerColor): boolean {
  return c.hueShift === 0 && c.saturation === 1 && c.value === 1;
}

/**
 * True when this layer's colour block would change nothing — no pass runs, no
 * texture is allocated, the source texture is handed on untouched.
 *
 * The clamp flags are deliberately NOT part of this test. They ride on whichever
 * pass runs; with both blocks off there is no pass for them to ride on, and
 * allocating a full-resolution float texture purely to clamp a plate would be a
 * surprising 193 MB for a checkbox. The editor only offers the clamps once a
 * block is enabled, so the two agree.
 */
export function isCompColorIdentity(c: CompLayerColor | undefined | null): boolean {
  if (!c) return true;
  const gradeOn = c.gradeEnabled && !isIdentityGrade(c.grade);
  const hsvOn = c.hsvEnabled && !isIdentityHsv(c);
  return !gradeOn && !hsvOn;
}

/**
 * Colour-correct `src` into pooled textures under `poolKey`: Grade, then HSV.
 * Returns `src` unchanged for identity params or on pass failure. NOT locked —
 * internal use only, exactly like blurIntoUnlocked.
 *
 * ## Why a pre-pass rather than uniforms folded into COMP_FRAG
 * GRADE_SHADER and HSV_SHADER are complete `void main()` programs over
 * `texture2D(u_tex, v_uv)`, and they are ALSO compiled under WebGL1 by
 * webglProcess.ts for the standalone colorGrade / hsvCorrect nodes. Inlining
 * them here would mean extracting the maths into GLSL functions and keeping two
 * call sites in step forever — a second copy of a shipped colour transform, which
 * is the failure mode that already bit compCommitSignature. Running the shader
 * STRINGS verbatim makes the in-comp grade bit-identical to the node's by
 * construction. It also keeps ~28 vec3 uniforms out of COMP_FRAG, whose
 * setUniforms re-resolves every location on every draw, at rAF cadence.
 *
 * ## Why the source's own GL filter is left alone (unlike blurIntoUnlocked)
 * The target is the source's size and the quad covers all of it, so every
 * fragment samples exactly one texel centre — no interpolation is ever
 * requested, and forcing LINEAR would only risk a different answer.
 *
 * ## Why the RESULT carries the source's filter forward
 * ensureBlurTex mints LINEAR textures, because blur passes sample at fractional
 * steps and need it. Registry float textures are NEAREST, comp URL uploads are
 * LINEAR — and sampleFiltered has two fast paths (`xf < 0.5`, and bilinear while
 * magnifying) that return a bare `texture2D` and therefore read whatever filter
 * the texture carries. Handing the merge a LINEAR texture where it used to get a
 * NEAREST one would change how an input is RESAMPLED as a side effect of
 * enabling a colour block — a pixel change with no colour in it. So the result
 * is stamped with the source's filter instead. A blur running after this is
 * unaffected: blurIntoUnlocked forces LINEAR on whatever it is handed for the
 * duration of its own passes and restores it afterwards.
 *
 * Both shaders write `src.a` through untouched, so the FG's coverage — and
 * everything the merge, the softness ramp and the matte derive from it — is
 * exactly what it would have been.
 */
function colorIntoUnlocked(c: Ctx, src: FloatTex, col: CompLayerColor | undefined, poolKey: string): FloatTex {
  if (isCompColorIdentity(col) || !col) return src;
  const { gl } = c;
  const { w, h } = src;
  // Read before anything else binds — see "Why the RESULT carries the source's
  // filter forward" above.
  gl.bindTexture(gl.TEXTURE_2D, src.tex);
  const srcMin = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER) as number;
  const srcMag = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER) as number;
  const clamps = { u_clampLow: col.clampLow ? 1 : 0, u_clampHigh: col.clampHigh ? 1 : 0 };
  let cur = src;
  let slot = 0;
  const pass = (fragBody: string, uniforms: Record<string, UniformValue>) => {
    const prog = getProgram(gl, fragBody);
    // Ping-pong `:a` → `:b`. `:b` is only ever created when a SECOND pass runs,
    // so grade-only or HSV-only costs one pooled texture rather than two.
    const out = ensureBlurTex(c, `${poolKey}:${slot === 0 ? "a" : "b"}`, w, h);
    slot ^= 1;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cur.tex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
    setUniforms(gl, prog, { ...uniforms, ...clamps });
    if (drawPassInto(c, prog, out)) cur = out;
  };

  if (col.gradeEnabled && !isIdentityGrade(col.grade)) {
    const g = col.grade;
    pass(GRADE_SHADER, {
      u_blackpoint: [g.blackpoint.r, g.blackpoint.g, g.blackpoint.b],
      u_whitepoint: [g.whitepoint.r, g.whitepoint.g, g.whitepoint.b],
      u_lift: [g.lift.r, g.lift.g, g.lift.b],
      u_gain: [g.gain.r, g.gain.g, g.gain.b],
      u_multiply: [g.multiply.r, g.multiply.g, g.multiply.b],
      u_offset: [g.offset.r, g.offset.g, g.offset.b],
      u_gamma: [g.gamma.r, g.gamma.g, g.gamma.b],
    });
  }
  if (col.hsvEnabled && !isIdentityHsv(col)) {
    pass(HSV_SHADER, { u_hueShift: col.hueShift, u_saturation: col.saturation, u_value: col.value });
  }
  if (cur !== src) {
    gl.bindTexture(gl.TEXTURE_2D, cur.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, srcMin);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, srcMag);
  }
  return cur;
}

// ─── Blur node (chainable, matte-gated) ───────────────────────────────────

/** Internal: render the blur node into its output texture. Returns the output
 *  entry (registry float texture when supported, else a pooled 8-bit one). */
async function renderBlurNodeUnlocked(
  c: Ctx,
  srcInput: CompResolvable | null,
  matteInput: CompResolvable | null,
  params: BlurNodeParams,
  destNodeId: string,
): Promise<FloatTex | null> {
  const { gl } = c;
  const src = await resolveComp(gl, srcInput);
  if (!src) return null;
  const mt = await resolveComp(gl, matteInput);
  const { w, h } = src;

  const blurred = blurIntoUnlocked(c, src, params, `${destNodeId}:blur`);

  // Output: registry float texture when supported (joins the chain), else a
  // pooled RGBA8 target (blit/PNG still work; chain falls back to 8-bit URLs).
  let out: FloatTex;
  if (c.floatOK) {
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
    out = { tex: outTex, w, h };
    floatRegistry.set(destNodeId, out);
  } else {
    out = ensureBlurTex(c, `${destNodeId}:out8`, w, h);
  }

  const prog = getProgram(gl, BLUR_MIX_FRAG);
  gl.useProgram(prog);
  const dummy = getDummyTex(gl);
  const bind = (unit: number, tex: WebGLTexture, name: string) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
  };
  bind(0, src.tex, "u_tex");
  bind(1, blurred.tex, "u_blur");
  bind(2, mt ? mt.tex : dummy, "u_mt");
  setUniforms(gl, prog, {
    u_mt_has: mt ? 1 : 0,
    u_invert: params.invertMatte ? 1 : 0,
    u_mix: Math.max(0, Math.min(1, params.mixAmount ?? 1)),
  });
  if (!drawPassInto(c, prog, out)) {
    if (c.floatOK) floatRegistry.delete(destNodeId);
    return null;
  }
  return out;
}

/** Blit any texture entry (float or 8-bit) display-clamped into a 2D canvas. */
function blitEntryToCanvasUnlocked(c: Ctx, entry: FloatTex, destCanvas: HTMLCanvasElement): boolean {
  const { gl, quad, canvas } = c;
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

/** Render the blur node and blit the result to a visible canvas. */
export function renderBlurNodeToCanvas(
  srcInput: CompResolvable | null,
  matteInput: CompResolvable | null,
  params: BlurNodeParams,
  destNodeId: string,
  destCanvas: HTMLCanvasElement,
): Promise<boolean> {
  return withLock(async () => {
    const c = getCtx();
    if (!c) return false;
    const out = await renderBlurNodeUnlocked(c, srcInput, matteInput, params, destNodeId);
    if (!out) return false;
    return blitEntryToCanvasUnlocked(c, out, destCanvas);
  });
}

/**
 * Commit path for the Blur node (executor + debounced UI commit): render (and
 * publish the float texture when supported) and return the 8-bit PNG display
 * URL. Never throws — returns `fallbackUrl` on any failure.
 */
export async function commitBlurNode(
  srcInput: CompResolvable | null,
  matteInput: CompResolvable | null,
  params: BlurNodeParams,
  destNodeId: string,
  fallbackUrl: string,
): Promise<string> {
  try {
    return await withLock(async () => {
      const c = getCtx();
      if (!c) return fallbackUrl;
      const out = await renderBlurNodeUnlocked(c, srcInput, matteInput, params, destNodeId);
      if (!out) return fallbackUrl;
      const { gl, quad, canvas } = c;
      const { tex, w, h } = out;
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
      return canvas.toDataURL("image/png");
    });
  } catch (err) {
    console.error("commitBlurNode failed:", err);
    return fallbackUrl;
  }
}
