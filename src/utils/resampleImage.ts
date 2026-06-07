/**
 * High-quality separable image resampling on the CPU, used by the Reformat node
 * for the non-trivial filters (cubic / keys / mitchell / lanczos / gaussian)
 * that Canvas 2D can't do. Impulse / bilinear stay on the (GPU-accelerated)
 * canvas path — see reformatImage.ts.
 *
 * Two 1D passes (horizontal then vertical). On downscale the filter support is
 * widened in source space so it pre-filters (anti-aliases) instead of point
 * sampling. Works in premultiplied alpha to avoid colour bleeding from
 * transparent pixels, then un-premultiplies.
 */

import { type ResampleFilter, filterWeight, FILTER_RADIUS } from "./resampleFilters";

interface AxisContrib {
  indices: number[];
  weights: number[];
}

function buildContributors(srcSize: number, dstSize: number, filter: ResampleFilter): AxisContrib[] {
  const scale = dstSize / srcSize;
  const invScale = 1 / scale;
  const downscaling = scale < 1;
  // Widen support on downscale; compress the filter argument so weights span the
  // wider source window (proper minification).
  const support = FILTER_RADIUS[filter] * (downscaling ? invScale : 1);
  const filterScale = downscaling ? scale : 1;

  const out: AxisContrib[] = new Array(dstSize);
  for (let o = 0; o < dstSize; o++) {
    const center = (o + 0.5) * invScale - 0.5; // source coordinate
    const left = Math.ceil(center - support);
    const right = Math.floor(center + support);
    const indices: number[] = [];
    const weights: number[] = [];
    let wsum = 0;
    for (let s = left; s <= right; s++) {
      const w = filterWeight(filter, (s - center) * filterScale);
      if (w === 0) continue;
      const clamped = s < 0 ? 0 : s >= srcSize ? srcSize - 1 : s; // edge-extend
      indices.push(clamped);
      weights.push(w);
      wsum += w;
    }
    if (wsum !== 0) for (let k = 0; k < weights.length; k++) weights[k] /= wsum;
    out[o] = { indices, weights };
  }
  return out;
}

function clamp8(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

export function resampleImageData(
  src: ImageData,
  dstW: number,
  dstH: number,
  filter: ResampleFilter,
): ImageData {
  const sw = src.width, sh = src.height, sd = src.data;
  const W = Math.max(1, Math.round(dstW));
  const H = Math.max(1, Math.round(dstH));

  // Premultiply the source (RGB × alpha) into a float buffer.
  const pm = new Float32Array(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const a = sd[i * 4 + 3] / 255;
    pm[i * 4] = sd[i * 4] * a;
    pm[i * 4 + 1] = sd[i * 4 + 1] * a;
    pm[i * 4 + 2] = sd[i * 4 + 2] * a;
    pm[i * 4 + 3] = sd[i * 4 + 3];
  }

  // Horizontal pass: sw×sh → W×sh (premultiplied float).
  const cx = buildContributors(sw, W, filter);
  const tmp = new Float32Array(W * sh * 4);
  for (let y = 0; y < sh; y++) {
    const rowOff = y * sw * 4;
    for (let x = 0; x < W; x++) {
      const { indices, weights } = cx[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < indices.length; k++) {
        const o = rowOff + indices[k] * 4;
        const w = weights[k];
        r += pm[o] * w; g += pm[o + 1] * w; b += pm[o + 2] * w; a += pm[o + 3] * w;
      }
      const to = (y * W + x) * 4;
      tmp[to] = r; tmp[to + 1] = g; tmp[to + 2] = b; tmp[to + 3] = a;
    }
  }

  // Vertical pass: W×sh → W×H, then un-premultiply on write.
  const cy = buildContributors(sh, H, filter);
  const out = new ImageData(W, H);
  const od = out.data;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const { indices, weights } = cy[y];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < indices.length; k++) {
        const o = (indices[k] * W + x) * 4;
        const w = weights[k];
        r += tmp[o] * w; g += tmp[o + 1] * w; b += tmp[o + 2] * w; a += tmp[o + 3] * w;
      }
      const to = (y * W + x) * 4;
      const inv = a > 1e-4 ? 255 / a : 0;
      od[to] = clamp8(r * inv);
      od[to + 1] = clamp8(g * inv);
      od[to + 2] = clamp8(b * inv);
      od[to + 3] = clamp8(a);
    }
  }
  return out;
}
