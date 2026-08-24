import { describe, it, expect } from "vitest";
import { compPinToken, compCommitSignature, normalizeAlignMeta, outputRefField, __OUTPUT_REF_FIELD, type CompPins } from "../compSignature";
import { RUN_FULLRES_FIELDS } from "../imageFieldMap";
import type { WorkflowNode } from "@/types";

const node = (type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id: `${type}-1`, type, position: { x: 0, y: 0 }, data } as unknown as WorkflowNode);

const pins = (over: Partial<CompPins> = {}): CompPins => ({
  bg: { srcId: null, token: "-" },
  bgAlpha: { srcId: null, token: compPinToken(null, null) },
  fg: { srcId: null, token: compPinToken(null, null) },
  fgAlpha: { srcId: null, token: compPinToken(null, null) },
  matte: { srcId: null, token: compPinToken(null, null) },
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
  const bgUnloaded = { srcId: "comp-9", token: compPinToken(node("comp", { outputImageRef: "img-bg", outputImage: null }), null) };
  const bgHydrated = { srcId: "comp-9", token: compPinToken(node("comp", { outputImageRef: "img-bg", outputImage: "data:x" }), "data:x") };

  it("survives the load boundary — identical before and after hydration", () => {
    expect(compCommitSignature(DATA, pins({ bg: bgUnloaded })))
      .toBe(compCommitSignature(DATA, pins({ bg: bgHydrated })));
  });

  it("differs when a parameter changes", () => {
    expect(compCommitSignature(DATA, pins({ bg: bgUnloaded })))
      .not.toBe(compCommitSignature({ ...DATA, mergeOp: "add" }, pins({ bg: bgUnloaded })));
  });

  it("differs when the pin is rewired to a different node with the same pixels", () => {
    const other = { srcId: "comp-77", token: compPinToken(node("comp", { outputImageRef: "img-bg" }), null) };
    expect(compCommitSignature(DATA, pins({ bg: bgUnloaded })))
      .not.toBe(compCommitSignature(DATA, pins({ bg: other })));
  });

  it("differs when a pin is disconnected", () => {
    expect(compCommitSignature(DATA, pins({ bg: bgUnloaded })))
      .not.toBe(compCommitSignature(DATA, pins()));
  });

  it("differs when the upstream ref changes (new pixels)", () => {
    const changed = { srcId: "comp-9", token: compPinToken(node("comp", { outputImageRef: "img-DIFFERENT" }), null) };
    expect(compCommitSignature(DATA, pins({ bg: bgUnloaded })))
      .not.toBe(compCommitSignature(DATA, pins({ bg: changed })));
  });

  it("differs when a resample filter changes", () => {
    expect(compCommitSignature({ ...DATA, fgResample: "keys" }, pins({ bg: bgUnloaded })))
      .not.toBe(compCommitSignature({ ...DATA, fgResample: "mitchell" }, pins({ bg: bgUnloaded })));
  });
});

describe("FG align fields", () => {
  const bg = { srcId: "comp-9", token: "r:img-bg" };
  const META = '{"v":1,"crop":{"x":100,"y":50,"width":400,"height":300}}';

  /**
   * THE GUARD ON EVERY COMP ALREADY ON DISK.
   *
   * All three fgAlign* fields are undefined in a comp saved before the align pin
   * existed, JSON.stringify omits undefined keys, and the string below is what
   * such a comp was saved with. If this literal ever has to be updated, the edit
   * that changed it also invalidated every comp in every saved workflow — each
   * one silently recomposites (1.0-1.8s apiece) the next time the file is opened.
   * Adding fields to compCommitSignature is fine; making them SERIALIZE for a
   * comp that never had them is not.
   */
  it("a comp carrying none of the new fields signs byte-identically to the pinned literal", () => {
    expect(compCommitSignature(DATA, pins({ bg }))).toBe(
      '{"v":1,"bg":"comp-9#r:img-bg","ba":"-#-","fg":"-#-","fa":"-#-","mt":"-#-","op":"over","bo":[null,null],"bgo":1,"fgo":1}',
    );
  });

  it("participates once the pin actually carries metadata", () => {
    expect(compCommitSignature({ ...DATA, fgAlignMeta: META }, pins({ bg })))
      .not.toBe(compCommitSignature(DATA, pins({ bg })));
  });

  it("distinguishes absent from null — they do not serialize the same", () => {
    // Which is exactly why normalizeAlignMeta exists: nothing may write null
    // over the absent field of an old comp.
    expect(compCommitSignature({ ...DATA, fgAlignMeta: null }, pins({ bg })))
      .not.toBe(compCommitSignature(DATA, pins({ bg })));
  });

  it("differs when align is switched off, or the fit mode changes", () => {
    const on = compCommitSignature({ ...DATA, fgAlignMeta: META, fgAlign: "auto", fgAlignFit: "fit" }, pins({ bg }));
    expect(on).not.toBe(compCommitSignature({ ...DATA, fgAlignMeta: META, fgAlign: "off", fgAlignFit: "fit" }, pins({ bg })));
    expect(on).not.toBe(compCommitSignature({ ...DATA, fgAlignMeta: META, fgAlign: "auto", fgAlignFit: "fill" }, pins({ bg })));
  });
});

describe("normalizeAlignMeta", () => {
  it("leaves an absent field absent when the pin carries nothing", () => {
    expect(normalizeAlignMeta(undefined, null)).toBeUndefined();
  });

  it("leaves an explicit null alone", () => {
    expect(normalizeAlignMeta(null, null)).toBeNull();
  });

  it("returns the SAME value when nothing changed, so no store write is triggered", () => {
    expect(normalizeAlignMeta('{"v":1}', '{"v":1}')).toBe('{"v":1}');
  });

  it("takes the incoming value whenever it genuinely differs", () => {
    expect(normalizeAlignMeta(undefined, '{"v":1}')).toBe('{"v":1}');
    expect(normalizeAlignMeta('{"v":1}', null)).toBeNull();
    expect(normalizeAlignMeta('{"v":1}', '{"v":2}')).toBe('{"v":2}');
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

describe("one serializer, or the persisted signature never matches", () => {
  /**
   * The bug this pins: CompNode used to build its own JSON.stringify of the same
   * facts while the save path used compCommitSignature. Two different
   * serialisations meant `nodeData.compCommitSig === sig` could never be true, so
   * every comp re-composited on every open — the guard looked correct and did
   * nothing. Any call site that stops going through compCommitSignature
   * reintroduces it.
   */
  const src = node("comp", { outputImageRef: "img-bg", outputImage: null });
  const data = { mergeOp: "over", bgOpacity: 1, fgOpacity: 1, fgResample: "keys" };

  it("produces the same string whether the token was precomputed or derived", () => {
    // Component path: token already in hand from the store selector.
    const fromComponent = compCommitSignature(data, pins({
      bg: { srcId: "comp-9", token: "r:img-bg" },
    }));
    // Save / executor path: token derived from the node.
    const fromSave = compCommitSignature(data, pins({
      bg: { srcId: "comp-9", token: compPinToken(src, null) },
    }));
    expect(fromComponent).toBe(fromSave);
  });

  it("is deterministic across repeated calls with equal input", () => {
    const a = compCommitSignature(data, pins({ bg: { srcId: "comp-9", token: "r:img-bg" } }));
    const b = compCommitSignature({ ...data }, pins({ bg: { srcId: "comp-9", token: "r:img-bg" } }));
    expect(a).toBe(b);
  });
});
