import { describe, it, expect } from "vitest";
import {
  deriveAlignBase,
  alignRectInOutput,
  computeAlignedPieces,
  computeFollowPieces,
  forwardCorners,
  forwardPoint,
  type CompAlignBase,
  type CompAlignFit,
} from "@/utils/compTransform";
import { defaultCompTransform, type CompTransform } from "@/types/comp";

/**
 * Auto-align exists so a generated patch drops back onto the exact region it was
 * cropped from, at whatever resolution the generator felt like returning. The
 * only trustworthy assertion of that is where the FG's four corners actually
 * LAND, so every test here goes through forwardCorners/forwardPoint rather than
 * inspecting the base's numbers — a sign or pivot error survives the latter.
 */

// --- fixtures -------------------------------------------------------------
// Deliberately ASYMMETRIC vertically: crop.y (90) ≠ srcH - y - h (510). A flipped
// or missing Y flip is invisible on a vertically centred crop.
const SRC_W = 1000;
const SRC_H = 800;
const CROP = { x: 120, y: 90, width: 300, height: 200 };   // integers, as drawImage got them
const REGION = { x: 0.12, y: 0.1125, width: 0.3, height: 0.25 };

// The same rect in comp space (bottom-left origin, output px) when BG === source.
const RECT = { left: 120, right: 420, bottom: 510, top: 710 };

function base(over: Partial<Parameters<typeof deriveAlignBase>[0]> = {}): CompAlignBase | null {
  return deriveAlignBase({
    crop: CROP, region: REGION,
    srcW: SRC_W, srcH: SRC_H,
    fgW: CROP.width, fgH: CROP.height,
    outW: SRC_W, outH: SRC_H,
    fit: "stretch",
    ...over,
  });
}

function tf(over: Partial<CompTransform> = {}): CompTransform {
  return { ...defaultCompTransform(true), ...over };
}

/** Axis-aligned bounds of the placed FG, in output px. */
function boundsOf(b: CompAlignBase, fgW: number, fgH: number, tr = tf()) {
  const corners = forwardCorners(computeAlignedPieces(tr, b, fgW, fgH));
  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);
  return {
    left: Math.min(...xs), right: Math.max(...xs),
    bottom: Math.min(...ys), top: Math.max(...ys),
  };
}

function expectBounds(
  got: { left: number; right: number; bottom: number; top: number },
  want: { left: number; right: number; bottom: number; top: number },
) {
  expect(got.left).toBeCloseTo(want.left, 9);
  expect(got.right).toBeCloseTo(want.right, 9);
  expect(got.bottom).toBeCloseTo(want.bottom, 9);
  expect(got.top).toBeCloseTo(want.top, 9);
}

// --- 1-2: the generator's output resolution must not matter ---------------
describe("deriveAlignBase — resolution independence", () => {
  it("lands the FG exactly on the crop rect when it comes back the same size", () => {
    const b = base()!;
    expect(b).not.toBeNull();
    expectBounds(boundsOf(b, CROP.width, CROP.height), RECT);
  });

  it("lands on the same rect whether the generator returned 2× or 0.5×", () => {
    for (const [fgW, fgH] of [[600, 400], [150, 100]]) {
      const b = base({ fgW, fgH })!;
      expectBounds(boundsOf(b, fgW, fgH), RECT);
    }
  });

  it("scales the base rather than moving it when the FG resolution changes", () => {
    // 2× pixels ⇒ half the scale; the origin is a property of the crop alone.
    const big = base({ fgW: 600, fgH: 400 })!;
    const small = base({ fgW: 150, fgH: 100 })!;
    expect(big.sX).toBeCloseTo(0.5, 9);
    expect(small.sX).toBeCloseTo(2, 9);
    expect(big.hPos).toBe(small.hPos);
    expect(big.vPos).toBe(small.vPos);
  });
});

