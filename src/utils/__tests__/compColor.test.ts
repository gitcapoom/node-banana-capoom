import { describe, it, expect } from "vitest";
import { buildCompParams } from "../compComposite";
import { isCompColorIdentity } from "../colorChain";
import { compCommitSignature, type CompPins } from "../compSignature";
import { defaultCompData, defaultCompLayerColor, normalizeCompLayerColor, normalizeCompGrade } from "@/types/comp";
import type { CompNodeData } from "@/types";
import type { CompLayerColor } from "@/types/comp";

/**
 * In-comp colour correction — the parts that are actually assertable.
 *
 * jsdom has no WebGL, so neither the grade maths nor the pre-pass ordering can
 * be checked in pixels here. What CAN be pinned is everything either side of the
 * shader: that a legacy comp reaches the compositor with NO block at all (which
 * is what makes it free), that a partial block cannot arrive as NaN uniforms,
 * that the identity gate matches what the editor offers, and that leaving the
 * feature alone does not disturb the commit signature every saved comp holds.
 */

const pins = (): CompPins => ({
  bg: { srcId: "comp-9", token: "r:img-bg" },
  bgAlpha: { srcId: null, token: "-" },
  fg: { srcId: null, token: "-" },
  fgAlpha: { srcId: null, token: "-" },
  matte: { srcId: null, token: "-" },
});

const graded = (over: Partial<CompLayerColor> = {}): CompLayerColor => ({
  ...defaultCompLayerColor(),
  gradeEnabled: true,
  grade: { ...normalizeCompGrade(undefined), gain: { r: 2, g: 2, b: 2 } },
  ...over,
});

describe("normalizeCompLayerColor", () => {
  it("leaves an absent block ABSENT — it never manufactures one", () => {
    // The whole reason old comps stay byte-identical: nothing may turn "no
    // block" into "an identity block".
    expect(normalizeCompLayerColor(undefined)).toBeUndefined();
    expect(normalizeCompLayerColor(null)).toBeUndefined();
  });

  it("completes a partial block rather than letting undefined reach a uniform", () => {
    const c = normalizeCompLayerColor({ hsvEnabled: true, saturation: 1.4 })!;
    expect(c.saturation).toBe(1.4);
    expect(c.hueShift).toBe(0);
    expect(c.value).toBe(1);
    expect(c.gradeEnabled).toBe(false);
    expect(c.grade.gamma).toEqual({ r: 1, g: 1, b: 1 });
  });

  it("replaces non-finite values with the identity, per channel", () => {
    const c = normalizeCompLayerColor({
      hueShift: NaN,
      saturation: Infinity,
      grade: { gain: { r: NaN, g: 3 } } as never,
    })!;
    expect(c.hueShift).toBe(0);
    expect(c.saturation).toBe(1);
    // Only the bad component falls back — the good one survives.
    expect(c.grade.gain).toEqual({ r: 1, g: 3, b: 1 });
  });

  it("returns a fresh grade each time, so two comps cannot share channel objects", () => {
    const a = normalizeCompLayerColor({})!;
    const b = normalizeCompLayerColor({})!;
    expect(a.grade.gain).not.toBe(b.grade.gain);
  });
});

describe("isCompColorIdentity", () => {
  it("is identity for an absent block, and for one whose switches are off", () => {
    expect(isCompColorIdentity(undefined)).toBe(true);
    expect(isCompColorIdentity(null)).toBe(true);
    expect(isCompColorIdentity(defaultCompLayerColor())).toBe(true);
  });

  it("is identity for values that are set but not enabled — the A/B case", () => {
    // Unticking Grade must cost nothing at render time while KEEPING the numbers.
    expect(isCompColorIdentity({ ...graded(), gradeEnabled: false })).toBe(true);
  });

  it("is identity for a block enabled at identity values — no texture for nothing", () => {
    expect(isCompColorIdentity({ ...defaultCompLayerColor(), gradeEnabled: true, hsvEnabled: true })).toBe(true);
  });

  it("is NOT identity once an enabled block actually differs", () => {
    expect(isCompColorIdentity(graded())).toBe(false);
    expect(isCompColorIdentity({ ...defaultCompLayerColor(), hsvEnabled: true, hueShift: 30 })).toBe(false);
    expect(isCompColorIdentity({ ...defaultCompLayerColor(), hsvEnabled: true, saturation: 0 })).toBe(false);
  });

  it("does NOT treat a clamp toggle as a reason to run a pass", () => {
    // Matches what the editor offers: the clamps only appear once a block is on,
    // because with both off there is no pass for them to ride in.
    expect(isCompColorIdentity({ ...defaultCompLayerColor(), clampLow: true, clampHigh: true })).toBe(true);
  });
});

