import { describe, it, expect } from "vitest";
import {
  COMP_RESAMPLE_FILTERS,
  COMP_RESAMPLE_LABELS,
  compResampleIndex,
  defaultCompResample,
  type CompResampleFilter,
} from "@/types/comp";

/**
 * The index of a filter in COMP_RESAMPLE_FILTERS is the number handed to the
 * shader as `u_*_flt`, and it is what every saved workflow resolves against.
 * Inserting a filter in the middle would silently repoint comps already on disk
 * at a different kernel — pixels would change on load with nothing in the diff
 * to explain it. These tests exist to make that mistake fail loudly.
 */
describe("comp resample filters — index stability", () => {
  it("pins the exact wire order", () => {
    expect(COMP_RESAMPLE_FILTERS).toEqual([
      "impulse", "bilinear", "keys", "mitchell", "parzen", "lanczos4", "lanczos6", "gaussian",
    ]);
  });

  it("keeps every pre-existing filter at the index it already shipped with", () => {
    // Written as literals on purpose: deriving them from the array would make
    // this test agree with any reordering, which is what it is here to prevent.
    expect(compResampleIndex("impulse")).toBe(0);
    expect(compResampleIndex("bilinear")).toBe(1);
    expect(compResampleIndex("keys")).toBe(2);
    expect(compResampleIndex("mitchell")).toBe(3);
    expect(compResampleIndex("parzen")).toBe(4);
    expect(compResampleIndex("lanczos4")).toBe(5);
    expect(compResampleIndex("lanczos6")).toBe(6);
  });

  it("appends gaussian rather than inserting it", () => {
    expect(compResampleIndex("gaussian")).toBe(7);
    expect(COMP_RESAMPLE_FILTERS[COMP_RESAMPLE_FILTERS.length - 1]).toBe("gaussian");
  });

  it("falls back to bilinear for an unset filter, so old comps keep their look", () => {
    expect(compResampleIndex(undefined)).toBe(1);
    expect(defaultCompResample()).toBe("bilinear");
  });

  it("gives every filter a label, so none renders blank in the dropdown", () => {
    for (const f of COMP_RESAMPLE_FILTERS) {
      expect(COMP_RESAMPLE_LABELS[f as CompResampleFilter]).toBeTruthy();
    }
    expect(Object.keys(COMP_RESAMPLE_LABELS).sort()).toEqual([...COMP_RESAMPLE_FILTERS].sort());
  });
});
