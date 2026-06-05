/**
 * Lightweight WebGL fragment-shader runner for image-processing nodes.
 *
 * Takes a source image (data URL), a fragment shader, and a uniforms
 * map; runs the shader on a fullscreen quad against the source as a
 * texture, and returns a PNG data URL of the result.
 *
 * Used by Color Grade / HSV Correct / Contrast Adjust to do their per-
 * pixel math on the GPU instead of CPU 2D-canvas loops — much faster
 * for 4K images and live preview while dragging sliders.
 *
 * ## Singleton context + texture cache
 *
 * Allocating a new WebGL context costs 50-200 ms in browsers (it's a
 * heavy resource), and uploading a 4K texture is another 50-100 ms.
 * Doing both on every slider tick made live editing feel laggy.
 *
 * We now keep a single module-level WebGL context + canvas across all
 * calls, plus a one-slot texture cache keyed by the source image URL.
 * Same-image calls just rebind the cached texture, compile + bind the
 * shader, set uniforms, draw, read back. End-to-end per-call cost drops
 * to ~5-10 ms on a 4K image — realtime for slider drags at 60 fps.
 *
 * The cache is intentionally LRU-1 (last image only). When the source
 * changes the prior texture is deleted; under live editing the source
 * stays stable so this is the common path.
 */

const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  // Flip Y so the rendered image matches the source orientation (WebGL's
  // texture coords have origin bottom-left, our images are top-left).
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_HEADER = `
precision highp float;
uniform sampler2D u_tex;
varying vec2 v_uv;
`;

export type UniformValue = number | [number, number] | [number, number, number] | [number, number, number, number];

export interface ProcessOptions {
  /** Output mime type. PNG is lossless and matches the existing
   *  colorGrade utility. */
  outputType?: "image/png" | "image/jpeg" | "image/webp";
  /** JPEG / WebP quality (0-1). Ignored for PNG. */
  outputQuality?: number;
}

// ─── Singleton context + quad buffer ─────────────────────────────

interface SharedGL {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  quadBuffer: WebGLBuffer;
}
let sharedGL: SharedGL | null = null;

function getSharedGL(): SharedGL {
  if (sharedGL) return sharedGL;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: false });
  if (!gl) throw new Error("WebGL not available in this browser");
  const quadBuffer = gl.createBuffer();
  if (!quadBuffer) throw new Error("Could not create WebGL buffer");
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1,  1, -1, -1,  1,  -1,  1,  1, -1,  1,  1]),
    gl.STATIC_DRAW,
  );
  // Handle context loss (devtools / GPU reset). Clearing the singleton
  // forces re-allocation on the next call.
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    sharedGL = null;
    cachedTexSrc = null;
    cachedTex = null;
    cachedImg = null;
    cachedFragSrc = null;
    cachedProgram = null;
  });
  sharedGL = { canvas, gl, quadBuffer };
  return sharedGL;
}

// ─── One-slot texture cache (keyed by source URL) ─────────────────

let cachedTexSrc: string | null = null;
let cachedTex: WebGLTexture | null = null;
let cachedImg: HTMLImageElement | null = null;

