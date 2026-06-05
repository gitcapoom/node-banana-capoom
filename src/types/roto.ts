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
  feather: { x: number; y: number };
  broken: boolean;
}

export interface RotoShape {
  id: string;
  points: RotoPoint[];
  closed: boolean;
  op: RotoBooleanOp;
  opacity: number; // 0–1, default 1
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
