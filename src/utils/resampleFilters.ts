/**
 * Resampling / interpolation filters (Nuke-style) shared by the Comp node's GPU
 * sampler and the Reformat node's CPU resampler, so both offer the same menu and
 * matching math.
 *
 *  - impulse  : nearest neighbour (no interpolation, blocky)
 *  - bilinear : linear (hardware on the GPU)
 *  - cubic    : sharp interpolating cubic (B=0, C=0.75) — the default
 *  - keys     : Catmull-Rom (B=0, C=0.5) — interpolating, slightly softer
 *  - mitchell : Mitchell-Netravali (B=C=1/3) — balanced, no ringing
 *  - lanczos  : Lanczos-3 windowed sinc — sharpest, slight ringing
 *  - gaussian : Gaussian — soft / anti-alias
 */

export type ResampleFilter =
  | "impulse"
  | "bilinear"
  | "cubic"
  | "keys"
  | "mitchell"
  | "lanczos"
  | "gaussian";

/** Stable filter → int, mirrored by the shader's `int f` selector. Keep in sync
 *  with rs_weight / filterSample in RESAMPLE_GLSL below. */
export const RESAMPLE_FILTER_INDEX: Record<ResampleFilter, number> = {
  impulse: 0,
  bilinear: 1,
  cubic: 2,
  keys: 3,
  mitchell: 4,
  lanczos: 5,
  gaussian: 6,
};

/** Dropdown order + labels. */
export const RESAMPLE_FILTER_LABELS: Array<{ v: ResampleFilter; label: string }> = [
  { v: "impulse", label: "Impulse" },
  { v: "bilinear", label: "Bilinear" },
  { v: "cubic", label: "Cubic" },
  { v: "keys", label: "Keys" },
  { v: "mitchell", label: "Mitchell" },
  { v: "lanczos", label: "Lanczos" },
  { v: "gaussian", label: "Gaussian" },
];

/** Half-support (radius in source texels) per filter. */
export const FILTER_RADIUS: Record<ResampleFilter, number> = {
  impulse: 0.5,
  bilinear: 1,
  cubic: 2,
  keys: 2,
  mitchell: 2,
  lanczos: 3,
  gaussian: 2,
};

const GAUSS_SIGMA = 0.6;

function cubicBC(x: number, B: number, C: number): number {
  const ax = Math.abs(x);
  const x2 = ax * ax;
  const x3 = x2 * ax;
  if (ax < 1) return ((12 - 9 * B - 6 * C) * x3 + (-18 + 12 * B + 6 * C) * x2 + (6 - 2 * B)) / 6;
  if (ax < 2) return ((-B - 6 * C) * x3 + (6 * B + 30 * C) * x2 + (-12 * B - 48 * C) * ax + (8 * B + 24 * C)) / 6;
  return 0;
}

function sinc(x: number): number {
  if (Math.abs(x) < 1e-4) return 1;
  const p = Math.PI * x;
  return Math.sin(p) / p;
}

/** Filter weight at signed distance `x` (texels) from the sample point. */
export function filterWeight(filter: ResampleFilter, x: number): number {
  const ax = Math.abs(x);
  switch (filter) {
    case "impulse": return ax <= 0.5 ? 1 : 0;          // box → nearest
    case "bilinear": return ax < 1 ? 1 - ax : 0;       // triangle
    case "cubic": return cubicBC(x, 0, 0.75);          // sharp interpolating cubic
    case "keys": return cubicBC(x, 0, 0.5);            // Catmull-Rom
    case "mitchell": return cubicBC(x, 1 / 3, 1 / 3);
    case "lanczos": return ax < 3 ? sinc(x) * sinc(x / 3) : 0;
    case "gaussian": return Math.exp(-(x * x) / (2 * GAUSS_SIGMA * GAUSS_SIGMA));
    default: return cubicBC(x, 0, 0.5);
  }
}

/**
 * GLSL (ES 1.00) implementation of the same filters, for injection into a
 * fragment shader. Provides `vec4 filterSample(sampler2D tex, vec2 uv, vec2
 * size, int f)` which reconstructs the texture value at a fractional uv with the
 * chosen filter. Impulse/Bilinear are cheap (1 fetch); cubic family + gaussian
 * use a 4×4 window (16 fetches); lanczos uses 6×6 (36). Textures must be
 * CLAMP_TO_EDGE.
 */
export const RESAMPLE_GLSL = `
float rs_cubic(float x, float B, float C){
  x = abs(x); float x2 = x*x; float x3 = x2*x;
  if (x < 1.0) return ((12.0-9.0*B-6.0*C)*x3 + (-18.0+12.0*B+6.0*C)*x2 + (6.0-2.0*B)) / 6.0;
  if (x < 2.0) return ((-B-6.0*C)*x3 + (6.0*B+30.0*C)*x2 + (-12.0*B-48.0*C)*x + (8.0*B+24.0*C)) / 6.0;
  return 0.0;
}
float rs_sinc(float x){ if (abs(x) < 1e-4) return 1.0; float p = 3.14159265359 * x; return sin(p) / p; }
float rs_weight(float d, int f){
  if (f == 2) return rs_cubic(d, 0.0, 0.75);
  if (f == 3) return rs_cubic(d, 0.0, 0.5);
  if (f == 4) return rs_cubic(d, 0.3333333, 0.3333333);
  if (f == 5) { float a = abs(d); return a < 3.0 ? rs_sinc(d) * rs_sinc(d / 3.0) : 0.0; }
  if (f == 6) return exp(-(d*d) / (2.0 * 0.6 * 0.6));
  return rs_cubic(d, 0.0, 0.5);
}
vec4 filterSample(sampler2D tex, vec2 uv, vec2 size, int f){
  if (f == 1) return texture2D(tex, uv);
  if (f == 0) return texture2D(tex, (floor(uv * size) + 0.5) / size);
  vec2 texel = 1.0 / size;
  vec2 coord = uv * size - 0.5;
  vec2 base = floor(coord);
  vec2 fr = coord - base;
  vec4 acc = vec4(0.0); float wsum = 0.0;
  if (f == 5) {
    for (int j = -2; j <= 3; j++) {
      for (int i = -2; i <= 3; i++) {
        float w = rs_weight(float(i) - fr.x, 5) * rs_weight(float(j) - fr.y, 5);
        acc += texture2D(tex, (base + vec2(float(i), float(j)) + 0.5) * texel) * w;
        wsum += w;
      }
    }
  } else {
    for (int j = -1; j <= 2; j++) {
      for (int i = -1; i <= 2; i++) {
        float w = rs_weight(float(i) - fr.x, f) * rs_weight(float(j) - fr.y, f);
        acc += texture2D(tex, (base + vec2(float(i), float(j)) + 0.5) * texel) * w;
        wsum += w;
      }
    }
  }
  return wsum > 1e-5 ? acc / wsum : texture2D(tex, uv);
}
`;
