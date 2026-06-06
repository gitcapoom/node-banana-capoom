/**
 * Rasterize roto shapes to a white-on-black matte (PNG data URL).
 *
 * Pure function — shared by the editor's "Done" and the workflow executor,
 * so a headless run produces the same matte without opening the editor.
 *
 * ## Per-point variable feather
 * Each shape has a main Bezier curve and a feather curve (the main curve
 * rigidly translated per-point by `feather − anchor`). The soft edge runs
 * from the shape curve (coverage 1) to the feather curve (coverage 0), and
 * its WIDTH varies per point because the two curves diverge by different
 * amounts around the loop.
 *
 * We render this on the CPU by additively stacking `RAMP_STEPS` interpolated
 * polygons between the shape and feather polylines using the "lighter"
 * (additive) composite op: a pixel covered by k of the nested layers ends
 * up at grayscale k/STEPS — a clean linear ramp whose width follows the
 * per-point divergence automatically. This also handles concave / self-
 * intersecting shapes (native canvas fills) and feather pulled either
 * outward or inward, with no GPU dependency.
 *
 * Shapes composite in array order: union = per-pixel max ("lighten"),
 * subtract = multiply the accumulator by (1 − coverage).
 */

import type { RotoShape, RotoPoint, RotoFeatherFalloff } from "@/types";

export interface RasterizeRotoOptions {
  invert?: boolean;
}

const RAMP_STEPS = 64;     // feather ramp resolution
const SEG_SAMPLES = 24;    // polyline samples per Bezier segment

type Pt = { x: number; y: number };

/**
 * Coverage profile across the feather band: `t` runs 0 (shape edge, fully
 * covered) → 1 (feather edge, uncovered); returns coverage in [0,1].
 * "linear" reproduces the original ramp; the others reshape the falloff.
 */
type FeatherProfile = (t: number) => number;
function featherProfile(kind: RotoFeatherFalloff | undefined): FeatherProfile {
  switch (kind) {
    case "smooth":   return (t) => 1 - t * t * (3 - 2 * t);                 // smoothstep
    case "smoother": return (t) => 1 - t * t * t * (t * (t * 6 - 15) + 10); // smootherstep
    case "easeIn":   return (t) => 1 - t * t;                              // solid → quick drop
    case "easeOut":  return (t) => (1 - t) * (1 - t);                      // quick drop → eased
    case "linear":
    default:         return (t) => 1 - t;
  }
}

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

// Feather control points, falling back to the shape point for legacy data.
const fAnchor = (p: RotoPoint): Pt => p.feather ?? p.anchor;
const fIn = (p: RotoPoint): Pt => p.featherIn ?? p.inHandle;
const fOut = (p: RotoPoint): Pt => p.featherOut ?? p.outHandle;

/**
 * Sample a shape into two corresponding polylines: the main curve and the
 * feather curve (built from the per-point feather anchor + feather
 * tangents). Index i lines up between the two so lerp(shape[i],
 * feather[i], t) is the interpolated boundary used for the feather ramp.
 */
function sampleShape(shape: RotoShape): { shapePoly: Pt[]; featherPoly: Pt[] } {
  const pts = shape.points;
  const shapePoly: Pt[] = [];
  const featherPoly: Pt[] = [];
  if (pts.length < 2) return { shapePoly, featherPoly };
  const segCount = shape.closed ? pts.length : pts.length - 1;
  for (let s = 0; s < segCount; s++) {
    const a = pts[s];
    const b = pts[(s + 1) % pts.length];
    const s0 = a.anchor, s1 = a.outHandle, s2 = b.inHandle, s3 = b.anchor;
    const f0 = fAnchor(a), f1 = fOut(a), f2 = fIn(b), f3 = fAnchor(b);
    const last = s === segCount - 1 && !shape.closed ? SEG_SAMPLES : SEG_SAMPLES - 1;
    for (let k = 0; k <= last; k++) {
      const t = k / SEG_SAMPLES;
      shapePoly.push(cubicAt(s0, s1, s2, s3, t));
      featherPoly.push(cubicAt(f0, f1, f2, f3, t));
    }
  }
  return { shapePoly, featherPoly };
}

