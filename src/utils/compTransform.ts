/**
 * Pure affine-transform math for the Comp node — shared by the GPU compositor
 * (inverse pieces → shader uniforms) and the CompModal editor (forward → handle
 * placement) so on-screen handles and the rendered result always agree.
 *
 * Convention: (0,0) = BOTTOM-LEFT of every image; output px space = BG px.
 * hPos+ = right, vPos+ = up, rotation = CCW degrees. A point is placed by:
 *   O = R * ( (s .* (sX,sY)) + t - c ) + c
 * where s = source px (bottom-left), R = CCW rotation, c = the pivot in output
 * px and t the translate that puts the pivot there. That shader-shaped form is
 * equivalent to the way it actually reads:
 *   O = R * ( (s - k) .* (sX,sY) ) + c
 * i.e. scale and rotate about the SAME pivot k (source px), landing it at c.
 * `t` is therefore a derived quantity (c - k .* S), not the user's hPos/vPos.
 *
 * Keeping the first form means the GPU shader's `invSample` and its uniforms
 * (rot, c, t, invs, size) are untouched by the pivot behaviour.
 */

import type { CompTransform, CompReformat } from "@/types";

export interface CompPieces {
  rot: [number, number]; // cos, sin of the CCW angle
  c: [number, number];   // pivot, in output px — where the centre pixel lands
  k: [number, number];   // the same pivot as a SOURCE px of this input
  /**
   * Derived translate (output px) = c - k .* (sX,sY). NOT the user's hPos/vPos:
   * it is whatever makes the shader form above scale and rotate about `c`.
   * Use `inversePoint`/`forwardPoint` to convert between spaces rather than
   * reaching into this.
   */
  t: [number, number];
  sX: number;            // total X scale (user * reformat base)
  sY: number;
  iw: number;            // source pixel size
  ih: number;
}

/** Reformat base scale: rescale a (iw×ih) input toward a (refW×refH) reference. */
export function reformatScale(reformat: CompReformat, refW: number, refH: number, iw: number, ih: number): [number, number] {
  if (iw <= 0 || ih <= 0) return [1, 1];
  switch (reformat) {
    case "fill": return [refW / iw, refH / ih];
    case "fitH": return [refW / iw, refW / iw];
    case "fitV": return [refH / ih, refH / ih];
    case "none":
    default: return [1, 1];
  }
}

function pieces(
  tr: CompTransform, sx0: number, sy0: number, iw: number, ih: number,
  // optional pivot override (for FG_Alpha follow-FG): the pivot's output px `c`
  // together with the SOURCE px `k` of this input that must land on it.
  centerOverride?: { c: [number, number]; k: [number, number] },
): CompPieces {
  const sX = tr.scaleX * sx0;
  const sY = tr.scaleY * sy0;
  const ang = (tr.rotation * Math.PI) / 180;

  // The pivot, as a SOURCE pixel. Auto = the image-centre pixel; manual
  // (centerAuto=false) = the pixel the user assigned.
  let k: [number, number];
  let c: [number, number];
  if (centerOverride) {
    k = centerOverride.k;
    c = centerOverride.c;
  } else {
    k = [tr.centerAuto ? iw / 2 : tr.centerX, tr.centerAuto ? ih / 2 : tr.centerY];
    // Where that pixel LANDS. Only the reformat/align base scale (sx0) applies
    // here, never the user scale: the base is the image's natural placement,
    // and the user's scale is the thing that pivots about this point. Folding
    // the user scale in (c = k * sX + t) is what made the pivot slide as you
    // scaled — rotation still pivoted correctly, but scale ran about the source
    // origin and the centre had no effect on it at all.
    c = [k[0] * sx0 + tr.hPos, k[1] * sy0 + tr.vPos];
  }

  // Derived so that O = R * ((s - k) .* S) + c in the shader's form.
  const t: [number, number] = [c[0] - k[0] * sX, c[1] - k[1] * sY];

  return { rot: [Math.cos(ang), Math.sin(ang)], c, k, t, sX, sY, iw, ih };
}

/**
 * An automatically-derived placement that sits UNDER the user's manual
 * transform: the user's H/V/Scale stay a delta on top of it, so auto-align
 * never has to write into (and clobber) fgTransform.
 * Scales ride the same slot as `reformatScale`; positions are output px.
 */
export interface CompAlignBase { sX: number; sY: number; hPos: number; vPos: number }

/** No-op base — lets the base-aware helpers keep their un-aligned behaviour. */
const IDENTITY_BASE: CompAlignBase = { sX: 1, sY: 1, hPos: 0, vPos: 0 };

/** Fold the base's translate into the transform so the pivot sees the total too. */
function withBaseOffset(tr: CompTransform, base: CompAlignBase): CompTransform {
  if (base.hPos === 0 && base.vPos === 0) return tr;
  return { ...tr, hPos: base.hPos + tr.hPos, vPos: base.vPos + tr.vPos };
}