describe("buildCompParams — colour", () => {
  it("hands the compositor nothing for a comp saved before the feature existed", () => {
    const data = defaultCompData() as CompNodeData;
    expect(data.bgColor).toBeUndefined(); // absent by default, on purpose
    expect(data.fgColor).toBeUndefined();
    const p = buildCompParams(data);
    expect(p.bgColor).toBeUndefined();
    expect(p.fgColor).toBeUndefined();
  });

  it("completes a partial block on the way through, per layer", () => {
    const data = { ...defaultCompData(), fgColor: { hsvEnabled: true, hueShift: 90 } } as unknown as CompNodeData;
    const p = buildCompParams(data);
    expect(p.bgColor).toBeUndefined();
    expect(p.fgColor).toMatchObject({ hsvEnabled: true, hueShift: 90, saturation: 1, value: 1 });
    expect(p.fgColor!.grade.whitepoint).toEqual({ r: 1, g: 1, b: 1 });
  });

  it("keeps BG and FG independent", () => {
    const data = {
      ...defaultCompData(),
      bgColor: graded(),
      fgColor: { ...defaultCompLayerColor(), hsvEnabled: true, saturation: 0 },
    } as unknown as CompNodeData;
    const p = buildCompParams(data);
    expect(p.bgColor!.grade.gain.r).toBe(2);
    expect(p.fgColor!.grade.gain.r).toBe(1);
    expect(p.fgColor!.saturation).toBe(0);
    expect(p.bgColor!.saturation).toBe(1);
  });
});

describe("commit signature", () => {
  const DATA = { mergeOp: "over", bgOpacity: 1, fgOpacity: 1 };

  it("is untouched for a comp carrying no colour block", () => {
    // The pinned literal in compSignature.test.ts is the primary guard; this
    // states the same requirement from the colour feature's side, so a future
    // edit here fails next to the code that caused it.
    expect(compCommitSignature(DATA, pins())).not.toContain("bgC");
    expect(compCommitSignature(DATA, pins())).not.toContain("fgC");
  });

  it("participates once a layer actually has one", () => {
    expect(compCommitSignature({ ...DATA, bgColor: graded() }, pins()))
      .not.toBe(compCommitSignature(DATA, pins()));
  });

  it("distinguishes the BG's block from the FG's", () => {
    expect(compCommitSignature({ ...DATA, bgColor: graded() }, pins()))
      .not.toBe(compCommitSignature({ ...DATA, fgColor: graded() }, pins()));
  });

  it("changes when a block is switched off but its values are kept", () => {
    // The render is identical either way (isCompColorIdentity says so above), but
    // the stored parameters differ, and the signature answers "do my parameters
    // match what I committed?" — not "would the pixels differ?".
    expect(compCommitSignature({ ...DATA, bgColor: graded() }, pins()))
      .not.toBe(compCommitSignature({ ...DATA, bgColor: { ...graded(), gradeEnabled: false } }, pins()));
  });

  it("changes when a clamp is toggled", () => {
    expect(compCommitSignature({ ...DATA, bgColor: graded() }, pins()))
      .not.toBe(compCommitSignature({ ...DATA, bgColor: graded({ clampHigh: true }) }, pins()));
  });
});
