/**
 * The transform centre must pivot BOTH rotation and scale.
 *
 * It did rotation only. The placement was
 *
 *     O = R * ( s·S + t − c ) + c        with   c = centre·S + t
 *
 * so `c` — the pivot's position in output px — was itself a function of the
 * scale. Rotation therefore pivoted correctly about the chosen pixel, but scale
 * was applied about the source ORIGIN (bottom-left) and the pivot simply slid
 * along with it. Moving the centre changed nothing about how the image scaled,
 * even though the type docs call it "the rotation/scale center" and the node is
 * a Nuke Transform clone, where centre governs both.
 */

import { describe, it, expect } from "vitest";
import { computePieces, forwardPoint, inversePoint } from "../compTransform";
import type { CompTransform } from "@/types";

const IW = 100;
const IH = 100;

function tr(over: Partial<CompTransform> = {}): CompTransform {
  return {
    hPos: 0,
    vPos: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    scaleLock: true,
    centerAuto: true,
    centerX: 0,
    centerY: 0,
    ...over,
  } as CompTransform;
}

/** Where does the pivot pixel itself land in output px? */
function pivotOut(t: CompTransform) {
  const p = computePieces(t, "none", IW, IH, IW, IH);
  const cx = t.centerAuto ? IW / 2 : t.centerX;
  const cy = t.centerAuto ? IH / 2 : t.centerY;
  return forwardPoint(p, cx, cy);
}

describe("transform centre pivots scale", () => {
  it("holds a manual centre fixed as the image scales", () => {
    const at1 = pivotOut(tr({ centerAuto: false, centerX: 25, centerY: 25 }));
    const at2 = pivotOut(tr({ centerAuto: false, centerX: 25, centerY: 25, scaleX: 2, scaleY: 2 }));

    expect(at1.x).toBeCloseTo(25, 6);
    expect(at1.y).toBeCloseTo(25, 6);
    // Scaling must not move the pixel you are scaling about.
    expect(at2.x).toBeCloseTo(25, 6);
    expect(at2.y).toBeCloseTo(25, 6);
  });

  it("holds the auto (image-centre) pivot fixed as the image scales", () => {
    const at1 = pivotOut(tr());
    const at3 = pivotOut(tr({ scaleX: 3, scaleY: 3 }));
    expect(at1.x).toBeCloseTo(50, 6);
    expect(at3.x).toBeCloseTo(50, 6);
    expect(at3.y).toBeCloseTo(50, 6);
  });

  it("grows the image about the centre, not the bottom-left corner", () => {
    // Auto centre, scale 2: a 100x100 at the origin should span -50..150 in both
    // axes, symmetric about (50,50). Scaling about the corner would give 0..200.
    const p = computePieces(tr({ scaleX: 2, scaleY: 2 }), "none", IW, IH, IW, IH);
    const bl = forwardPoint(p, 0, 0);
    const trc = forwardPoint(p, IW, IH);
    expect(bl.x).toBeCloseTo(-50, 6);
    expect(bl.y).toBeCloseTo(-50, 6);
    expect(trc.x).toBeCloseTo(150, 6);
    expect(trc.y).toBeCloseTo(150, 6);
  });

  it("scales about a manual centre asymmetrically", () => {
    // Centre at the bottom-left corner: scaling should then grow up-and-right
    // only, leaving the corner where it is.
    const p = computePieces(
      tr({ centerAuto: false, centerX: 0, centerY: 0, scaleX: 2, scaleY: 2 }),
      "none", IW, IH, IW, IH,
    );
    const bl = forwardPoint(p, 0, 0);
    const trc = forwardPoint(p, IW, IH);
    expect(bl.x).toBeCloseTo(0, 6);
    expect(bl.y).toBeCloseTo(0, 6);
    expect(trc.x).toBeCloseTo(200, 6);
    expect(trc.y).toBeCloseTo(200, 6);
  });

  it("still pivots rotation about the centre (unchanged behaviour)", () => {
    // 90 deg CCW about the image centre maps the BL corner to the BR corner.
    const p = computePieces(tr({ rotation: 90 }), "none", IW, IH, IW, IH);
    const bl = forwardPoint(p, 0, 0);
    expect(bl.x).toBeCloseTo(100, 6);
    expect(bl.y).toBeCloseTo(0, 6);
  });

  it("keeps translate independent of the centre", () => {
    // hPos/vPos shift the whole result regardless of where the pivot sits.
    const a = forwardPoint(
      computePieces(tr({ centerAuto: false, centerX: 10, centerY: 90, hPos: 37, vPos: -12 }), "none", IW, IH, IW, IH),
      0, 0,
    );
    expect(a.x).toBeCloseTo(37, 6);
    expect(a.y).toBeCloseTo(-12, 6);
  });

  it("composes rotation and scale about the same centre", () => {
    // Scale 2 then rotate 180 about the image centre: BL -> where TR would be.
    const p = computePieces(tr({ scaleX: 2, scaleY: 2, rotation: 180 }), "none", IW, IH, IW, IH);
    const bl = forwardPoint(p, 0, 0);
    expect(bl.x).toBeCloseTo(150, 6);
    expect(bl.y).toBeCloseTo(150, 6);
  });
});

