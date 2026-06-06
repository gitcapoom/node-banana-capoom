/**
 * Comp Types — a floating-point clone of Foundry Nuke's Merge node.
 *
 * Composites a foreground (FG) over a background (BG) with a full set of merge
 * operations, per-input affine transforms, an external grayscale FG alpha, and
 * a grayscale matte that limits where the merge applies. Output resolution /
 * format come from BG.
 *
 * Float pipeline: the Comp node participates in the float color chain
 * (src/utils/colorChain.ts) — its inputs read upstream float textures and its
 * output is published as a float texture, so values stay unclamped until an
 * 8-bit consumer. `outputImage` is the clamped 8-bit PNG for display / 8-bit
 * nodes / persistence.
 *
 * Coordinate convention (Nuke): (0,0) = BOTTOM-LEFT of each image. hPos+ =
 * right, vPos+ = up, rotation = CCW degrees. All transform positions/centers
 * are in BG-output pixels.
 */

import type { BaseNodeData } from "./annotation";

/** Merge operations. Order is mirrored by COMP_OP_INDEX (the shader selector). */
export type CompMergeOp =
  | "over"
  | "add"
  | "minus"
  | "difference"
  | "multiply"
  | "screen"
  | "overlay"
  | "softlight"
  | "hardlight"
  | "lighten"
  | "darken"
  | "divide"
  | "subtract"
  | "exclusion"
  | "from"
  | "in"
  | "out"
  | "atop"
  | "xor"
  | "mask"
  | "stencil"
  | "copy";

/** Reformat: how a secondary input is rescaled to its reference before the
 *  user transform. FG_Alpha references FG's natural size; Matte references BG. */
export type CompReformat = "none" | "fill" | "fitH" | "fitV";

/**
 * Per-input affine transform (FG, FG_Alpha, Matte — never BG).
 * `enabled` is the master checkbox that reveals the on-screen controls; for
 * FG_Alpha, `enabled=false` ALSO means "follow FG" (inherit FG's transform).
 * The rotation/scale center defaults to the image center (`centerAuto`), but
 * can be moved via centerX/centerY.
 */
export interface CompTransform {
  enabled: boolean;
  hPos: number;      // px, +right
  vPos: number;      // px, +up
  rotation: number;  // deg, CCW
  scaleX: number;
  scaleY: number;
  centerAuto: boolean; // true ⇒ center = image center (from decoded pixel size)
  centerX: number;     // bottom-left output px, used when centerAuto=false
  centerY: number;
}

export interface CompNodeData extends BaseNodeData {
  mergeOp: CompMergeOp;

  // Input mirrors — resolved reactively from the input handles by the node
  // component and the executor (routed by targetHandle). BG still sets the
  // output resolution/format; it can now also be transformed.
  bgImage: string | null;
  bgImageRef?: string;
  bgAlphaImage: string | null;
  bgAlphaImageRef?: string;
  fgImage: string | null;
  fgImageRef?: string;
  fgAlphaImage: string | null;
  fgAlphaImageRef?: string;
  matteImage: string | null;
  matteImageRef?: string;

  // Per-input transforms.
  bgTransform: CompTransform;
  bgAlphaTransform: CompTransform; // enabled=false ⇒ follow BG
  fgTransform: CompTransform;
  fgAlphaTransform: CompTransform; // enabled=false ⇒ follow FG
  matteTransform: CompTransform;   // independent whenever enabled

  bgAlphaReformat: CompReformat;   // matches BG
  fgAlphaReformat: CompReformat;   // matches FG
  matteReformat: CompReformat;     // matches BG

  /** Multiply the FG's RGB by its (effective) alpha before compositing. */
  premultiplyFg: boolean;

  /** Black-outside (Nuke): where a transformed input doesn't cover, leave it
   *  transparent/black (true) vs. hold the edge pixels (false). */
  bgBlackOutside: boolean;
  fgBlackOutside: boolean;

  // Output: 8-bit PNG for display / persistence / 8-bit consumers. The float
  // result lives in the colorChain registry keyed by this node's id.
  outputImage: string | null;
  outputImageRef?: string;
  outputWidth?: number;   // = BG dims
  outputHeight?: number;

  error?: string | null;
}

export function defaultCompTransform(enabled = false): CompTransform {
  return {
    enabled,
    hPos: 0,
    vPos: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    centerAuto: true,
    centerX: 0,
    centerY: 0,
  };
}

export function defaultCompData(): CompNodeData {
  return {
    mergeOp: "over",
    bgImage: null,
    bgAlphaImage: null,
    fgImage: null,
    fgAlphaImage: null,
    matteImage: null,
    bgTransform: defaultCompTransform(false),
    bgAlphaTransform: defaultCompTransform(false),
    fgTransform: defaultCompTransform(false),
    fgAlphaTransform: defaultCompTransform(false),
    matteTransform: defaultCompTransform(false),
    bgAlphaReformat: "none",
    fgAlphaReformat: "none",
    matteReformat: "none",
    premultiplyFg: false,
    bgBlackOutside: true,
    fgBlackOutside: true,
    outputImage: null,
    error: null,
  };
}

/**
 * Stable op → integer map. Drives both the dropdown order and the shader's
 * `u_op` selector. Keep in sync with the merge-op branch in colorChain.ts.
 */
export const COMP_OP_INDEX: Record<CompMergeOp, number> = {
  over: 0,
  add: 1,
  minus: 2,
  difference: 3,
  multiply: 4,
  screen: 5,
  overlay: 6,
  softlight: 7,
  hardlight: 8,
  lighten: 9,
  darken: 10,
  divide: 11,
  subtract: 12,
  exclusion: 13,
  from: 14,
  in: 15,
  out: 16,
  atop: 17,
  xor: 18,
  mask: 19,
  stencil: 20,
  copy: 21,
};

/** Human labels for the dropdown, in COMP_OP_INDEX order. */
export const COMP_OP_LABELS: Array<{ op: CompMergeOp; label: string }> = [
  { op: "over", label: "Over" },
  { op: "add", label: "Add (plus)" },
  { op: "minus", label: "Minus" },
  { op: "difference", label: "Difference" },
  { op: "multiply", label: "Multiply" },
  { op: "screen", label: "Screen" },
  { op: "overlay", label: "Overlay" },
  { op: "softlight", label: "Soft Light" },
  { op: "hardlight", label: "Hard Light" },
  { op: "lighten", label: "Lighten (max)" },
  { op: "darken", label: "Darken (min)" },
  { op: "divide", label: "Divide" },
  { op: "subtract", label: "Subtract" },
  { op: "exclusion", label: "Exclusion" },
  { op: "from", label: "From" },
  { op: "in", label: "In" },
  { op: "out", label: "Out" },
  { op: "atop", label: "Atop" },
  { op: "xor", label: "Xor" },
  { op: "mask", label: "Mask" },
  { op: "stencil", label: "Stencil" },
  { op: "copy", label: "Copy" },
];