// --- 3: aspect mismatch ---------------------------------------------------
describe("deriveAlignBase — aspect mismatch fit modes", () => {
  // A 300×200 rect asked for; a square 200×200 came back.
  const FG = 200;
  const modes: CompAlignFit[] = ["stretch", "fit", "fill"];

  it("stretch fills the crop rect exactly, distorting the patch", () => {
    const b = base({ fgW: FG, fgH: FG, fit: "stretch" })!;
    expectBounds(boundsOf(b, FG, FG), RECT);
    expect(b.sX).not.toBeCloseTo(b.sY, 9); // it is the non-uniform mode
  });

  it("fit stays inside the rect, uniformly scaled and centred", () => {
    const b = base({ fgW: FG, fgH: FG, fit: "fit" })!;
    expect(b.sX).toBe(b.sY); // uniform, not merely close
    const got = boundsOf(b, FG, FG);
    expect(got.left).toBeGreaterThanOrEqual(RECT.left);
    expect(got.right).toBeLessThanOrEqual(RECT.right);
    expect(got.bottom).toBeGreaterThanOrEqual(RECT.bottom);
    expect(got.top).toBeLessThanOrEqual(RECT.top);
    // Centred on both axes: equal slack on either side.
    expect(got.left - RECT.left).toBeCloseTo(RECT.right - got.right, 9);
    expect(got.bottom - RECT.bottom).toBeCloseTo(RECT.top - got.top, 9);
  });

  it("fill covers the rect, uniformly scaled and centred", () => {
    const b = base({ fgW: FG, fgH: FG, fit: "fill" })!;
    expect(b.sX).toBe(b.sY);
    const got = boundsOf(b, FG, FG);
    expect(got.left).toBeLessThanOrEqual(RECT.left);
    expect(got.right).toBeGreaterThanOrEqual(RECT.right);
    expect(got.bottom).toBeLessThanOrEqual(RECT.bottom);
    expect(got.top).toBeGreaterThanOrEqual(RECT.top);
    expect(RECT.left - got.left).toBeCloseTo(got.right - RECT.right, 9);
    expect(RECT.bottom - got.bottom).toBeCloseTo(got.top - RECT.top, 9);
  });

  it("keeps the rect's centre under every fit mode", () => {
    for (const fit of modes) {
      const b = base({ fgW: FG, fgH: FG, fit })!;
      const got = boundsOf(b, FG, FG);
      expect((got.left + got.right) / 2).toBeCloseTo((RECT.left + RECT.right) / 2, 9);
      expect((got.bottom + got.top) / 2).toBeCloseTo((RECT.bottom + RECT.top) / 2, 9);
    }
  });
});

// --- 4-5: which BGs the crop may be aligned against -----------------------
describe("deriveAlignBase — BG identification", () => {
  it("rescales onto a proxy BG at half the source resolution", () => {
    const b = base({ outW: SRC_W / 2, outH: SRC_H / 2, fgW: 300, fgH: 200 })!;
    expect(b).not.toBeNull();
    expectBounds(boundsOf(b, 300, 200), {
      left: RECT.left / 2, right: RECT.right / 2,
      bottom: RECT.bottom / 2, top: RECT.top / 2,
    });
  });

  it("accepts a resolution change inside the 0.5% aspect tolerance", () => {
    // 1002×800 is 1.25250 vs the source's 1.25 — rounding-grade, same picture.
    expect(base({ outW: 1002, outH: 800 })).not.toBeNull();
  });

  it("returns null for a BG of a different aspect", () => {
    // Square BG: not this crop's source, and there is no honest guess to make.
    expect(base({ outW: 1000, outH: 1000 })).toBeNull();
    expect(base({ outW: 800, outH: 1000 })).toBeNull();
  });

  it("returns null on degenerate sizes rather than dividing by zero", () => {
    expect(base({ fgW: 0 })).toBeNull();
    expect(base({ srcH: 0 })).toBeNull();
    expect(base({ crop: { x: 0, y: 0, width: 0, height: 200 } })).toBeNull();
  });

  it("uses the crop integers, not region×srcW, when BG is the source", () => {
    // cropImageToDataUrl rounds origin and extent independently, so the real
    // sample rect can disagree with a recomputed one. The metadata's integers win.
    const b = deriveAlignBase({
      crop: { x: 121, y: 90, width: 300, height: 200 }, // what drawImage really got
      region: { x: 0.1205, y: 0.1125, width: 0.2996, height: 0.25 },
      srcW: SRC_W, srcH: SRC_H, fgW: 300, fgH: 200, outW: SRC_W, outH: SRC_H,
      fit: "stretch",
    })!;
    expect(b.hPos).toBe(121);
    expect(b.sX).toBe(1);
  });
});

