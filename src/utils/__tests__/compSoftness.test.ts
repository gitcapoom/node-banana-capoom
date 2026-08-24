import { describe, it, expect } from "vitest";
import { buildCompParams } from "../compComposite";
import { compCommitSignature, type CompPins } from "../compSignature";
import { defaultCompData } from "@/types/comp";
import type { CompNodeData } from "@/types";

/**
 * FG edge softness — the parts that are actually assertable.
 *
 * jsdom has no WebGL, so the ramp itself (and the double-coverage fix that goes
 * with it) cannot be checked in pixels here; what CAN be pinned is the handover
 * — that a legacy comp reaches the shader with the knob OFF, that the knob
 * cannot arrive negative, and that leaving it alone does not disturb the commit
 * signature every saved comp is holding.
 */

const pins = (): CompPins => ({
  bg: { srcId: "comp-9", token: "r:img-bg" },
  bgAlpha: { srcId: null, token: "-" },
  fg: { srcId: null, token: "-" },
  fgAlpha: { srcId: null, token: "-" },
  matte: { srcId: null, token: "-" },
});

describe("buildCompParams — FG softness", () => {
  it("hands the shader 0 for a comp saved before the knob existed", () => {
    const data = defaultCompData() as CompNodeData;
    expect(data.fgSoftness).toBeUndefined(); // absent by default, on purpose
    expect(buildCompParams(data).fgSoftness).toBe(0);
  });

  it("passes a set value straight through, in output px", () => {
    const data = { ...defaultCompData(), fgSoftness: 24 } as CompNodeData;
    expect(buildCompParams(data).fgSoftness).toBe(24);
  });

  it("never lets a negative reach the shader (it would invert the ramp)", () => {
    const data = { ...defaultCompData(), fgSoftness: -8 } as CompNodeData;
    expect(buildCompParams(data).fgSoftness).toBe(0);
  });
});

describe("compCommitSignature — FG softness", () => {
  const DATA = { mergeOp: "over", bgOpacity: 1, fgOpacity: 1 };

  /**
   * The same guard the align fields carry: absent must stay absent, or every
   * comp in every saved workflow re-composites on next open.
   */
  it("does not serialize for a comp that never touched it", () => {
    expect(compCommitSignature(DATA, pins())).toBe(
      '{"v":1,"bg":"comp-9#r:img-bg","ba":"-#-","fg":"-#-","fa":"-#-","mt":"-#-","op":"over","bo":[null,null],"bgo":1,"fgo":1}',
    );
  });

  it("distinguishes 0 from absent — so nothing may default it on the way in", () => {
    expect(compCommitSignature({ ...DATA, fgSoftness: 0 }, pins()))
      .not.toBe(compCommitSignature(DATA, pins()));
  });

  it("invalidates when the knob moves", () => {
    expect(compCommitSignature({ ...DATA, fgSoftness: 12 }, pins()))
      .not.toBe(compCommitSignature({ ...DATA, fgSoftness: 24 }, pins()));
  });
});
