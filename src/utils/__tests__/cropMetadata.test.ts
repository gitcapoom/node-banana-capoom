import { describe, it, expect } from "vitest";
import {
  buildCropMetadata,
  identityCropMetadata,
  serializeCropMetadata,
  parseCropMetadata,
  type CropMetadata,
} from "../cropMetadata";
import type { CropResult } from "../cropImage";

const result = (over: Partial<CropResult> = {}): CropResult => ({
  dataUrl: "data:image/png;base64,AAAA",
  srcW: 1000,
  srcH: 800,
  sx: 100,
  sy: 50,
  sw: 400,
  sh: 300,
  ...over,
});

const REGION = { x: 0.1, y: 0.0625, width: 0.4, height: 0.375 };

/** A payload that must parse, so overrides below isolate one rejection each. */
const valid = (): Record<string, unknown> => ({
  v: 1,
  kind: "imageCrop",
  origin: "top-left",
  sourceWidth: 1000,
  sourceHeight: 800,
  crop: { x: 100, y: 50, width: 400, height: 300 },
  region: { ...REGION },
  emittedWidth: 400,
  emittedHeight: 300,
});

const withOverride = (over: Record<string, unknown>): string =>
  JSON.stringify({ ...valid(), ...over });

describe("buildCropMetadata", () => {
  it("round-trips through serialize → parse unchanged", () => {
    const built = buildCropMetadata(result(), REGION);
    const parsed = parseCropMetadata(serializeCropMetadata(built));
    expect(parsed).toEqual(built);
  });

  it("carries the sample rect and the source frame", () => {
    const m = buildCropMetadata(result(), REGION);
    expect(m.crop).toEqual({ x: 100, y: 50, width: 400, height: 300 });
    expect(m.sourceWidth).toBe(1000);
    expect(m.sourceHeight).toBe(800);
    expect(m.origin).toBe("top-left");
  });

  it("defaults the emitted size to the crop's own pixels", () => {
    const m = buildCropMetadata(result(), REGION);
    expect([m.emittedWidth, m.emittedHeight]).toEqual([400, 300]);
  });

  it("takes an explicit emitted size when the handle image is not the raw crop", () => {
    const m = buildCropMetadata(result(), REGION, { width: 1024, height: 768 });
    expect([m.emittedWidth, m.emittedHeight]).toEqual([1024, 768]);
    // The crop rect is untouched by that — it still describes the source pixels.
    expect(m.crop.width).toBe(400);
  });

  /**
   * The region and the integer rect must describe the SAME sample.
   *
   * `cropImageToDataUrl` clamps its region before rounding, so the integers are
   * always in-frame; the raw region need not be. ImageCropModal's transform
   * handler clamps the box to the image edge and THEN applies its 5px minimum
   * (`Math.max(5, w)`), so dragging the crop against an edge can hand us
   * `x + width > 1`. Stored raw, `parseCropMetadata` rejects the whole payload
   * and the Comp reports "no crop metadata" — a silent loss of alignment with a
   * misleading reason. Clamping here keeps the two halves in agreement.
   */
  it("clamps a region that overruns the unit box, so the payload still parses", () => {
    const m = buildCropMetadata(
      result({ srcW: 1000, srcH: 1000, sx: 990, sy: 0, sw: 10, sh: 10 }),
      { x: 0.99, y: 0, width: 0.02, height: 0.01 },
    );
    expect(m.region.x).toBe(0.99);
    // 1 - 0.99 exactly, so it lands ON the box edge rather than past it.
    expect(m.region.x + m.region.width).toBeCloseTo(1, 12);
    expect(parseCropMetadata(serializeCropMetadata(m))).toEqual(m);
  });

  it("clamps a negative origin rather than emitting an unparseable region", () => {
    const m = buildCropMetadata(
      result({ srcW: 1000, srcH: 1000, sx: 0, sy: 0, sw: 100, sh: 100 }),
      { x: -0.05, y: -0.05, width: 0.1, height: 0.1 },
    );
    expect(m.region).toEqual({ x: 0, y: 0, width: 0.1, height: 0.1 });
    expect(parseCropMetadata(serializeCropMetadata(m))).not.toBeNull();
  });
});

describe("independent rounding", () => {
  // cropImageToDataUrl rounds sx and sw separately, so the width that was cut is
  // NOT recoverable from `region`. If someone "simplifies" cropMetadata by
  // deriving crop from region, this is the test that fails.
  it("keeps the width that was cut, not the width region implies", () => {
    const srcW = 10;
    const region = { x: 0.15, y: 0, width: 0.25, height: 1 };
    const sx = Math.round(region.x * srcW);            // round(1.5) = 2
    const sw = Math.max(1, Math.round(region.width * srcW)); // round(2.5) = 3

    const recomputed = Math.round((region.x + region.width) * srcW) - sx; // 4 - 2 = 2
    expect(sw).not.toBe(recomputed);

    const m = buildCropMetadata(
      result({ srcW, srcH: 10, sx, sy: 0, sw, sh: 10 }),
      region
    );
    expect(m.crop.x).toBe(2);
    expect(m.crop.width).toBe(3);
    expect(parseCropMetadata(serializeCropMetadata(m))?.crop.width).toBe(3);
  });

  it("accepts a rect that rounding pushed 1px past the source edge", () => {
    // x=0.45, w=0.55 on a 10px source: round(4.5)=5, round(5.5)=6 → 11 > 10.
    // That rect is what drawImage really got, so it has to survive parsing.
    const m = buildCropMetadata(
      result({ srcW: 10, srcH: 10, sx: 5, sy: 0, sw: 6, sh: 10 }),
      { x: 0.45, y: 0, width: 0.55, height: 1 }
    );
    expect(parseCropMetadata(serializeCropMetadata(m))).toEqual(m);
  });

  it("rejects a rect further past the edge than rounding can explain", () => {
    expect(parseCropMetadata(withOverride({ crop: { x: 100, y: 50, width: 902, height: 300 } }))).toBeNull();
    expect(parseCropMetadata(withOverride({ crop: { x: 100, y: 50, width: 400, height: 752 } }))).toBeNull();
  });
});

