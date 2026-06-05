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

import type { RotoShape, RotoPoint } from "@/types";

export interface RasterizeRotoOptions {
  invert?: boolean;
}

const RAMP_STEPS = 48;     // feather ramp resolution
const SEG_SAMPLES = 24;    // polyline samples per Bezier segment

type Pt = { x: number; y: number };

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
  if (shapePoly.length < 3) return canvas;

  const opacity = shape.opacity ?? 1;
  const hasFeather = featherPoly.some((f, i) => f.x !== shapePoly[i].x || f.y !== shapePoly[i].y);

  if (!hasFeather) {
    // Hard edge — single solid fill at the shape's opacity.
    const v = Math.round(255 * opacity);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    fillPolygon(ctx, shapePoly);
    return canvas;
  }

  // Additive ramp: stack interpolated polygons shape→feather. A pixel
  // covered by k nested layers ends at grayscale k/STEPS * opacity.
  ctx.globalCompositeOperation = "lighter";
  const layerVal = Math.max(1, Math.round((255 * opacity) / RAMP_STEPS));
  ctx.fillStyle = `rgb(${layerVal},${layerVal},${layerVal})`;
  for (let g = 1; g <= RAMP_STEPS; g++) {
    const t = g / RAMP_STEPS; // 0 = shape curve, 1 = feather curve
    const poly = shapePoly.map((sp, i) => ({
      x: sp.x + (featherPoly[i].x - sp.x) * t,
      y: sp.y + (featherPoly[i].y - sp.y) * t,
    }));
    fillPolygon(ctx, poly);
  }
  // Pin the solid core (inside the shape curve) to full opacity so additive
  // rounding never leaves the interior below the intended level.
  ctx.globalCompositeOperation = "source-over";
  const coreV = Math.round(255 * opacity);
  ctx.fillStyle = `rgb(${coreV},${coreV},${coreV})`;
  fillPolygon(ctx, shapePoly);

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
