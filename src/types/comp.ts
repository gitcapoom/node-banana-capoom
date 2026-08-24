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
// Type-only, so it is erased at compile time and no import cycle exists at
// runtime even though compTransform.ts imports the transform types from here.
import type { CompAlignFit } from "@/utils/compTransform";
// Type-only for the same reason. The in-comp grade reuses the SHIPPED Grade
// parameter shape rather than declaring a parallel one — the maths that consumes
// it (GRADE_SHADER) is the standalone node's, so the parameters must be too.
import type { GradeParams, GradeChannelValue } from "@/utils/colorGrade";

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
 * Per-layer colour correction applied INSIDE the comp, to the BG or the FG
 * alone — the "fix this plate's look before it merges" block.
 *
 * BG and FG only, deliberately. The alpha and matte pins are masks; grading a
 * mask means shifting a matte's density through a hue wheel, which is a bug
 * generator with no use case behind it.
 *
 * Runs as a GPU PRE-PASS on that input's texture, BEFORE its blur filter and
 * before the transform samples it (see colorIntoUnlocked in colorChain.ts), and
 * it runs the standalone colorGrade / hsvCorrect shaders verbatim.
 *
 * `clampLow` / `clampHigh` default FALSE: `comp` is in COLOR_NODE_TYPES, so its
 * inputs and its output are unclamped floats. Clamping here would silently crush
 * the super-whites the rest of the chain is built to preserve. They apply to
 * whichever passes actually run — with both blocks off there is no pass, and
 * nothing to clamp.
 */
export interface CompLayerColor {
  /** Master switch for the Grade block. The parameters survive it being off, so
   *  a user can A/B a grade without losing it. */
  gradeEnabled: boolean;
  /**
   * Strictly GradeChannelValue — NOT ColorGradeNodeData's
   * `GradeChannelValue | number` union. That union exists only to carry
   * workflows saved before per-channel grading existed (`coerceChannel`); this
   * field has no such legacy and must not acquire one.
   *
   * The comp editor drives these through the SAME control as the standalone
   * node (components/controls/GradeRow.tsx) — a row is either linked (one master
   * track) or unlinked into three — so a value here can be genuinely
   * per-channel and always could be: the shape never changed, only the editor.
   */
  grade: GradeParams;
  hsvEnabled: boolean;
  hueShift: number;    // degrees
  saturation: number;  // multiplier; 1 = unchanged
  value: number;       // multiplier; 1 = unchanged
  clampLow: boolean;
  clampHigh: boolean;
}

/** One grade channel, defaulted per-component so a partial/garbage value out of
 *  a hand-edited file cannot reach the shader as NaN. */
function gradeChannel(v: Partial<GradeChannelValue> | undefined, fallback: number): GradeChannelValue {
  return {
    r: typeof v?.r === "number" && Number.isFinite(v.r) ? v.r : fallback,
    g: typeof v?.g === "number" && Number.isFinite(v.g) ? v.g : fallback,
    b: typeof v?.b === "number" && Number.isFinite(v.b) ? v.b : fallback,
  };
}

/** Complete a (possibly partial) grade. The identity values live here ONCE. */
export function normalizeCompGrade(g: Partial<GradeParams> | undefined | null): GradeParams {
  return {
    blackpoint: gradeChannel(g?.blackpoint, 0),
    whitepoint: gradeChannel(g?.whitepoint, 1),
    lift: gradeChannel(g?.lift, 0),
    gain: gradeChannel(g?.gain, 1),
    multiply: gradeChannel(g?.multiply, 1),
    offset: gradeChannel(g?.offset, 0),
    gamma: gradeChannel(g?.gamma, 1),
  };
}

export function defaultCompLayerColor(): CompLayerColor {
  return {
    gradeEnabled: false,
    grade: normalizeCompGrade(undefined),
    hsvEnabled: false,
    hueShift: 0,
    saturation: 1,
    value: 1,
    clampLow: false,
    clampHigh: false,
  };
}

/**
 * Complete a stored colour block, or return undefined for one that isn't there.
 *
 * ABSENT MUST STAY ABSENT. Returning a default object for `undefined` would let
 * a caller write one into a comp that never had one, which changes that comp's
 * commit signature and buys a full recomposite on next open for no visible
 * difference (see compSignature.ts). Everything that reads these fields goes
 * through here, so "no block" is one value, not several.
 */
