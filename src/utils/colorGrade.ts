/**
 * Nuke-style Grade node implemented on the 2D canvas.
 *
 * Each grade parameter is a 3-channel value (R, G, B) so users can either
 * keep all three locked together (master mode) or unlink and tune per
 * channel — same model as Nuke's Grade.
 *
 * Per-channel formula (linear in 0..1 normalised pixel space):
 *   A = multiply * (gain - lift) / (whitepoint - blackpoint)
 *   B = offset + lift - blackpoint * A
 *   out = clamp(pow(in * A + B, 1 / gamma), 0, 1)
 *
 * The 256-entry LUT is computed once per channel, then applied in a single
 * tight pixel loop.
 */

export interface GradeChannelValue {
  r: number;
  g: number;
  b: number;
}

export interface GradeParams {
  blackpoint: GradeChannelValue;
  whitepoint: GradeChannelValue;
  lift: GradeChannelValue;
  gain: GradeChannelValue;
  multiply: GradeChannelValue;
  offset: GradeChannelValue;
  gamma: GradeChannelValue;
}

/** Build a uniform channel value (master). */
export function masterValue(v: number): GradeChannelValue {
  return { r: v, g: v, b: v };
}

/** True when r === g === b (the row visually behaves as a master slider). */
export function isMaster(v: GradeChannelValue): boolean {
  return v.r === v.g && v.g === v.b;
}

/**
 * Coerce loaded data — handles both old (single number) and new
 * (GradeChannelValue) formats so workflows saved before per-channel was
 * added still load correctly.
 */
export function coerceChannel(
  v: number | GradeChannelValue | null | undefined,
  fallback: number
): GradeChannelValue {
  if (v == null) return masterValue(fallback);
  if (typeof v === "number") return masterValue(v);
  if (typeof v === "object") {
    return {
      r: typeof v.r === "number" ? v.r : fallback,
      g: typeof v.g === "number" ? v.g : fallback,
      b: typeof v.b === "number" ? v.b : fallback,
    };
  }
  return masterValue(fallback);
}

export const IDENTITY_GRADE: GradeParams = {
  blackpoint: masterValue(0),
  whitepoint: masterValue(1),
  lift: masterValue(0),
  gain: masterValue(1),
  multiply: masterValue(1),
  offset: masterValue(0),
  gamma: masterValue(1),
};

export function isIdentityGrade(p: GradeParams): boolean {
  return (
    isMaster(p.blackpoint) && p.blackpoint.r === 0 &&
    isMaster(p.whitepoint) && p.whitepoint.r === 1 &&
    isMaster(p.lift)       && p.lift.r === 0 &&
    isMaster(p.gain)       && p.gain.r === 1 &&
    isMaster(p.multiply)   && p.multiply.r === 1 &&
    isMaster(p.offset)     && p.offset.r === 0 &&
    isMaster(p.gamma)      && p.gamma.r === 1
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load source image"));
    img.src = src;
  });
}

/** Build a 256-entry uint8 LUT for a single channel. */
function buildLut(blackpoint: number, whitepoint: number, lift: number, gain: number, multiply: number, offset: number, gamma: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const wbp = whitepoint - blackpoint;
  if (wbp === 0) {
    // Singular — pass-through identity for this channel.
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  const A = (multiply * (gain - lift)) / wbp;
  const B = offset + lift - blackpoint * A;
  const invGamma = gamma > 0 ? 1 / gamma : 1;

  for (let i = 0; i < 256; i++) {
    const v0 = i / 255;
    const linear = v0 * A + B;
    let out: number;
    if (linear <= 0) out = 0;
    else out = Math.pow(linear, invGamma);
    if (out < 0) out = 0;
    else if (out > 1) out = 1;
    lut[i] = Math.round(out * 255);
  }
  return lut;
}

/**
 * Apply the per-channel grade. Returns a PNG data URL. Skips the pass
 * when the grade is identity (returns the source unchanged).
 *
 * GPU-native — uses the WebGL helper with the `GRADE_SHADER` from
 * `imageShaders.ts`. Same math as the legacy `buildLut` CPU path
 * (verified to match within float rounding for typical 8-bit images),
 * but runs ~20-50× faster on 4K material and frees the main thread for
 * live slider-drag preview.
 */
export async function applyGrade(src: string, params: GradeParams): Promise<string> {
  if (isIdentityGrade(params)) return src;
  // Lazy-imported to keep colorGrade.ts tree-shakeable from server code
  // that might still want hexToChannel / channelToHex.
  const [{ processImageWithShader }, { GRADE_SHADER }] = await Promise.all([
    import("./webglProcess"),
    import("./imageShaders"),
  ]);
  return processImageWithShader(src, GRADE_SHADER, {
    u_blackpoint: [params.blackpoint.r, params.blackpoint.g, params.blackpoint.b],
    u_whitepoint: [params.whitepoint.r, params.whitepoint.g, params.whitepoint.b],
    u_lift:       [params.lift.r,       params.lift.g,       params.lift.b],
    u_gain:       [params.gain.r,       params.gain.g,       params.gain.b],
    u_multiply:   [params.multiply.r,   params.multiply.g,   params.multiply.b],
    u_offset:     [params.offset.r,     params.offset.g,     params.offset.b],
    u_gamma:      [params.gamma.r,      params.gamma.g,      params.gamma.b],
  });
}

// ─── Hex ⇄ channel value helpers (for color-picker integration) ─────

/** Convert "#RRGGBB" to a normalised 0-1 channel value. */
export function hexToChannel(hex: string): GradeChannelValue {
  const h = hex.replace("#", "");
  if (h.length !== 6) return masterValue(0);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return { r, g, b };
}

/** Convert a channel value to "#RRGGBB" (clamped to 0-1 for the picker). */
export function channelToHex(v: GradeChannelValue): string {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const toHex = (x: number) => {
    const n = Math.round(clamp(x) * 255);
    return n.toString(16).padStart(2, "0");
  };
  return `#${toHex(v.r)}${toHex(v.g)}${toHex(v.b)}`;
}