function fillPolygon(ctx: CanvasRenderingContext2D, poly: Pt[]): void {
  if (poly.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.fill();
}

/** Unit tangent at polyline vertex i (uses neighbours; clamps for open ends). */
function tangentAt(poly: Pt[], i: number, closed: boolean): Pt {
  const n = poly.length;
  const prev = closed ? poly[(i - 1 + n) % n] : poly[Math.max(0, i - 1)];
  const next = closed ? poly[(i + 1) % n] : poly[Math.min(n - 1, i + 1)];
  const dx = next.x - prev.x, dy = next.y - prev.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/** Per-vertex unit normals with a globally-consistent outward orientation
 *  (anchored at the leftmost — always convex — vertex). For an open polyline
 *  the sign is arbitrary but consistent, which is all the stroke ribbon needs. */
function outwardNormals(poly: Pt[], closed: boolean): Pt[] {
  const n = poly.length;
  if (n === 0) return [];
  let cx = 0, cy = 0;
  for (const p of poly) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  let ex = 0;
  for (let i = 1; i < n; i++) if (poly[i].x < poly[ex].x) ex = i;
  const te = tangentAt(poly, ex, closed);
  const sign = (te.y * (poly[ex].x - cx) + -te.x * (poly[ex].y - cy)) >= 0 ? 1 : -1;
  const normals: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = tangentAt(poly, i, closed);
    normals.push({ x: sign * t.y, y: -sign * t.x });
  }
  return normals;
}

/** Fill a symmetric ribbon of per-vertex half-width `hw(i)` around centerline
 *  `C` (offset ±hw along normal `N`). Closed → an annulus (even-odd); open → a
 *  strip with butt caps. */
function fillRibbon(ctx: CanvasRenderingContext2D, C: Pt[], N: Pt[], hw: (i: number) => number, closed: boolean): void {
  const n = C.length;
  if (n < 2) return;
  const out = (i: number): Pt => ({ x: C[i].x + hw(i) * N[i].x, y: C[i].y + hw(i) * N[i].y });
  const inn = (i: number): Pt => ({ x: C[i].x - hw(i) * N[i].x, y: C[i].y - hw(i) * N[i].y });
  ctx.beginPath();
  if (closed) {
    const o0 = out(0); ctx.moveTo(o0.x, o0.y);
    for (let i = 1; i < n; i++) { const p = out(i); ctx.lineTo(p.x, p.y); }
    ctx.closePath();
    const iN = inn(n - 1); ctx.moveTo(iN.x, iN.y);
    for (let i = n - 2; i >= 0; i--) { const p = inn(i); ctx.lineTo(p.x, p.y); }
    ctx.closePath();
    ctx.fill("evenodd");
  } else {
    const o0 = out(0); ctx.moveTo(o0.x, o0.y);
    for (let i = 1; i < n; i++) { const p = out(i); ctx.lineTo(p.x, p.y); }
    for (let i = n - 1; i >= 0; i--) { const p = inn(i); ctx.lineTo(p.x, p.y); }
    ctx.closePath();
    ctx.fill();
  }
}

/** Trace a shape's main Bezier into a 2D context path (no fill). Exported
 *  for the editor's lightweight preview. */
export function traceRotoPath(ctx: CanvasRenderingContext2D, shape: RotoShape): void {
  const pts = shape.points;
  if (pts.length < 2) return;
  ctx.moveTo(pts[0].anchor.x, pts[0].anchor.y);
  const segCount = shape.closed ? pts.length : pts.length - 1;
  for (let s = 0; s < segCount; s++) {
    const a = pts[s];
    const b = pts[(s + 1) % pts.length];
    ctx.bezierCurveTo(a.outHandle.x, a.outHandle.y, b.inHandle.x, b.inHandle.y, b.anchor.x, b.anchor.y);
  }
  if (shape.closed) ctx.closePath();
}

/** Build a single shape's grayscale coverage (0..opacity) on its own canvas. */
function renderShapeCoverage(shape: RotoShape, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  // transparent → black background equivalent (we read RGB later over black)
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

  const { shapePoly, featherPoly } = sampleShape(shape);
  const opacity = shape.opacity ?? 1;
  const gf = shape.globalFeather ?? 0;
  const profile = featherProfile(shape.featherFalloff);

  // ── Edge mode: stroke the spline, feathered on BOTH sides ──────────────
  if ((shape.renderMode ?? "fill") === "edge") {
    if (shapePoly.length < 2) return canvas;
    const half = Math.max(0, (shape.strokeWidth ?? 8) / 2);
    const N = outwardNormals(shapePoly, shape.closed);
    // Per-sample feather width = per-point feather magnitude + global feather.
    const featherW = featherPoly.map((f, i) => Math.max(0, Math.hypot(f.x - shapePoly[i].x, f.y - shapePoly[i].y) + gf));
    const anyFeather = featherW.some((w) => w > 0.01);
    if (!anyFeather) {
      const v = Math.round(255 * opacity);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      fillRibbon(ctx, shapePoly, N, () => half, shape.closed);
      return canvas;
    }
    // Outside-in nested ribbons: half-width half + featherW*t, coverage profile(t).
    ctx.globalCompositeOperation = "source-over";
    for (let g = RAMP_STEPS; g >= 0; g--) {
      const t = g / RAMP_STEPS;
      const cov = profile(t) * opacity;
      if (cov <= 0) continue;
      const v = Math.round(255 * cov);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      fillRibbon(ctx, shapePoly, N, (i) => half + featherW[i] * t, shape.closed);
    }
    return canvas;
  }

  // ── Fill mode ──────────────────────────────────────────────────────────
  if (shapePoly.length < 3) return canvas;

  // Effective feather curve = per-point feather, expanded outward by the
  // global feather along the normal (so the two work together).
  let effFeather = featherPoly;
  if (gf !== 0) {
    const N = outwardNormals(shapePoly, shape.closed);
    effFeather = featherPoly.map((f, i) => ({ x: f.x + gf * N[i].x, y: f.y + gf * N[i].y }));
  }
  const hasFeather = effFeather.some((f, i) => f.x !== shapePoly[i].x || f.y !== shapePoly[i].y);

  if (!hasFeather) {
    // Hard edge — single solid fill at the shape's opacity.
    const v = Math.round(255 * opacity);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    fillPolygon(ctx, shapePoly);
    return canvas;
  }

  // Soft edge. Draw nested polygons from the feather curve (t=1, coverage 0)
  // INWARD to the shape curve (t=0, coverage 1), each filled opaquely with the
  // falloff profile's coverage for that band. Outside→in source-over keeps the
  // innermost (smallest-t) polygon's value at each pixel → an exact ramp.
  ctx.globalCompositeOperation = "source-over";
  for (let g = RAMP_STEPS; g >= 0; g--) {
    const t = g / RAMP_STEPS; // 1 = feather curve, 0 = shape curve
    const cov = profile(t) * opacity;
    if (cov <= 0) continue; // fully-uncovered bands are no-ops over black
    const v = Math.round(255 * cov);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    const poly = t === 0 ? shapePoly : shapePoly.map((sp, i) => ({
      x: sp.x + (effFeather[i].x - sp.x) * t,
      y: sp.y + (effFeather[i].y - sp.y) * t,
    }));
    fillPolygon(ctx, poly);
  }

  return canvas;
}

export function rasterizeRoto(
  shapes: RotoShape[],
  width: number,
  height: number,
  opts: RasterizeRotoOptions = {},
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  // Black background = outside everything.
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

  for (const shape of shapes) {
    if (shape.points.length < 2) continue;
    const cov = renderShapeCoverage(shape, width, height);
    if (shape.op === "subtract") {
      // acc *= (1 − coverage): invert the coverage, multiply onto accumulator.
      const inv = document.createElement("canvas");
      inv.width = width;
      inv.height = height;
      const ictx = inv.getContext("2d")!;
      ictx.fillStyle = "#ffffff";
      ictx.fillRect(0, 0, width, height);
      ictx.globalCompositeOperation = "difference"; // white − cov = 1 − cov
      ictx.drawImage(cov, 0, 0);
      ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(inv, 0, 0);
      ctx.globalCompositeOperation = "source-over";
    } else {
      // union: per-pixel max.
      ctx.globalCompositeOperation = "lighten";
      ctx.drawImage(cov, 0, 0);
      ctx.globalCompositeOperation = "source-over";
    }
  }

  // Invert (RGB only; alpha stays opaque — matches MaskPainter convention).
  if (opts.invert) {
    const im = ctx.getImageData(0, 0, width, height);
    const d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
    }
    ctx.putImageData(im, 0, 0);
  }

  // Pin alpha to 255 so the matte is an opaque grayscale PNG.
  const im = ctx.getImageData(0, 0, width, height);
  const d = im.data;
  for (let i = 3; i < d.length; i += 4) d[i] = 255;
  ctx.putImageData(im, 0, 0);

  return canvas.toDataURL("image/png");
}
