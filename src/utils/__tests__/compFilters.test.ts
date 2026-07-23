import { describe, it, expect } from "vitest";
import { buildCompParams } from "../compComposite";
import { isBlurIdentity } from "../colorChain";
import { defaultCompData } from "@/types/comp";
import type { CompNodeData } from "@/types";

describe("isBlurIdentity", () => {
  it("treats absent / none / zero-radius filters as identity", () => {
    expect(isBlurIdentity(undefined)).toBe(true);
    expect(isBlurIdentity(null)).toBe(true);
    expect(isBlurIdentity({ filter: "none", radius: 50, angle: 0 })).toBe(true);
    expect(isBlurIdentity({ filter: "gaussian", radius: 0, angle: 0 })).toBe(true);
  });

  it("treats an active filter with positive radius as non-identity", () => {
    expect(isBlurIdentity({ filter: "gaussian", radius: 5, angle: 0 })).toBe(false);
    expect(isBlurIdentity({ filter: "motion", radius: 20, angle: 45 })).toBe(false);
  });
});

describe("buildCompParams filters", () => {
  it("defaults every input filter to none for legacy data without filter fields", () => {
    const data = defaultCompData() as CompNodeData;
    delete (data as Partial<CompNodeData>).bgFilter;
    delete (data as Partial<CompNodeData>).fgFilter;
    delete (data as Partial<CompNodeData>).matteFilter;
    const params = buildCompParams(data);
    expect(params.filters?.bg).toEqual({ filter: "none", radius: 10, angle: 0 });
    expect(params.filters?.fg.filter).toBe("none");
    expect(params.filters?.matte.filter).toBe("none");
  });

  it("merges partial filter data against defaults (no NaN uniforms)", () => {
    const data = defaultCompData() as CompNodeData;
    data.fgFilter = { filter: "gaussian", radius: 24 } as CompNodeData["fgFilter"];
    const params = buildCompParams(data);
    expect(params.filters?.fg).toEqual({ filter: "gaussian", radius: 24, angle: 0 });
  });
});