describe("identityCropMetadata", () => {
  it("describes the whole frame in place", () => {
    const m = identityCropMetadata(1920, 1080);
    expect(m).toEqual<CropMetadata>({
      v: 1,
      kind: "imageCrop",
      origin: "top-left",
      sourceWidth: 1920,
      sourceHeight: 1080,
      crop: { x: 0, y: 0, width: 1920, height: 1080 },
      region: { x: 0, y: 0, width: 1, height: 1 },
      emittedWidth: 1920,
      emittedHeight: 1080,
    });
  });

  it("survives the round trip too", () => {
    const m = identityCropMetadata(640, 480);
    expect(parseCropMetadata(serializeCropMetadata(m))).toEqual(m);
  });
});

describe("parseCropMetadata rejection", () => {
  it("parses the baseline payload the overrides are built from", () => {
    expect(parseCropMetadata(withOverride({}))).not.toBeNull();
  });

  it("rejects non-strings", () => {
    expect(parseCropMetadata(undefined)).toBeNull();
    expect(parseCropMetadata(null)).toBeNull();
    expect(parseCropMetadata(valid())).toBeNull();
  });

  it("rejects malformed JSON", () => {
    expect(parseCropMetadata("")).toBeNull();
    expect(parseCropMetadata("{")).toBeNull();
    expect(parseCropMetadata("{v:1}")).toBeNull();
  });

  it("rejects free text wired in from a prompt node", () => {
    expect(parseCropMetadata("a cinematic wide shot of a harbour at dusk")).toBeNull();
    expect(parseCropMetadata("null")).toBeNull();
    expect(parseCropMetadata("42")).toBeNull();
    expect(parseCropMetadata('"imageCrop"')).toBeNull();
    expect(parseCropMetadata("[]")).toBeNull();
  });

  it("rejects a wrong or missing version", () => {
    expect(parseCropMetadata(withOverride({ v: 2 }))).toBeNull();
    expect(parseCropMetadata(withOverride({ v: "1" }))).toBeNull();
    expect(parseCropMetadata(JSON.stringify({ ...valid(), v: undefined }))).toBeNull();
  });

  it("rejects a wrong kind", () => {
    expect(parseCropMetadata(withOverride({ kind: "panoCrop" }))).toBeNull();
    expect(parseCropMetadata(withOverride({ kind: "" }))).toBeNull();
  });

  it("rejects a non top-left origin", () => {
    expect(parseCropMetadata(withOverride({ origin: "bottom-left" }))).toBeNull();
    expect(parseCropMetadata(JSON.stringify({ ...valid(), origin: undefined }))).toBeNull();
  });

  it("rejects non-finite numbers", () => {
    // 1e999 survives JSON.parse as Infinity — exactly the shape of garbage a
    // hand-written or truncated payload produces.
    expect(parseCropMetadata(withOverride({}).replace('"sourceWidth":1000', '"sourceWidth":1e999'))).toBeNull();
    expect(parseCropMetadata(withOverride({ region: { ...REGION, x: 1e999 } }))).toBeNull();
    expect(parseCropMetadata(withOverride({ sourceHeight: null }))).toBeNull();
  });

  it("rejects zero or negative dimensions", () => {
    expect(parseCropMetadata(withOverride({ sourceWidth: 0 }))).toBeNull();
    expect(parseCropMetadata(withOverride({ sourceHeight: -800 }))).toBeNull();
    expect(parseCropMetadata(withOverride({ emittedWidth: 0 }))).toBeNull();
    expect(parseCropMetadata(withOverride({ emittedHeight: -1 }))).toBeNull();
    expect(parseCropMetadata(withOverride({ crop: { x: 100, y: 50, width: 0, height: 300 } }))).toBeNull();
    expect(parseCropMetadata(withOverride({ crop: { x: 100, y: 50, width: 400, height: -300 } }))).toBeNull();
    expect(parseCropMetadata(withOverride({ region: { ...REGION, width: 0 } }))).toBeNull();
  });

  it("rejects a negative or fractional crop origin", () => {
    expect(parseCropMetadata(withOverride({ crop: { x: -1, y: 50, width: 400, height: 300 } }))).toBeNull();
    expect(parseCropMetadata(withOverride({ crop: { x: 100.5, y: 50, width: 400, height: 300 } }))).toBeNull();
  });

  it("rejects a region outside the unit box", () => {
    expect(parseCropMetadata(withOverride({ region: { ...REGION, x: -0.1 } }))).toBeNull();
    expect(parseCropMetadata(withOverride({ region: { ...REGION, width: 0.95 } }))).toBeNull();
    expect(parseCropMetadata(withOverride({ region: { ...REGION, height: 0.95 } }))).toBeNull();
  });

  it("rejects missing or non-object rects", () => {
    expect(parseCropMetadata(withOverride({ crop: "100,50,400,300" }))).toBeNull();
    expect(parseCropMetadata(withOverride({ region: [0.1, 0.0625, 0.4, 0.375] }))).toBeNull();
    expect(parseCropMetadata(JSON.stringify({ ...valid(), crop: undefined }))).toBeNull();
  });
});
