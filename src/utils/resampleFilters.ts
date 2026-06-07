/**
 * Resampling / interpolation filters (Nuke-style) for the Reformat node's CPU
 * resampler (resampleImage.ts).
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
