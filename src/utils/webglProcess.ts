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
 * Raw WebGL on purpose: Three.js carries way more overhead than we need
 * for a 4-vert quad + one draw call. The cost-per-frame is ~1ms on a
 * mid-range GPU for a 4K image regardless of shader complexity.
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

/**
 * Run a fragment shader on a source image and return a PNG data URL.
 *
 * The shader must declare `uniform sampler2D u_tex;` and sample with
 * `varying vec2 v_uv;`. Additional uniforms are declared in the shader
 * body and provided via the `uniforms` map (numbers, vec2/3/4 tuples).
 */
export async function processImageWithShader(
  sourceUrl: string,
  fragShaderBody: string,
  uniforms: Record<string, UniformValue>,
  options: ProcessOptions = {},
): Promise<string> {
  const img = await loadImage(sourceUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (w === 0 || h === 0) {
    throw new Error("processImageWithShader: source image has zero dimensions");
  }

  // Allocate the canvas + GL context fresh per call. WebGL contexts are
  // a finite browser resource (~16 per page) so we explicitly let the GL
  // context be GC'd by losing all references once we're done.
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: false });
  if (!gl) throw new Error("WebGL not available in this browser");

  const fragSource = FRAG_HEADER + fragShaderBody;

  // ── Compile + link program ───────────────────────────────────
  const program = createProgram(gl, VERTEX_SHADER, fragSource);
  gl.useProgram(program);

  // ── Fullscreen quad ──────────────────────────────────────────
  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1,  1, -1, -1,  1,  -1,  1,  1, -1,  1,  1]),
    gl.STATIC_DRAW,
  );
  const posLoc = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  // ── Source texture ───────────────────────────────────────────
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  const texLoc = gl.getUniformLocation(program, "u_tex");
  gl.uniform1i(texLoc, 0);

  // ── User uniforms ────────────────────────────────────────────
  for (const [name, value] of Object.entries(uniforms)) {
    const loc = gl.getUniformLocation(program, name);
    if (loc == null) continue; // shader doesn't actually use this uniform
    if (typeof value === "number") {
      gl.uniform1f(loc, value);
    } else if (Array.isArray(value)) {
      if (value.length === 2) gl.uniform2f(loc, value[0], value[1]);
      else if (value.length === 3) gl.uniform3f(loc, value[0], value[1], value[2]);
      else if (value.length === 4) gl.uniform4f(loc, value[0], value[1], value[2], value[3]);
    }
  }

  // ── Draw ────────────────────────────────────────────────────
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // ── Read back as data URL ────────────────────────────────────
  const dataUrl = canvas.toDataURL(
    options.outputType ?? "image/png",
    options.outputQuality,
  );

  // Explicit teardown — drop GL resources so the context can be GC'd.
  gl.deleteTexture(tex);
  gl.deleteBuffer(quadBuffer);
  gl.deleteProgram(program);
  const loseCtx = gl.getExtension("WEBGL_lose_context");
  loseCtx?.loseContext();

  return dataUrl;
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
