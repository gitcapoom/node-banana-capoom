import { describe, it, expect } from "vitest";
import { compPinToken, compCommitSignature, outputRefField, __OUTPUT_REF_FIELD, type CompPins } from "../compSignature";
import { RUN_FULLRES_FIELDS } from "../imageFieldMap";
import type { WorkflowNode } from "@/types";

const node = (type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id: `${type}-1`, type, position: { x: 0, y: 0 }, data } as unknown as WorkflowNode);

const pins = (over: Partial<CompPins> = {}): CompPins => ({
  bg: { srcId: null, node: null, value: null },
  bgAlpha: { srcId: null, node: null, value: null },
  fg: { srcId: null, node: null, value: null },
  fgAlpha: { srcId: null, node: null, value: null },
  matte: { srcId: null, node: null, value: null },
  ...over,
});

const DATA = { mergeOp: "over", bgOpacity: 1, fgOpacity: 1 };

describe("compPinToken", () => {
  it("prefers the ref, so the token is identical before and after hydration", () => {
    const unloaded = node("comp", { outputImageRef: "img-abc", outputImage: null });
    const hydrated = node("comp", { outputImageRef: "img-abc", outputImage: "data:image/png;base64,AAAA" });
    expect(compPinToken(unloaded, null)).toBe("r:img-abc");
    expect(compPinToken(hydrated, "data:image/png;base64,AAAA")).toBe("r:img-abc");
  });

  it("falls back to a URL token for pixels that were never saved", () => {
    const fresh = node("comp", { outputImage: "data:image/png;base64,ZZZZ" });
    expect(compPinToken(fresh, "data:image/png;base64,ZZZZ")).toMatch(/^u:/);
  });

  it("changes when a genuine recompute clears the ref", () => {
    const before = compPinToken(node("comp", { outputImageRef: "img-abc" }), null);
    const after = compPinToken(node("comp", { outputImage: "data:image/png;base64,NEW" }), "data:image/png;base64,NEW");
    expect(before).not.toBe(after);
  });

  it("is '-' for a disconnected pin", () => {
    expect(compPinToken(null, null)).toBe("-");
  });

  it("follows the flip mirror on imageInput, like getSourceOutput does", () => {
    const plain = node("imageInput", { imageRef: "img-plain", outputImageRef: "img-flipped" });
    const flipped = node("imageInput", { imageRef: "img-plain", outputImageRef: "img-flipped", flipHorizontal: true });
    expect(outputRefField(plain)).toBe("img-plain");
    expect(outputRefField(flipped)).toBe("img-flipped");
  });

  it("uses outputMaskRef for roto and maskPainter", () => {
    expect(outputRefField(node("roto", { outputMaskRef: "img-matte" }))).toBe("img-matte");
    expect(outputRefField(node("maskPainter", { outputMaskRef: "img-mask" }))).toBe("img-mask");
  });
});

describe("compCommitSignature", () => {
  const bgUnloaded = { srcId: "comp-9", node: node("comp", { outputImageRef: "img-bg", outputImage: null }), value: null };
  const bgHydrated = { srcId: "comp-9", node: node("comp", { outputImageRef: "img-bg", outputImage: "data:x" }), value: "data:x" };

  it("survives the load boundary — identical before and after hydration", () => {
    expect(compCommitSignature(DATA, pins({ bg: bgUnloaded })))
      .toBe(compCommitSignature(DATA, pins({ bg: bgHydrated })));
  });

  it("differs when a parameter changes", () => {
    expect(compCommitSignature(DATA, pins({ bg: bgUnloaded })))
      .not.toBe(compCommitSignature({ ...DATA, mergeOp: "add" }, pins({ bg: bgUnloaded })));
  });

  it("differs when the pin is rewired to a different node with the same pixels", () => {
    const other = { srcId: "comp-77", node: node("comp", { outputImageRef: "img-bg" }), value: null };
    expect(compCommitSignature(DATA, pins({ bg: bgUnloaded })))
      .not.toBe(compCommitSignature(DATA, pins({ bg: other })));
  });

  it("differs when a pin is disconnected", () => {
    expect(compCommitSignature(DATA, pins({ bg: bgUnloaded })))
      .not.toBe(compCommitSignature(DATA, pins()));
  });

  it("differs when the upstream ref changes (new pixels)", () => {
    const changed = { srcId: "comp-9", node: node("comp", { outputImageRef: "img-DIFFERENT" }), value: null };
    expect(compCommitSignature(DATA, pins({ bg: bgUnloaded })))
      .not.toBe(compCommitSignature(DATA, pins({ bg: changed })));
  });

  it("differs when a resample filter changes", () => {
    expect(compCommitSignature({ ...DATA, fgResample: "keys" }, pins({ bg: bgUnloaded })))
      .not.toBe(compCommitSignature({ ...DATA, fgResample: "mitchell" }, pins({ bg: bgUnloaded })));
  });
});

describe("drift guard", () => {
  /**
   * Every node type the run pre-pass knows how to reload full-res for is a node
   * type that can feed a comp. If one gains a ref field here without an entry in
   * OUTPUT_REF_FIELD, its pin silently degrades to a URL token and the comp
   * re-composites on every open. Fail loudly instead.
   */
  it("every RUN_FULLRES_FIELDS type with an output ref has a token mapping", () => {
    const missing: string[] = [];
    for (const [type, fields] of Object.entries(RUN_FULLRES_FIELDS)) {
      if (!fields?.some((f) => f.ref === "outputImageRef" || f.ref === "outputMaskRef")) continue;
      if (!(type in __OUTPUT_REF_FIELD)) missing.push(type);
    }
    expect(missing).toEqual([]);
  });
});