// --- alignRectInOutput: the rect the editor reads back -------------------
describe("alignRectInOutput — the same rect the placement is built from", () => {
  const SPEC = { crop: CROP, region: REGION, srcW: SRC_W, srcH: SRC_H, fit: "stretch" as CompAlignFit };

  it("reports the crop rect in comp space (bottom-left origin)", () => {
    expect(alignRectInOutput(SPEC, SRC_W, SRC_H)).toEqual({
      x: RECT.left, y: RECT.bottom, w: RECT.right - RECT.left, h: RECT.top - RECT.bottom,
    });
  });

  it("is the rect deriveAlignBase actually places into", () => {
    // An FG that came back at exactly the rect's size must land ON the rect
    // under stretch — which is only true if both read the same rect.
    const r = alignRectInOutput(SPEC, SRC_W, SRC_H)!;
    const b = base({ fgW: r.w, fgH: r.h })!;
    expect(b.hPos).toBe(r.x);
    expect(b.vPos).toBe(r.y);
    expect(b.sX).toBeCloseTo(1, 9);
    expect(b.sY).toBeCloseTo(1, 9);
  });

  it("returns null for the same BGs deriveAlignBase refuses", () => {
    expect(alignRectInOutput(SPEC, 1000, 1000)).toBeNull();
    expect(alignRectInOutput({ ...SPEC, srcH: 0 }, SRC_W, SRC_H)).toBeNull();
    expect(alignRectInOutput(SPEC, 0, SRC_H)).toBeNull();
  });
});

// --- 6: the user's transform stays a delta on top ------------------------
describe("computeAlignedPieces — user transform composes on top", () => {
  it("treats the user's H/V/Scale as a pure delta over the base", () => {
    const b = base()!;
    const user = tf({ hPos: 25, vPos: -40, scaleX: 2, scaleY: 2 });
    const p = computeAlignedPieces(user, b, CROP.width, CROP.height);
    expect(p.sX).toBeCloseTo(2, 9); // base 1 × user 2
    expect(p.sY).toBeCloseTo(2, 9);
    // Scale pivots about the CENTRE, so the placed rect grows symmetrically
    // about it rather than out of its bottom-left corner. H/V are still a pure
    // delta: they move the centre, and the corners follow.
    // centre = base + user translate + half the crop (300x200 -> 150,100).
    const cx = RECT.left + 25 + 150;
    const cy = RECT.bottom - 40 + 100;
    const bl = forwardPoint(p, 0, 0);
    expect(bl.x).toBeCloseTo(cx - 300, 9); // half-width 150 x scale 2
    expect(bl.y).toBeCloseTo(cy - 200, 9);
    const tr = forwardPoint(p, CROP.width, CROP.height);
    expect(tr.x).toBeCloseTo(cx + 300, 9);
    expect(tr.y).toBeCloseTo(cy + 200, 9);
  });

  it("multiplies the user scale into the base instead of replacing it", () => {
    // FG came back at half size (base sX = 2); the user then doubles it.
    const b = base({ fgW: 150, fgH: 100 })!;
    const p = computeAlignedPieces(tf({ scaleX: 2, scaleY: 2 }), b, 150, 100);
    expect(p.sX).toBeCloseTo(4, 9);
    // 150 px of source at total scale 4 = 600 px wide, centred on the base
    // rect's centre (RECT.left + 150), so its right edge is at +300 from there.
    expect(forwardPoint(p, 150, 100).x).toBeCloseTo(RECT.left + 150 + 300, 9);
  });

  it("leaves an identity user transform sitting exactly on the base", () => {
    const b = base({ fgW: 150, fgH: 100 })!;
    expectBounds(boundsOf(b, 150, 100, tf()), RECT);
  });

  it("pivots against the TOTAL scale, not the user scale alone", () => {
    // 180° about the auto centre must map the placed rect onto itself. If the
    // pivot were derived without the base scale, the rect would drift instead.
    const b = base({ fgW: 150, fgH: 100 })!; // base sX/sY = 2
    expectBounds(boundsOf(b, 150, 100, tf({ rotation: 180 })), RECT);
  });
});