/** Pieces for an independently-placed input. `ref` is the reformat reference. */
export function computePieces(
  tr: CompTransform, reformat: CompReformat, refW: number, refH: number, iw: number, ih: number,
): CompPieces {
  const [sx0, sy0] = reformatScale(reformat, refW, refH, iw, ih);
  return pieces(tr, sx0, sy0, iw, ih);
}

/**
 * Pieces for an independently-placed input with an auto-align base underneath
 * the user's manual transform. The base takes the same slot `reformatScale`
 * feeds, so it is multiplied by the user scale rather than replacing it, and
 * its translate is folded in before the pivot is derived — the pivot therefore
 * anchors against the TOTAL scale/translate, as it does un-aligned.
 */
export function computeAlignedPieces(
  tr: CompTransform, base: CompAlignBase, iw: number, ih: number,
): CompPieces {
  return pieces(withBaseOffset(tr, base), base.sX, base.sY, iw, ih);
}

/**
 * Pieces for FG_Alpha when it FOLLOWS the FG: it sits where FG sits (FG's
 * translate/rotation/center) but uses its own pixels reformatted to FG's
 * natural size, scaled by FG's user scale.
 *
 * `base` is FG's auto-align base: a followed FG_Alpha must inherit the ALIGNED
 * placement, otherwise a connected FG mask sits in the un-aligned position
 * while the FG it mattes is aligned.
 */
export function computeFollowPieces(
  fg: CompTransform, fgW: number, fgH: number, faReformat: CompReformat, faW: number, faH: number,
  base: CompAlignBase = IDENTITY_BASE,
): CompPieces {
  const [sx0, sy0] = reformatScale(faReformat, fgW, fgH, faW, faH);
  const fgAligned = withBaseOffset(fg, base);
  // FG_Alpha pivots around the FG's centre. FG has no reformat ⇒ its scale is
  // fg.scaleX/Y times the align base; its centre is the auto (fgW/2) or
  // manually-assigned source pixel, forward-mapped into output px.
  const fcx = fg.centerAuto ? fgW / 2 : fg.centerX;
  const fcy = fg.centerAuto ? fgH / 2 : fg.centerY;
  // FG's pivot lands here (base scale only — see `pieces`).
  const cFg: [number, number] = [
    fcx * base.sX + fgAligned.hPos,
    fcy * base.sY + fgAligned.vPos,
  ];
  // The same point expressed in FA's OWN source px. FA is reformatted onto FG's
  // natural size by sx0/sy0, so FA pixel a corresponds to FG pixel a * sx0 —
  // the FA pixel that must sit on FG's pivot is therefore fcx / sx0.
  const kFa: [number, number] = [sx0 !== 0 ? fcx / sx0 : 0, sy0 !== 0 ? fcy / sy0 : 0];
  return pieces(fgAligned, sx0 * base.sX, sy0 * base.sY, faW, faH, { c: cFg, k: kFa });
}

/** Forward-map a source px (bottom-left) → output px (bottom-left). */
export function forwardPoint(p: CompPieces, sx: number, sy: number): { x: number; y: number } {
  const [cos, sin] = p.rot;
  const px = sx * p.sX + p.t[0] - p.c[0];
  const py = sy * p.sY + p.t[1] - p.c[1];
  return { x: cos * px - sin * py + p.c[0], y: sin * px + cos * py + p.c[1] };
}

/**
 * Output px → source px. The exact inverse of `forwardPoint`.
 *
 * Exists so UI code (dragging the centre or a scale handle) does not hand-roll
 * the inverse from `t`/`sX`: `t` is a derived quantity and that arithmetic
 * silently stopped being correct when the pivot semantics changed.
 */
export function inversePoint(p: CompPieces, ox: number, oy: number): { x: number; y: number } {
  const [cos, sin] = p.rot;
  const dx = ox - p.c[0];
  const dy = oy - p.c[1];
  // R^-1 (rotate by -angle)
  const rx = cos * dx + sin * dy;
  const ry = -sin * dx + cos * dy;
  return {
    x: p.sX !== 0 ? (rx + p.c[0] - p.t[0]) / p.sX : 0,
    y: p.sY !== 0 ? (ry + p.c[1] - p.t[1]) / p.sY : 0,
  };
}

/** The 4 corners of the placed input, in output px (bottom-left): BL, BR, TR, TL. */
export function forwardCorners(p: CompPieces): Array<{ x: number; y: number }> {
  return [
    forwardPoint(p, 0, 0),
    forwardPoint(p, p.iw, 0),
    forwardPoint(p, p.iw, p.ih),
    forwardPoint(p, 0, p.ih),
  ];
}

/** How a generated FG whose aspect no longer matches the crop fills the crop rect. */
export type CompAlignFit = "stretch" | "fit" | "fill";

/** A BG this far off the source's aspect (0.5%) is not a reformat of it. */
const ALIGN_ASPECT_TOLERANCE = 0.005;