async function getOrUploadTexture(
  gl: WebGLRenderingContext,
  src: string,
): Promise<{ tex: WebGLTexture; width: number; height: number }> {
  if (cachedTexSrc === src && cachedTex && cachedImg) {
    return { tex: cachedTex, width: cachedImg.naturalWidth, height: cachedImg.naturalHeight };
  }
  // Source changed — drop the old texture and upload the new one.
  if (cachedTex) gl.deleteTexture(cachedTex);
  const img = await loadImage(src);
  const tex = gl.createTexture();
  if (!tex) throw new Error("Could not create WebGL texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  cachedTexSrc = src;
  cachedTex = tex;
  cachedImg = img;
  return { tex, width: img.naturalWidth, height: img.naturalHeight };
}

// ─── One-slot program cache (keyed by frag-shader source) ─────────

let cachedFragSrc: string | null = null;
let cachedProgram: WebGLProgram | null = null;

function getOrCompileProgram(gl: WebGLRenderingContext, fragSource: string): WebGLProgram {
  if (cachedFragSrc === fragSource && cachedProgram) {
    return cachedProgram;
  }
  if (cachedProgram) gl.deleteProgram(cachedProgram);
  cachedProgram = createProgram(gl, VERTEX_SHADER, fragSource);
  cachedFragSrc = fragSource;
  return cachedProgram;
}

// ─── Core runner (leaves result in the shared GL canvas) ──────────

/** Run the shader into the shared GL canvas. Returns its dimensions.
 *  Both the data-URL and canvas-blit consumers build on this. */
async function runShader(
  sourceUrl: string,
  fragShaderBody: string,
  uniforms: Record<string, UniformValue>,
): Promise<{ canvas: HTMLCanvasElement; w: number; h: number }> {
  const { canvas, gl, quadBuffer } = getSharedGL();
  const { tex, width: w, height: h } = await getOrUploadTexture(gl, sourceUrl);
  if (w === 0 || h === 0) {
    throw new Error("runShader: source image has zero dimensions");
  }

  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const fragSource = FRAG_HEADER + fragShaderBody;
  const program = getOrCompileProgram(gl, fragSource);
  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  const posLoc = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(gl.getUniformLocation(program, "u_tex"), 0);

  for (const [name, value] of Object.entries(uniforms)) {
    const loc = gl.getUniformLocation(program, name);
    if (loc == null) continue;
    if (typeof value === "number") {
      gl.uniform1f(loc, value);
    } else if (Array.isArray(value)) {
      if (value.length === 2) gl.uniform2f(loc, value[0], value[1]);
      else if (value.length === 3) gl.uniform3f(loc, value[0], value[1], value[2]);
      else if (value.length === 4) gl.uniform4f(loc, value[0], value[1], value[2], value[3]);
    }
  }

  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  return { canvas, w, h };
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Run a fragment shader on a source image and return a PNG data URL.
 *
 * This includes the `toDataURL` encode (~5 ms @ 1K, ~30-80 ms @ 4K) and
 * is the COMMIT path — call it when the user settles, not on every
 * slider tick. For live preview use `renderShaderToCanvas`, which skips
 * the encode entirely.
 */
export async function processImageWithShader(
  sourceUrl: string,
  fragShaderBody: string,
  uniforms: Record<string, UniformValue>,
  options: ProcessOptions = {},
): Promise<string> {
  const { canvas } = await runShader(sourceUrl, fragShaderBody, uniforms);
  return canvas.toDataURL(
    options.outputType ?? "image/png",
    options.outputQuality,
  );
}

/**
 * Run a fragment shader and blit the result straight into a visible 2D
 * canvas — no PNG encode, no data-URL string. This is the LIVE-PREVIEW
 * path: ~3-8 ms end-to-end even at 4K, so it stays at 60 fps while the
 * user drags sliders. The destination canvas is sized to match the
 * source image.
 */
export async function renderShaderToCanvas(
  sourceUrl: string,
  fragShaderBody: string,
  uniforms: Record<string, UniformValue>,
  destCanvas: HTMLCanvasElement,
): Promise<void> {
  const { canvas: glCanvas, w, h } = await runShader(sourceUrl, fragShaderBody, uniforms);
  if (destCanvas.width !== w) destCanvas.width = w;
  if (destCanvas.height !== h) destCanvas.height = h;
  const ctx = destCanvas.getContext("2d");
  if (!ctx) throw new Error("renderShaderToCanvas: could not get 2D context on destination");
  // drawImage of a (preserveDrawingBuffer:true) WebGL canvas is a fast
  // GPU-backed copy — no readback to CPU.
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(glCanvas, 0, 0);
}

// ─── helpers ────────────────────────────────────────────────────

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("loadImage: failed to load source"));
    img.src = src;
  });
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) || "<no info log>";
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}\nSource:\n${source}`);
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  if (!program) throw new Error("Failed to create program");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) || "<no info log>";
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${info}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}
