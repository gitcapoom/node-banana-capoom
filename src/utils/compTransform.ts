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
  // optional center override (for FG_Alpha follow-FG): forces these center params
  centerOverride?: { auto: boolean; hPos: number; vPos: number; cx: number; cy: number; baseW: number; baseH: number },
): CompPieces {
  const sX = tr.scaleX * sx0;
  const sY = tr.scaleY * sy0;
  const ang = (tr.rotation * Math.PI) / 180;
  let c: [number, number];
  if (centerOverride) {
    c = centerOverride.auto
      ? [centerOverride.hPos + centerOverride.baseW / 2, centerOverride.vPos + centerOverride.baseH / 2]
      : [centerOverride.cx, centerOverride.cy];
  } else {
    const bw = iw * sx0, bh = ih * sy0;
    c = tr.centerAuto ? [tr.hPos + bw / 2, tr.vPos + bh / 2] : [tr.centerX, tr.centerY];
  }
  return { rot: [Math.cos(ang), Math.sin(ang)], c, t: [tr.hPos, tr.vPos], sX, sY, iw, ih };
}

/** Pieces for an independently-placed input. `ref` is the reformat reference. */
export function computePieces(
  tr: CompTransform, reformat: CompReformat, refW: number, refH: number, iw: number, ih: number,
): CompPieces {
  const [sx0, sy0] = reformatScale(reformat, refW, refH, iw, ih);
  return pieces(tr, sx0, sy0, iw, ih);
}

/**
 * Pieces for FG_Alpha when it FOLLOWS the FG: it sits where FG sits (FG's
 * translate/rotation/center) but uses its own pixels reformatted to FG's
 * natural size, scaled by FG's user scale.
 */
export function computeFollowPieces(
  fg: CompTransform, fgW: number, fgH: number, faReformat: CompReformat, faW: number, faH: number,
): CompPieces {
  const [sx0, sy0] = reformatScale(faReformat, fgW, fgH, faW, faH);
  // Center = FG's center (FG has no reformat ⇒ base rect = fgW×fgH).
  return pieces(fg, sx0, sy0, faW, faH, {
    auto: fg.centerAuto, hPos: fg.hPos, vPos: fg.vPos, cx: fg.centerX, cy: fg.centerY, baseW: fgW, baseH: fgH,
  });
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
