import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { GradeRow, GRADE_SLIDERS } from "@/components/controls/GradeRow";
import { channelToHex, hexToChannel, IDENTITY_GRADE, type GradeParams } from "@/utils/colorGrade";
import { normalizeCompGrade } from "@/types/comp";

/**
 * The Grade control is now shared by the Color Grade node and the Comp node's
 * per-layer colour block. What these tests protect is the reason it was shared:
 * that there is ONE table of parameters, and that a row hands its host a whole
 * per-channel value rather than a master scalar.
 *
 * jsdom has no WebGL and no image decode, so nothing here asserts pixels — the
 * shader that consumes these values is exercised in the browser, not in vitest.
 */

const defFor = (key: keyof GradeParams) => {
  const def = GRADE_SLIDERS.find((s) => s.key === key);
  if (!def) throw new Error(`no slider def for ${key}`);
  return def;
};

describe("GRADE_SLIDERS — the single definition", () => {
  it("covers exactly the grade parameters, once each", () => {
    const keys = GRADE_SLIDERS.map((s) => s.key).sort();
    expect(keys).toEqual((Object.keys(IDENTITY_GRADE) as Array<keyof GradeParams>).sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("defaults to the same identity the data layers use", () => {
    // Three places used to spell the identity out: the node's slider table, the
    // comp editor's copy of it, and normalizeCompGrade. The copy is gone; this
    // is what keeps the survivors from drifting apart.
    const compIdentity = normalizeCompGrade(undefined);
    for (const def of GRADE_SLIDERS) {
      expect(def.defaultValue).toBe(IDENTITY_GRADE[def.key].r);
      expect(compIdentity[def.key]).toEqual({ r: def.defaultValue, g: def.defaultValue, b: def.defaultValue });
    }
  });

  it("keeps each identity reachable inside its own slider range", () => {
    for (const def of GRADE_SLIDERS) {
      expect(def.defaultValue).toBeGreaterThanOrEqual(def.min);
      expect(def.defaultValue).toBeLessThanOrEqual(def.max);
      expect(def.step).toBeGreaterThan(0);
    }
  });
});

describe("GradeRow", () => {
  it("writes one channel and leaves the other two alone", () => {
    const onChange = vi.fn();
    const { container } = render(
      <GradeRow def={defFor("gain")} value={{ r: 1, g: 1, b: 1 }} expanded onChange={onChange} onToggleExpanded={() => {}} />,
    );
    // Split mode: three tracks, R/G/B in order, and no master track.
    const ranges = container.querySelectorAll('input[type="range"]');
    expect(ranges).toHaveLength(3);
    fireEvent.change(ranges[1], { target: { value: "1.5" } });
    expect(onChange).toHaveBeenCalledWith({ r: 1, g: 1.5, b: 1 });
  });

  it("moves all three together in master mode", () => {
    const onChange = vi.fn();
    const { container } = render(
      <GradeRow def={defFor("gain")} value={{ r: 1, g: 1, b: 1 }} expanded={false} onChange={onChange} onToggleExpanded={() => {}} />,
    );
    const ranges = container.querySelectorAll('input[type="range"]');
    expect(ranges).toHaveLength(1);
    fireEvent.change(ranges[0], { target: { value: "0.5" } });
    expect(onChange).toHaveBeenCalledWith({ r: 0.5, g: 0.5, b: 0.5 });
  });

  it("shows the row's colour on its swatch", () => {
    const { container } = render(
      <GradeRow
        def={defFor("gain")}
        value={hexToChannel("#ff8000")}
        expanded={false}
        onChange={() => {}}
        onToggleExpanded={() => {}}
      />,
    );
    const swatch = container.querySelector('[title="Colour balance wheel"]') as HTMLElement;
    expect(swatch).toBeTruthy();
    expect(swatch.style.backgroundColor).toBe("rgb(255, 128, 0)");
  });

  it("round-trips a picked colour through hex", () => {
    // The swatch and the native picker both cross this boundary, so a lossy
    // conversion would mean opening the picker quietly nudged the grade.
    for (const hex of ["#000000", "#ffffff", "#3b82f6", "#ef4444", "#123456", "#ff8000"]) {
      expect(channelToHex(hexToChannel(hex))).toBe(hex);
    }
  });
});

describe("GradeRow — screen eyedropper", () => {
  /** Open the wheel popover, which is where the picking controls live.
   *  It portals to document.body, so it is NOT inside the render container —
   *  querying the container instead would make every assertion below pass
   *  vacuously. */
  function openPopover(container: HTMLElement) {
    const swatch = container.querySelector("button");
    if (swatch) fireEvent.click(swatch);
  }
  const screenBtn = () =>
    [...document.body.querySelectorAll("button")].find((b) => /Screen|Picking/.test(b.textContent ?? ""));

  function renderRow(onChange: () => void) {
    return render(
      <GradeRow def={defFor("gain")} value={{ r: 1, g: 1, b: 1 }} expanded={false} onChange={onChange} onToggleExpanded={() => {}} />,
    );
  }

  it("offers no eyedropper where the browser has none", () => {
    // jsdom has no EyeDropper, which is the non-Chromium case. Offering a
    // control that cannot work is worse than not offering it.
    expect("EyeDropper" in window).toBe(false);
    const { container } = renderRow(vi.fn());
    openPopover(container);
    // Sanity-check the popover really opened, so this is not vacuous.
    expect(document.getElementById("grade-wheel-pop")).not.toBeNull();
    expect(screenBtn()).toBeUndefined();
  });

  it("assigns the sampled pixel, clamped into the row's range", async () => {
    const open = vi.fn().mockResolvedValue({ sRGBHex: "#ff8000" });
    vi.stubGlobal("EyeDropper", class { open = open; });
    try {
      const onChange = vi.fn();
      const { container } = renderRow(onChange);
      openPopover(container);
      const btn = screenBtn();
      expect(btn).toBeDefined();
      await act(async () => { fireEvent.click(btn!); });
      expect(open).toHaveBeenCalled();
      // Same assignment path as the native picker: hex -> channels, clamped.
      expect(onChange).toHaveBeenCalledWith(hexToChannel("#ff8000"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("changes nothing when the pick is cancelled", async () => {
    // The API rejects on Escape / right-click. That is a cancellation, not an
    // error, and must not write a value or leave the button stuck.
    const open = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    vi.stubGlobal("EyeDropper", class { open = open; });
    try {
      const onChange = vi.fn();
      const { container } = renderRow(onChange);
      openPopover(container);
      await act(async () => { fireEvent.click(screenBtn()!); });
      expect(onChange).not.toHaveBeenCalled();
      expect(screenBtn()?.hasAttribute("disabled")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
