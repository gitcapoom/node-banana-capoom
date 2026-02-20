/**
 * Mask Painter Types
 *
 * Types for the mask painting system used in inpainting workflows.
 * The mask painter allows drawing black brush strokes on a source image,
 * outputting a white-on-black mask (white = area to inpaint).
 */

import type { BaseNodeData } from "./annotation";

/**
 * A single mask brush stroke
 */
export interface MaskStroke {
  id: string;
  points: number[];      // [x0, y0, x1, y1, ...]
  strokeWidth: number;
  tool: "brush" | "eraser";
}

/**
 * Mask Painter node data - stores source image with painted mask strokes
 */
export interface MaskPainterNodeData extends BaseNodeData {
  sourceImage: string | null;
  strokes: MaskStroke[];
  outputMask: string | null;       // White-on-black mask data URL
  brushSize: number;               // Default 30
  blurRadius: number;              // Post-blur in pixels, default 0
  invertMask: boolean;             // Default false
}

/**
 * Tool type for mask painter (simplified from annotation ToolType)
 */
export type MaskTool = "brush" | "eraser";