/**
 * Everything auto-align knows BEFORE anything is decoded: the crop's own
 * geometry (straight off the metadata) plus the user's fit choice. Split out
 * because `buildCompParams` has no image access — it can parse and forward this,
 * and only `compUniforms`, which holds the decoded sizes, can finish the job.
 */
export interface CompAlignSpec {
  crop: { x: number; y: number; width: number; height: number };   // source px (integers)
  region: { x: number; y: number; width: number; height: number }; // relative 0-1, top-left
  srcW: number; srcH: number;      // the crop's source image
  fit: CompAlignFit;
}

/** The crop rect placed in output/BG px, BOTTOM-LEFT origin (comp space). */
export interface CompAlignRect { x: number; y: number; w: number; h: number }

/**
 * Where the crop's region lands in the comp's output frame, or null when the BG
 * cannot be that crop's source.
 *
 * `crop` is the INTEGER sample rect the cropper actually handed to drawImage —
 * not `region * srcW/H` recomputed here. `cropImageToDataUrl` rounds origin and
 * extent independently (`round(x*W)` vs `max(1, round(w*W))`), so a recomputed
 * rect can be a pixel off, or run past the source edge. Only the integers that
 * produced the pixels describe where they came from.
 *
 * Separate from `deriveAlignBase` because the editor needs the rect itself, not
 * a placement: the aspect warning compares the FG against the rect it is being
 * dropped into, and recomputing that rect in the UI is exactly how the on-screen
 * numbers drift away from the render.
 */
export function alignRectInOutput(spec: CompAlignSpec, outW: number, outH: number): CompAlignRect | null {
  const { crop, region, srcW, srcH } = spec;
  if (srcW <= 0 || srcH <= 0 || outW <= 0 || outH <= 0) return null;
  if (crop.width <= 0 || crop.height <= 0) return null;

  // The crop rect expressed in BG/output px, still top-left/y-down.
  let rx: number, ry: number, rw: number, rh: number;
  if (outW === srcW && outH === srcH) {
    // BG *is* the source: use the exact integers, no rescale, no rounding drift.
    rx = crop.x; ry = crop.y; rw = crop.width; rh = crop.height;
  } else if (Math.abs((outW / outH) / (srcW / srcH) - 1) <= ALIGN_ASPECT_TOLERANCE) {
    // Same picture at another resolution (proxy / reformat). The integer crop
    // belongs to the full-res grid, so scale from the RELATIVE region instead —
    // and leave it fractional: there is no drawImage here to round for.
    rx = region.x * outW; ry = region.y * outH;
    rw = region.width * outW; rh = region.height * outH;
    if (rw <= 0 || rh <= 0) return null;
  } else {
    return null; // different aspect ⇒ not this crop's source
  }

  // The one Y flip in the feature: crop space is top-left/y-down, comp transform
  // space is bottom-left/y-up, so the rect's TOP edge measured down from the top
  // becomes its BOTTOM edge measured up from the bottom.
  return { x: rx, y: outH - (ry + rh), w: rw, h: rh };
}

/**
 * Derive the align base that drops a generated FG back onto the exact region it
 * was cropped from, whatever size the generator chose to return.
 *
 * Returns null when the BG cannot be the crop's source — the caller disables
 * align and says so rather than placing the patch somewhere invented.
 */
export function deriveAlignBase(args: CompAlignSpec & {
  fgW: number; fgH: number;        // decoded FG texture size
  outW: number; outH: number;      // comp output frame (BG space)
}): CompAlignBase | null {
  const { fgW, fgH, outW, outH, fit } = args;
  if (fgW <= 0 || fgH <= 0) return null;
  const rect = alignRectInOutput(args, outW, outH);
  if (!rect) return null;
  const { x: rx, y: bottom, w: rw, h: rh } = rect;

  const stretchX = rw / fgW;
  const stretchY = rh / fgH;
  if (fit === "stretch") return { sX: stretchX, sY: stretchY, hPos: rx, vPos: bottom };

  // Uniform scale: "fit" keeps the whole FG inside the rect (BG shows through
  // the slack), "fill" covers the rect (the FG overhangs). Either way the
  // leftover is split evenly so the patch stays centred on what it replaced.
  const s = fit === "fill" ? Math.max(stretchX, stretchY) : Math.min(stretchX, stretchY);
  return {
    sX: s,
    sY: s,
    hPos: rx + (rw - fgW * s) / 2,
    vPos: bottom + (rh - fgH * s) / 2,
  };
}

/** Shader uniforms for one input (prefix e.g. "u_fg"). */
export function piecesToUniforms(prefix: string, p: CompPieces): Record<string, [number, number]> {
  return {
    [`${prefix}_rot`]: p.rot,
    [`${prefix}_c`]: p.c,
    [`${prefix}_t`]: p.t,
    [`${prefix}_invs`]: [p.sX !== 0 ? 1 / p.sX : 0, p.sY !== 0 ? 1 / p.sY : 0],
    [`${prefix}_size`]: [p.iw, p.ih],
  };
}
