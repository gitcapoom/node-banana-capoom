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
 * Blur/defocus filter kinds, shared by the Blur node and the Comp's per-input
 * filters (both run on the same GPU passes in colorChain.ts).
 */
export type BlurFilterType = "gaussian" | "box" | "motion" | "zoom" | "spin";

/**
 * Per-input filter applied to a comp input's texture BEFORE the merge shader
 * samples it (float-preserving pre-pass). `radius` is the amount: pixels for
 * gaussian/box/motion; zoom/spin scale proportionally. `angle` is the motion
 * direction in degrees CCW (0 = horizontal).
 */
export interface CompInputFilter {
  filter: BlurFilterType | "none";
  radius: number;
  angle: number;
}

export function defaultCompFilter(): CompInputFilter {
  return { filter: "none", radius: 10, angle: 0 };
}

/**
 * RECONSTRUCTION filter — which kernel rebuilds the source when a transform
 * resamples it. This is the Transform-node "filter" in the compositing sense
 * (Nuke's impulse/cubic/Keys/Mitchell/Parzen/Lanczos), and is a different thing
 * entirely from CompInputFilter above, which is a blur applied AFTER sampling.
 *
 * It only has an effect where the sampling grid does not line up with the
 * source grid — i.e. under scale, rotation or sub-pixel translation. At
 * identity it is a passthrough by construction.
 *
 *   impulse    nearest neighbour — no interpolation, hard aliased edges
 *   bilinear   2x2 linear; the previous behaviour, and the default
 *   keys       Catmull-Rom (B=0, C=1/2) — sharp, mild ringing
 *   mitchell   Mitchell-Netravali (B=1/3, C=1/3) — balanced, the usual default
 *   parzen     cubic B-spline (B=1, C=0) — soft, no ringing
 *   lanczos4   windowed sinc, a=2 — sharp
 *   lanczos6   windowed sinc, a=3 — sharpest, most ringing, most taps
 */
export type CompResampleFilter =
  | "impulse"
  | "bilinear"
  | "keys"
  | "mitchell"
  | "parzen"
  | "lanczos4"
  | "lanczos6"
  | "gaussian";

/** Order matters: the index is what the shader receives as u_*_flt. */
export const COMP_RESAMPLE_FILTERS: CompResampleFilter[] = [
  // APPEND ONLY. The index is the value handed to the shader as u_*_flt and it
  // is what saved workflows resolve against — inserting in the middle would
  // silently repoint every comp already on disk at a different filter.
  "impulse", "bilinear", "keys", "mitchell", "parzen", "lanczos4", "lanczos6", "gaussian",
];

export const COMP_RESAMPLE_LABELS: Record<CompResampleFilter, string> = {
  impulse: "Impulse",
  bilinear: "Bilinear",
  keys: "Keys",
  mitchell: "Mitchell",
  parzen: "Parzen",
  lanczos4: "Lanczos4",
  lanczos6: "Lanczos6",
  gaussian: "Gaussian",
};

/** Bilinear: what every transform did before this was configurable, so
 *  existing comps keep the look they were built with. */
export function defaultCompResample(): CompResampleFilter {
  return "bilinear";
}

export function compResampleIndex(f: CompResampleFilter | undefined): number {
  const i = COMP_RESAMPLE_FILTERS.indexOf(f ?? "bilinear");
  return i < 0 ? 1 : i;
}

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
  scaleLock: boolean;  // Scale Y follows Scale X (uniform scale)
  centerAuto: boolean; // true ⇒ center = image center (from decoded pixel size)
  // When centerAuto=false: the pivot's anchor in IMAGE/source px (0..iw, 0..ih),
  // forward-mapped (scale+translate) so it locks to that pixel as the image moves.
  centerX: number;
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

  // Per-input filters (blur/defocus pre-pass). Optional so legacy saves load
  // untouched — absent ⇒ "none".
  /** Blur/defocus applied AFTER sampling (labelled "Blur" in the editor). */
  bgFilter?: CompInputFilter;
  bgAlphaFilter?: CompInputFilter;
  fgFilter?: CompInputFilter;
  fgAlphaFilter?: CompInputFilter;
  matteFilter?: CompInputFilter;
  /** Reconstruction filter used WHILE transforming (labelled "Filter"). */
  bgResample?: CompResampleFilter;
  bgAlphaResample?: CompResampleFilter;
  fgResample?: CompResampleFilter;
  fgAlphaResample?: CompResampleFilter;
  matteResample?: CompResampleFilter;

  /** Multiply the FG's / BG's RGB by its (effective) alpha before compositing. */
  premultiplyFg: boolean;
  premultiplyBg: boolean;

  /** Per-layer opacity (0..1). Scales each input's alpha before the merge, so
   *  the BG / FG can be faded toward transparent independently. */
  bgOpacity: number;
  fgOpacity: number;

  /** Black-outside (Nuke): where a transformed input doesn't cover, leave it
   *  transparent/black (true) vs. hold the edge pixels (false). */
  bgBlackOutside: boolean;
  fgBlackOutside: boolean;

  /** Swap the BG and FG roles in the merge (their alphas swap too). Pins and
   *  per-input transforms stay attached to their slots. */
  swapBgFg: boolean;

  /** Which input's native size defines the output resolution. */
  outputResolution: "bg" | "fg";

  /** Display only: show transparent (non-occupied) pixels as a checkerboard
   *  (true) instead of solid black (false). Does not affect the output. */
  checkerboard: boolean;

  // Output: 8-bit PNG for display / persistence / 8-bit consumers. The float
  // result lives in the colorChain registry keyed by this node's id.
  outputImage: string | null;
  outputImageRef?: string;
  outputImageThumb?: string; // Inline small PNG preview (alpha-preserving)
  /** The commit signature this node's outputImage was produced from. Persisted so
   *  a FIRST open can tell "already current" from "needs recompute" — the session
   *  cache is empty then. See compSignature.ts. */
  compCommitSig?: string;
  /** cheapUrlKey of the outputImage this thumb was made from — proves the thumb
   *  matches the pixels without needing a file ref (the ref is cleared on every
   *  genuine recompute). Same contract as commitProcessorOutput. */
  outputImageThumbKey?: string | null;
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
    scaleLock: false,
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
    bgFilter: defaultCompFilter(),
    bgAlphaFilter: defaultCompFilter(),
    fgFilter: defaultCompFilter(),
    fgAlphaFilter: defaultCompFilter(),
    matteFilter: defaultCompFilter(),
    bgResample: defaultCompResample(),
    bgAlphaResample: defaultCompResample(),
    fgResample: defaultCompResample(),
    fgAlphaResample: defaultCompResample(),
    matteResample: defaultCompResample(),
    premultiplyFg: false,
    premultiplyBg: false,
    bgOpacity: 1,
    fgOpacity: 1,
    bgBlackOutside: true,
    fgBlackOutside: true,
    swapBgFg: false,
    outputResolution: "bg",
    checkerboard: false,
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