describe("inversePoint", () => {
  const hard = tr({
    centerAuto: false, centerX: 17, centerY: 83,
    rotation: 37, scaleX: 1.7, scaleY: 0.6, hPos: 45, vPos: -22,
  });

  it("round-trips forwardPoint under rotation, non-uniform scale and a manual centre", () => {
    const p = computePieces(hard, "none", IW, IH, IW, IH);
    for (const [sx, sy] of [[0, 0], [IW, 0], [IW, IH], [0, IH], [17, 83], [42.5, 11.25]]) {
      const o = forwardPoint(p, sx, sy);
      const back = inversePoint(p, o.x, o.y);
      expect(back.x).toBeCloseTo(sx, 6);
      expect(back.y).toBeCloseTo(sy, 6);
    }
  });

  it("round-trips through a reformat base too", () => {
    const p = computePieces(hard, "fill", 640, 480, IW, IH);
    const o = forwardPoint(p, 30, 70);
    const back = inversePoint(p, o.x, o.y);
    expect(back.x).toBeCloseTo(30, 6);
    expect(back.y).toBeCloseTo(70, 6);
  });
});

describe("the lever arm the scale handles solve against", () => {
  it("recovers the scale from a dragged corner", () => {
    // What CompModal's solveScale does: R^-1 (P - c) = (s - k) .* S.
    // Pin it here, where it is testable, because the handler itself needs a
    // canvas and a pointer.
    const t = tr({ centerAuto: false, centerX: 20, centerY: 30, scaleX: 2.5, scaleY: 1.25 });
    const p = computePieces(t, "none", IW, IH, IW, IH);
    const P = forwardPoint(p, IW, IH); // where the TR handle actually sits

    const [cos, sin] = p.rot;
    const dx0 = P.x - p.c[0], dy0 = P.y - p.c[1];
    const relX = cos * dx0 + sin * dy0;
    const relY = -sin * dx0 + cos * dy0;

    expect(relX / (IW - p.k[0])).toBeCloseTo(2.5, 6);
    expect(relY / (IH - p.k[1])).toBeCloseTo(1.25, 6);
  });

  it("has no lever arm when the pivot sits on the handle", () => {
    // Centre exactly on the TR corner: dragging that corner cannot define a
    // scale, and the handler must skip the axis instead of dividing by zero.
    const p = computePieces(
      tr({ centerAuto: false, centerX: IW, centerY: IH }), "none", IW, IH, IW, IH,
    );
    expect(IW - p.k[0]).toBe(0);
    expect(IH - p.k[1]).toBe(0);
  });
});
