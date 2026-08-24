/**
 * Pure affine-transform math for the Comp node — shared by the GPU compositor
 * (inverse pieces → shader uniforms) and the CompModal editor (forward → handle
 * placement) so on-screen handles and the rendered result always agree.
 *
 * Convention: (0,0) = BOTTOM-LEFT of every image; output px space = BG px.
 * hPos+ = right, vPos+ = up, rotation = CCW degrees. A point is placed by:
 *   O = R * ( (s .* (sX,sY)) + t - c ) + c
 * where s = source px (bottom-left), R = CCW rotation, c = rotation/scale center.
 */

import type { CompTransform, CompReformat } from "@/types";

export interface CompPieces {
  rot: [number, number]; // cos, sin of the CCW angle
  c: [number, number];   // center (output px)
  t: [number, number];   // translate (output px)
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
  // optional absolute output-px center override (for FG_Alpha follow-FG)
  centerOverride?: { c: [number, number] },
): CompPieces {
  const sX = tr.scaleX * sx0;
  const sY = tr.scaleY * sy0;
  const ang = (tr.rotation * Math.PI) / 180;
  let c: [number, number];
  if (centerOverride) {
    c = centerOverride.c;
  } else {
    // The rotation/scale pivot is anchored to a SOURCE pixel of the image and
    // forward-mapped (scale + translate), so it locks to that pixel as the image
    // moves or scales. Auto = the image-centre pixel; manual (centerAuto=false) =
    // the pixel the user assigned (centerX/centerY are in image/source px).
    const scx = tr.centerAuto ? iw / 2 : tr.centerX;
    const scy = tr.centerAuto ? ih / 2 : tr.centerY;
    c = [scx * sX + tr.hPos, scy * sY + tr.vPos];
  }
  return { rot: [Math.cos(ang), Math.sin(ang)], c, t: [tr.hPos, tr.vPos], sX, sY, iw, ih };
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
  const cFg: [number, number] = [
    fcx * fg.scaleX * base.sX + fgAligned.hPos,
    fcy * fg.scaleY * base.sY + fgAligned.vPos,
  ];
  return pieces(fgAligned, sx0 * base.sX, sy0 * base.sY, faW, faH, { c: cFg });
}

/** Forward-map a source px (bottom-left) → output px (bottom-left). */
export function forwardPoint(p: CompPieces, sx: number, sy: number): { x: number; y: number } {
  const [cos, sin] = p.rot;
  const px = sx * p.sX + p.t[0] - p.c[0];
  const py = sy * p.sY + p.t[1] - p.c[1];
  return { x: cos * px - sin * py + p.c[0], y: sin * px + cos * py + p.c[1] };
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
 * Derive the align base that drops a generated FG back onto the exact region it
 * was cropped from, whatever size the generator chose to return.
 *
 * `crop` is the INTEGER sample rect the cropper actually handed to drawImage —
 * not `region * srcW/H` recomputed here. `cropImageToDataUrl` rounds origin and
 * extent independently (`round(x*W)` vs `max(1, round(w*W))`), so a recomputed
 * rect can be a pixel off, or run past the source edge. Only the integers that
 * produced the pixels describe where they came from.
 *
 * Returns null when the BG cannot be the crop's source — the caller disables
 * align and says so rather than placing the patch somewhere invented.
 */
export function deriveAlignBase(args: {
  crop: { x: number; y: number; width: number; height: number };   // source px (integers)
  region: { x: number; y: number; width: number; height: number }; // relative 0-1, top-left
  srcW: number; srcH: number;      // the crop's source image
  fgW: number; fgH: number;        // decoded FG texture size
  outW: number; outH: number;      // comp output frame (BG space)
  fit: CompAlignFit;
}): CompAlignBase | null {
  const { crop, region, srcW, srcH, fgW, fgH, outW, outH, fit } = args;
  if (srcW <= 0 || srcH <= 0 || fgW <= 0 || fgH <= 0 || outW <= 0 || outH <= 0) return null;
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
  const bottom = outH - (ry + rh);

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
