import { describe, it, expect } from "vitest";
import { setAtPath } from "../deepSet";

describe("setAtPath", () => {
  it("sets a flat key", () => {
    const t: Record<string, unknown> = {};
    setAtPath(t, "image_url", "x");
    expect(t).toEqual({ image_url: "x" });
  });

  it("creates nested objects for dotted keys", () => {
    const t: Record<string, unknown> = {};
    setAtPath(t, "fill_image.fill_image_url", "x");
    expect(t).toEqual({ fill_image: { fill_image_url: "x" } });
  });

  it("creates arrays for numeric segments and merges items", () => {
    const t: Record<string, unknown> = {};
    setAtPath(t, "elements.0.frontal_image_url", "f0");
    setAtPath(t, "elements.0.video_url", "v0");
    setAtPath(t, "elements.1.frontal_image_url", "f1");
    expect(t).toEqual({
      elements: [
        { frontal_image_url: "f0", video_url: "v0" },
        { frontal_image_url: "f1" },
      ],
    });
  });

  it("sets an array value at a nested path", () => {
    const t: Record<string, unknown> = {};
    setAtPath(t, "elements.0.reference_image_urls", ["a", "b"]);
    expect(t).toEqual({ elements: [{ reference_image_urls: ["a", "b"] }] });
  });
});
