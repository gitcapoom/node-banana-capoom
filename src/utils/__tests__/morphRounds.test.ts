/**
 * The Dilate node reaches sizes larger than one GPU pass by repeating the pass.
 *
 * That is only EXACT — rather than an approximation — because the per-round
 * extents sum to the requested size: for a flat structuring element,
 * dilate(a) then dilate(b) == dilate(a+b). If the split ever stopped summing,
 * a 40px dilate would quietly grow by some other amount, which is the kind of
 * thing you would never spot by eye on a soft matte.
 *
 * The alternative — one pass sampling sparsely over a wide radius, as the blur
 * passes do — is wrong here: a max over scattered taps leaves gaps between them
 * and shreds an edge instead of growing it.
 */

import { describe, it, expect } from "vitest";
import { morphRounds, MORPH_MAX_TAP } from "../colorChain";

describe("morphRounds", () => {
  it("does nothing below half a pixel", () => {
    expect(morphRounds(0)).toEqual([]);
    expect(morphRounds(0.4)).toEqual([]);
    expect(morphRounds(-0.4)).toEqual([]);
  });

  it("uses a single round up to one pass's reach", () => {
    expect(morphRounds(1)).toEqual([1]);
    expect(morphRounds(MORPH_MAX_TAP)).toEqual([MORPH_MAX_TAP]);
  });

  it("splits a larger size into full rounds plus the remainder", () => {
    expect(morphRounds(MORPH_MAX_TAP + 1)).toEqual([MORPH_MAX_TAP, 1]);
    expect(morphRounds(40)).toEqual([16, 16, 8]);
  });

  it("always sums to the requested size — the property that makes it exact", () => {
    for (let n = 0; n <= 200; n++) {
      const sum = morphRounds(n).reduce((a, b) => a + b, 0);
      expect(sum, `size ${n}`).toBe(n);
    }
  });

  it("treats erode as the mirror of dilate", () => {
    // The sign selects min vs max in the shader; the pass schedule is the same.
    for (const n of [1, 7, 16, 33, 100]) {
      expect(morphRounds(-n)).toEqual(morphRounds(n));
    }
  });

  it("never asks a pass for more taps than the shader has", () => {
    for (const n of [17, 40, 99, 1000]) {
      for (const step of morphRounds(n)) {
        expect(step).toBeGreaterThan(0);
        expect(step).toBeLessThanOrEqual(MORPH_MAX_TAP);
      }
    }
  });

  it("rounds a fractional size to whole pixels", () => {
    expect(morphRounds(2.4)).toEqual([2]);
    expect(morphRounds(2.6)).toEqual([3]);
  });
});