// --- 7: the Y flip, stated on its own ------------------------------------
describe("deriveAlignBase — the top-left → bottom-left Y flip", () => {
  it("places vPos at srcH - (crop.y + crop.height), not at crop.y", () => {
    const b = base()!;
    expect(b.vPos).toBe(SRC_H - (CROP.y + CROP.height)); // 510
    expect(b.vPos).not.toBe(CROP.y);                     // 90 — the sign error
  });

  it("mirrors vertically when the crop mirrors vertically", () => {
    const low = base({ crop: { ...CROP, y: SRC_H - CROP.y - CROP.height } })!; // y = 510
    expect(low.vPos).toBe(CROP.y); // 90 — the pair swaps, so the axis really inverts
  });

  it("puts a crop taken at the top of the image at the top of comp space", () => {
    const b = base({ crop: { x: 0, y: 0, width: 300, height: 200 }, fgW: 300, fgH: 200 })!;
    const got = boundsOf(b, 300, 200);
    expect(got.top).toBe(SRC_H);           // flush with the top of the frame
    expect(got.bottom).toBe(SRC_H - 200);
  });

  it("puts a crop taken at the bottom of the image on the vPos=0 line", () => {
    const b = base({ crop: { x: 0, y: SRC_H - 200, width: 300, height: 200 }, fgW: 300, fgH: 200 })!;
    expect(b.vPos).toBe(0);
  });
});

// --- FG_Alpha inheritance ------------------------------------------------
describe("computeFollowPieces — a followed FG_Alpha inherits the aligned placement", () => {
  it("lands the mask exactly where the aligned FG lands", () => {
    const b = base({ fgW: 150, fgH: 100 })!;
    const user = tf({ hPos: 25, vPos: -40, scaleX: 2, scaleY: 2 });
    const fgBounds = boundsOf(b, 150, 100, user);
    const fa = forwardCorners(computeFollowPieces(user, 150, 100, "none", 150, 100, b));
    expectBounds(
      {
        left: Math.min(...fa.map(c => c.x)), right: Math.max(...fa.map(c => c.x)),
        bottom: Math.min(...fa.map(c => c.y)), top: Math.max(...fa.map(c => c.y)),
      },
      fgBounds,
    );
  });

  it("still lands there when the mask is a different size and reformats to FG", () => {
    const b = base({ fgW: 150, fgH: 100 })!;
    const fa = forwardCorners(computeFollowPieces(tf(), 150, 100, "fill", 600, 400, b));
    expectBounds(
      {
        left: Math.min(...fa.map(c => c.x)), right: Math.max(...fa.map(c => c.x)),
        bottom: Math.min(...fa.map(c => c.y)), top: Math.max(...fa.map(c => c.y)),
      },
      RECT,
    );
  });

  it("is unchanged when no base is passed (un-aligned comps keep working)", () => {
    const user = tf({ hPos: 25, vPos: -40, scaleX: 2, scaleY: 2 });
    const withoutBase = computeFollowPieces(user, 150, 100, "fill", 600, 400);
    const identity = computeFollowPieces(user, 150, 100, "fill", 600, 400, { sX: 1, sY: 1, hPos: 0, vPos: 0 });
    expect(withoutBase).toEqual(identity);
    // The point of this test is the equality above — that omitting the base is
    // the same as passing an identity one. The corner below just pins the
    // concrete placement: FA reformats 600x400 onto FG's 150x100 (0.25), the
    // user doubles it (total 0.5), and it pivots about FG's centre at
    // (75+25, 50-40) = (100, 10), putting FA's origin 150/100 px away.
    expect(forwardPoint(withoutBase, 0, 0).x).toBeCloseTo(100 - 150, 9);
    expect(forwardPoint(withoutBase, 0, 0).y).toBeCloseTo(10 - 100, 9);
  });
});
