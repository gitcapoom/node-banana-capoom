/**
 * The commit signature for a Comp node — "do my inputs and parameters still match
 * what I last committed?"
 *
 * The hard part is that it must give the SAME answer either side of the lazy-load
 * boundary. On open every image field is null and only its file ref is present;
 * after hydration the same pixels are a 27-35MB data URL. A signature built from
 * the URL therefore flips the moment anything hydrates an upstream, the guard
 * misses, and the node re-composites and re-encodes output identical to the one
 * already on disk — 1.0-1.8s per comp.
 *
 * The stable token is the FILE REF, and it is stable for a specific reason:
 *
 *   - refs are content-addressed (`img-${md5(dataUrl)}`, imageStorage.ts), so the
 *     same pixels always produce the same ref;
 *   - hydration writes only the raw field and leaves the ref alone
 *     (hydrateForRun.ts), so loading does not disturb it;
 *   - every genuine recompute clears its ref (`{ outputImage, outputImageRef:
 *     undefined }`), so new pixels always invalidate.
 *
 *     upstream state           ref          raw        token
 *     saved, not yet loaded    img-abc      null       r:img-abc
 *     saved, hydrated          img-abc      dataURL    r:img-abc   <- unchanged
 *     genuinely recomputed     undefined    dataURL    u:<cheapKey> <- changed
 *
 * That last invariant — a raw write always clears its ref — is load-bearing, and
 * `outputRefField` below is where it is centralised so it cannot drift per node
 * type.
 */

import type { NodeType, WorkflowNode } from "@/types";
import { cheapUrlKey } from "@/utils/renderSignature";

/**
 * Which `*Ref` field corresponds to the value `getSourceOutput` returns for each
 * image-producing node type.
 *
 * A table rather than 26 widened return sites: `getSourceOutput` has a branch per
 * node type and threading a ref through each one is precisely the kind of edit
 * that rots the day someone adds a type. Here a missing entry degrades safely (the
 * pin falls back to a URL token — correct, just less stable), and the drift test
 * fails loudly.
 */
const OUTPUT_REF_FIELD: Partial<Record<NodeType, string>> = {
  imageInput: "imageRef", // special-cased below when a flip mirror is active
  annotation: "outputImageRef",
  nanoBanana: "outputImageRef",
  upscaleGrid: "outputImageRef",
  imageCrop: "outputImageRef",
  mirror: "outputImageRef",
  reformat: "outputImageRef",
  cubemapEquirect: "outputImageRef",
  panoShift: "outputImageRef",
  colorGrade: "outputImageRef",
  hsvCorrect: "outputImageRef",
  contrastAdjust: "outputImageRef",
  comp: "outputImageRef",
  blur: "outputImageRef",
  panoEditor: "outputImageRef",
  sphereLightRender: "outputImageRef",
  maskPainter: "outputMaskRef",
  roto: "outputMaskRef",
  viewer: "imageRef",
};

/** The ref for whichever field this node's output actually came from. */
export function outputRefField(node: WorkflowNode): string | null {
  const d = node.data as Record<string, unknown>;
  if (node.type === "imageInput") {
    // Mirrors getSourceOutput: a flip toggle makes outputImage the real output.
    const flipActive = !!d.flipHorizontal || !!d.flipVertical;
    const field = flipActive ? "outputImageRef" : "imageRef";
    return typeof d[field] === "string" ? (d[field] as string) : null;
  }
  const field = OUTPUT_REF_FIELD[node.type as NodeType];
  if (!field) return null;
  return typeof d[field] === "string" ? (d[field] as string) : null;
}

/**
 * One pin's contribution. Prefers the ref because it survives hydration; falls
 * back to a cheap URL key for pixels that exist but have never been saved.
 */
export function compPinToken(node: WorkflowNode | null | undefined, value: string | null | undefined): string {
  if (node) {
    const ref = outputRefField(node);
    if (ref) return `r:${ref}`;
  }
  if (value) return `u:${cheapUrlKey(value)}`;
  return "-";
}

export interface CompPinInput {
  /** Source node id, so a rewire invalidates even when the pixels match. */
  srcId: string | null;
  /** Pre-computed via compPinToken. Passed in rather than derived here because
   *  the node component already has it from its store selector and does not hold
   *  the source node objects — and because EVERY caller must produce the same
   *  string, which is only guaranteed if they all go through one function. */
  token: string;
}

export interface CompPins {
  bg: CompPinInput;
  bgAlpha: CompPinInput;
  fg: CompPinInput;
  fgAlpha: CompPinInput;
  matte: CompPinInput;
}

/**
 * Reconcile an incoming `text-comp_fg_align` value against what the comp already
 * holds, WITHOUT turning "field absent" into "field present and null".
 *
 * Both mean the same thing to the composite, but they serialize differently:
 * JSON.stringify omits an undefined key and emits `null` for a null one. Every
 * comp saved before this pin existed has the field absent, so writing null over
 * it — in the node's mirror, in the executor's mirror, or in the signature —
 * would change EVERY stored `compCommitSig` and force a full recomposite (1.0-1.8s
 * per comp) on the next open. Keep the existing value whenever it is equivalent.
 */
export function normalizeAlignMeta(
  current: string | null | undefined,
  incoming: string | null,
): string | null | undefined {
  return (current ?? null) === incoming ? current : incoming;
}

/**
 * Every input and parameter the composite depends on. Shared by the node
 * component, the executor and the save-time stamp — one definition, so they
 * cannot disagree about whether a comp is current.
 */
export function compCommitSignature(data: Record<string, unknown>, pins: CompPins): string {
  const pin = (p: CompPinInput) => `${p.srcId ?? "-"}#${p.token}`;
  return JSON.stringify({
    v: 1,
    bg: pin(pins.bg), ba: pin(pins.bgAlpha), fg: pin(pins.fg), fa: pin(pins.fgAlpha), mt: pin(pins.matte),
    op: data.mergeOp,
    pm: data.premultiplyFg, pmb: data.premultiplyBg,
    sw: data.swapBgFg, res: data.outputResolution,
    bo: [data.bgBlackOutside, data.fgBlackOutside],
    bgo: data.bgOpacity, fgo: data.fgOpacity,
    bgT: data.bgTransform, baT: data.bgAlphaTransform, fgT: data.fgTransform,
    faT: data.fgAlphaTransform, mtT: data.matteTransform,
    bar: data.bgAlphaReformat, far: data.fgAlphaReformat, mtr: data.matteReformat,
    bgF: data.bgFilter, baF: data.bgAlphaFilter, fgF: data.fgFilter,
    faF: data.fgAlphaFilter, mtF: data.matteFilter,
    bgR: data.bgResample, baR: data.bgAlphaResample, fgR: data.fgResample,
    faR: data.fgAlphaResample, mtR: data.matteResample,
    // FG auto-align. PLAIN FIELDS, not a sixth CompPins entry, and deliberately
    // so: every comp already on disk has all three undefined, JSON.stringify
    // omits undefined keys, and the emitted string is therefore byte-identical
    // to what those comps were saved with. A sixth pin would append `"fa6":"-"`
    // to every signature instead and invalidate the lot on next open.
    fgA: data.fgAlignMeta, fgAo: data.fgAlign, fgAf: data.fgAlignFit,
  });
}

/** Exposed for the drift test. */
export const __OUTPUT_REF_FIELD = OUTPUT_REF_FIELD;
