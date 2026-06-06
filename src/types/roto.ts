/**
 * Roto Types — static (no keyframes) cubic-Bezier roto shapes over a source
 * image. Output is a white-on-black matte (white = inside union shapes).
 *
 * All point/handle coordinates are ABSOLUTE source-image pixels (same
 * convention as MaskPainter strokes) so Konva drag handlers write
 * node.x()/y() straight through and the rasterizer calls bezierCurveTo with
 * no conversion.
 */

import type { BaseNodeData } from "./annotation";

export type RotoBooleanOp = "union" | "subtract";

/**
 * Falloff profile for a shape's feather — how coverage ramps from the shape
 * edge (1) to the feather edge (0). "linear" is the historical default.
 *  - smooth   : smoothstep S-curve (eases at both ends)
 *  - smoother : smootherstep (Perlin) — even gentler ends
 *  - easeIn   : holds solid near the shape, falls off fast near the feather
 *  - easeOut  : falls off fast near the shape, eases out near the feather
 */
export type RotoFeatherFalloff = "linear" | "smooth" | "smoother" | "easeIn" | "easeOut";

/**
 * How a shape rasterizes:
 *  - "fill" : the closed area is the matte (default).
 *  - "edge" : the spline is stroked with a thickness, feathered on BOTH sides.
 *             Open (unclosed) splines are allowed in this mode.
 */
export type RotoRenderMode = "fill" | "edge";

/**
 * One control point of a cubic-Bezier roto shape.
 *  - anchor:    on-curve point
 *  - inHandle:  cubic control point for the segment ARRIVING at this anchor
 *  - outHandle: cubic control point for the segment LEAVING this anchor
 *  - feather:   per-point feather boundary point. Default = anchor (no
 *               feather → hard edge). Dragging it outward softens the matte
 *               edge near this point. The feather Bezier is the shape Bezier
 *               rigidly translated per-point by (feather − anchor).
 *  - broken:    false = tangents are smooth (collinear through the anchor);
 *               true  = the two tangents move independently.
 */
export interface RotoPoint {
  id: string;
  anchor: { x: number; y: number };
  inHandle: { x: number; y: number };
  outHandle: { x: number; y: number };
  /** Feather control point + its own tangents (so the feather curve can be
   *  shaped independently of the shape curve). Default = the matching shape
   *  point (feather = anchor, featherIn = inHandle, featherOut = outHandle)
   *  → the feather curve coincides with the shape curve → hard edge. */
  feather: { x: number; y: number };
  featherIn: { x: number; y: number };
  featherOut: { x: number; y: number };
  broken: boolean;
  /** Feather tangents broken (independent) vs smooth (mirrored). */
  featherBroken?: boolean;
}

export interface RotoShape {
  id: string;
  points: RotoPoint[];
  closed: boolean;
  op: RotoBooleanOp;
  opacity: number; // 0–1, default 1
  /** Feather edge falloff profile. Default "linear". */
  featherFalloff?: RotoFeatherFalloff;
  /** Uniform feather (px) added to every point's feather, along the outward
   *  normal. Works TOGETHER with the per-point feather, not instead of it.
   *  Default 0. Negative pulls the feather inward. */
  globalFeather?: number;
  /** Fill the area (default) or stroke the spline edge. */
  renderMode?: RotoRenderMode;
  /** Edge mode: stroke thickness in px. Default 8. */
  strokeWidth?: number;
}

export interface RotoNodeData extends BaseNodeData {
  sourceImage: string | null;
  sourceImageRef?: string;
  shapes: RotoShape[];
  outputMask: string | null; // white-on-black matte data URL
  outputMaskRef?: string;
  invert: boolean; // default false
  /** Resolution the shapes were authored at — used by the executor to
   *  rasterize headlessly and by a future migration to rescale. */
  imageWidth?: number;
  imageHeight?: number;
}

export type RotoTool = "select" | "pen";