export function normalizeCompLayerColor(
  c: Partial<CompLayerColor> | undefined | null,
): CompLayerColor | undefined {
  if (!c) return undefined;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    gradeEnabled: c.gradeEnabled === true,
    grade: normalizeCompGrade(c.grade),
    hsvEnabled: c.hsvEnabled === true,
    hueShift: num(c.hueShift, 0),
    saturation: num(c.saturation, 1),
    value: num(c.value, 1),
    clampLow: c.clampLow === true,
    clampHigh: c.clampHigh === true,
  };
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

  // ---- FG auto-align (crop → generate → composite back) -------------------
  //
  // A crop carries a serialized CropMetadata (utils/cropMetadata.ts) describing
  // the region it came from. Fed to the `text-comp_fg_align` pin, it lets the
  // comp drop a re-generated patch back exactly where it was cut from, whatever
  // resolution the generator chose to return.

  /**
   * Mirror of the `text-comp_fg_align` pin, written by the machinery (node
   * component / executor) exactly like the five image mirrors — hence its entry
   * in SKIP_UNDO_KEYS.
   *
   * `undefined` (a comp saved before this pin existed) and `null` (pin present,
   * carrying nothing) mean the same thing to the composite, but they do NOT
   * serialize the same: JSON.stringify omits the first and emits the second.
   * Everything that writes or signs this field must go through
   * `normalizeAlignMeta` (compSignature.ts) so the distinction is preserved.
   */
  fgAlignMeta?: string | null;

  /** Auto-align the FG onto the region its metadata came from. Composes
   *  UNDERNEATH `fgTransform` — align never writes into the user's transform,
   *  so their offsets stay theirs and stay editable. */
  fgAlign?: "auto" | "off";

  /** How a generated FG whose aspect no longer matches the crop rect fills it.
   *  "fit" (uniform, centred, BG showing through the slack) is the default. */
  fgAlignFit?: CompAlignFit;

  /**
   * Feather the FG's COVERAGE inward from its footprint edge, in OUTPUT px.
   *
   * This is the seam knob for the crop → generate → composite-back workflow: a
   * generated patch is opaque everywhere, so the FG's alpha IS the hard-edged
   * rectangle its transform covers, and that rectangle is the visible join.
   * Softness ramps that coverage 0→1 over the first `fgSoftness` output pixels.
   *
   * OUTPUT px, not source px, deliberately: align routinely scales a 4096px
   * generated patch into a 1024px hole, and a knob measured in source px would
   * mean a different amount of feather at every scale. compUniforms converts to
   * source px with the per-axis scale, so a non-uniformly scaled FG still
   * feathers the same number of output px on all four edges.
   *
   * Distinct from `fgFilter`, which blurs the FG's CONTENT in source space
   * before the transform and does nothing to the footprint edge.
   *
   * Inert when `fgBlackOutside` is false (there is no footprint edge then) and
   * when an FG_Alpha pin is connected (that pin REPLACES the FG's own alpha —
   * see the u_fg_soft gate in compUniforms). A Matte does NOT disable it: the
   * matte lerps the finished merge back to BG, it is not an FG coverage input.
   *
   * Optional and ABSENT on every comp saved before this existed — 0 and absent
   * are the same thing to every consumer, and absent is what keeps those comps'
   * signatures byte-identical (see compSignature.ts).
   */
  fgSoftness?: number;

  /**
   * Per-layer colour correction for the BG / FG plates (grade → HSV), applied
   * before their blur filter and before their transform.
   *
   * Optional and ABSENT on every comp saved before this existed, for the same
   * reason `fgSoftness` is: an absent block and an all-identity one are the same
   * thing to every consumer, and only the absent form keeps those comps'
   * signatures byte-identical. `normalizeCompLayerColor` is the single reader
   * and it preserves the distinction — it never manufactures a block.
   *
   * (`bgFilter` and friends ARE seeded in defaultCompData; these are not. That
   * is a deliberate divergence: the filter fields predate the signature work,
   * and seeding a ~15-number identity object into every new comp would put a
   * block on disk that means exactly nothing.)
   */
  bgColor?: CompLayerColor;
  fgColor?: CompLayerColor;

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
    // Align is armed by default but inert until the pin carries metadata — a
    // comp with nothing on `text-comp_fg_align` behaves exactly as before.
    fgAlignMeta: null,
    fgAlign: "auto",
    fgAlignFit: "fit",
    // fgSoftness is deliberately NOT listed. Absent and 0 mean the same thing to
    // buildCompParams, compUniforms and the shader, so writing 0 here would only
    // add a key — and it would make a comp built from these defaults serialize
    // differently from every comp already on disk for no behavioural difference.
    // bgColor / fgColor are absent for the same reason — see their declaration.
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
