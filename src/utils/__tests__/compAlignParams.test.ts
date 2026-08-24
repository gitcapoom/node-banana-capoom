import { describe, it, expect } from "vitest";
import { buildCompParams, resolveFgAlign } from "../compComposite";
import { serializeCropMetadata, buildCropMetadata } from "../cropMetadata";
import { defaultCompData } from "@/types/comp";
import type { CompNodeData } from "@/types";

/**
 * The align pin's journey through `buildCompParams`. jsdom has no WebGL, so
 * where the pixels land is asserted in compAlign.test.ts against the pure math;
 * what is testable HERE is the handover — that a legacy comp gets the agreed
 * defaults, that a hostile pin yields NO alignment rather than a half-built one,
 * and that the two ways of switching it off both do.
 */

const META = serializeCropMetadata(
  buildCropMetadata(
    { dataUrl: "", srcW: 1000, srcH: 800, sx: 120, sy: 90, sw: 300, sh: 200 },
    { x: 0.12, y: 0.1125, width: 0.3, height: 0.25 },
  ),
);

function comp(over: Partial<CompNodeData> = {}): CompNodeData {
  return { ...defaultCompData(), fgAlignMeta: META, ...over } as CompNodeData;
}

describe("buildCompParams — FG auto-align", () => {
  it("defaults a legacy comp (no align fields at all) to on + fit", () => {
    const data = comp();
    delete (data as Partial<CompNodeData>).fgAlign;
    delete (data as Partial<CompNodeData>).fgAlignFit;
    const spec = buildCompParams(data).fgAlign;
    expect(spec).toEqual({
      crop: { x: 120, y: 90, width: 300, height: 200 },
      region: { x: 0.12, y: 0.1125, width: 0.3, height: 0.25 },
      srcW: 1000,
      srcH: 800,
      fit: "fit",
    });
  });

  it("never leaves an undefined inside the spec (they become NaN uniforms)", () => {
    const spec = buildCompParams(comp())!.fgAlign!;
    for (const v of [spec.srcW, spec.srcH, spec.crop.x, spec.crop.y, spec.crop.width, spec.crop.height,
      spec.region.x, spec.region.y, spec.region.width, spec.region.height]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(spec.fit).toBeDefined();
  });

  it("passes the user's fit through", () => {
    expect(buildCompParams(comp({ fgAlignFit: "stretch" })).fgAlign?.fit).toBe("stretch");
    expect(buildCompParams(comp({ fgAlignFit: "fill" })).fgAlign?.fit).toBe("fill");
  });

  it("omits the field entirely when the user turns align off", () => {
    const params = buildCompParams(comp({ fgAlign: "off" }));
    expect(params.fgAlign).toBeUndefined();
    expect("fgAlign" in params).toBe(false); // absent, not present-and-undefined
  });

  it("omits it when the output frame is the FG's own size", () => {
    // BG-space placement is meaningless then; the setting is the user's, so it
    // is blocked with a reason rather than silently coerced back to "bg".
    const data = comp({ outputResolution: "fg" });
    expect(buildCompParams(data).fgAlign).toBeUndefined();
    expect(data.outputResolution).toBe("fg");
    expect(resolveFgAlign(data).blocked).toMatch(/FG/);
  });
});

describe("buildCompParams — unusable metadata yields no alignment", () => {
  const bad: Array<[string, string | null | undefined]> = [
    ["absent", undefined],
    ["null (pin connected, carrying nothing)", null],
    ["empty", ""],
    ["free text from a prompt node", "make the sky bluer"],
    ["JSON that is not a crop payload", JSON.stringify({ v: 1, kind: "panoCrop" })],
    ["a crop payload from a future version", JSON.stringify({ ...JSON.parse(META), v: 2 })],
    ["a crop rect that does not fit its own source", JSON.stringify({ ...JSON.parse(META), sourceWidth: 100 })],
  ];
  for (const [label, meta] of bad) {
    it(`ignores ${label}`, () => {
      const data = comp({ fgAlignMeta: meta });
      expect(buildCompParams(data).fgAlign).toBeUndefined();
      // And says why, so the editor can disable its checkbox with a reason.
      expect(resolveFgAlign(data).blocked).toBeTruthy();
      expect(resolveFgAlign(data).meta).toBeNull();
    });
  }
});

describe("resolveFgAlign — what the editor is told", () => {
  it("reports no blockage when align is simply switched off (a choice, not a fault)", () => {
    const r = resolveFgAlign(comp({ fgAlign: "off" }));
    expect(r.blocked).toBeNull();
    expect(r.spec).toBeNull();
    expect(r.meta).not.toBeNull(); // still parsed, so the UI can show the rect
  });

  it("hands the parsed metadata back even when align is running", () => {
    expect(resolveFgAlign(comp()).meta?.emittedWidth).toBe(300);
  });
});
