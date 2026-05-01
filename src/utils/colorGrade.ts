/**
 * Nuke-style Grade node implemented on the 2D canvas.
 *
 * Formula (per channel, all values normalised 0..1):
 *   A = multiply * (gain - lift) / (whitepoint - blackpoint)
 *   B = offset + lift - blackpoint * A
 *   out = clamp(pow(in * A + B, 1 / gamma), 0, 1)
 *
 * Parameter semantics match Nuke's Grade:
 *   - blackpoint  : input level mapped to `lift` (0 = no remap on the low end)
 *   - whitepoint  : input level mapped to `gain` (1 = no remap on the high end)
 *   - lift        : output level for input == blackpoint  (raises blacks)
 *   - gain        : output level for input == whitepoint  (scales highlights)
 *   - multiply    : scalar applied after lift/gain (linear gain)
 *   - offset      : constant added after multiply
 *   - gamma       : applied last; values >1 brighten midtones, <1 darken
 *
 * Identity grade: blackpoint=0, whitepoint=1, lift=0, gain=1, multiply=1,
 * offset=0, gamma=1 — produces a pixel-identical copy of the input.
 */

export interface GradeParams {
  blackpoint: number;
  whitepoint: number;
  lift: number;
  gain: number;
  multiply: number;
  offset: number;
  gamma: number;
}

export const IDENTITY_GRADE: GradeParams = {
  blackpoint: 0,
  whitepoint: 1,
  lift: 0,
  gain: 1,
  multiply: 1,
  offset: 0,
  gamma: 1,
};

export function isIdentityGrade(p: GradeParams): boolean {
  return (
    p.blackpoint === 0 &&
    p.whitepoint === 1 &&
    p.lift === 0 &&
    p.gain === 1 &&
    p.multiply === 1 &&
    p.offset === 0 &&
    p.gamma === 1
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

/**
 * Apply a Nuke-style grade to the input image. Returns a PNG data URL.
 * Skips the canvas pass when the grade is the identity (returns the source
 * unchanged).
 */
export async function applyGrade(src: string, params: GradeParams): Promise<string> {
  if (isIdentityGrade(params)) return src;

  const wbp = params.whitepoint - params.blackpoint;
  if (wbp === 0) return src; // singular — no remap possible

  const A = (params.multiply * (params.gain - params.lift)) / wbp;
  const B = params.offset + params.lift - params.blackpoint * A;
  const invGamma = params.gamma > 0 ? 1 / params.gamma : 1;

  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D context");
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, img.width, img.height);
  const data = id.data;

  // Pre-compute a 256-entry LUT to avoid pow() per pixel — ~9× faster on
  // typical photo dimensions. Negative pre-gamma values clamp to 0 (pow of
  // a negative is NaN); post-gamma clamps to [0, 1] so HDR-ish overshoots
  // from gain > 1 don't blow out.
  const lut = new Uint8ClampedArray(256);
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

  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
    // alpha untouched
  }

  ctx.putImageData(id, 0, 0);
  return canvas.toDataURL("image/png");
}
