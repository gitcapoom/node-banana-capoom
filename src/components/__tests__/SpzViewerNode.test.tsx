import { describe, it, expect } from "vitest";
import { getHandleType } from "@/components/WorkflowCanvas";
import { buildOverlayHandoff, capturedImageCount } from "@/components/nodes/SpzViewerNode";

describe("spzViewer overlay pins", () => {
  it("types both new pins as image", () => {
    // getHandleType tests includes("image") BEFORE startsWith("text-"), so an id
    // containing "image" is an image pin. Both of these are meant to be.
    expect(getHandleType("image-fg")).toBe("image");
    expect(getHandleType("image-fg_alpha")).toBe("image");
  });
});

describe("buildOverlayHandoff", () => {
  it("packs a foreground and its matte", () => {
    expect(buildOverlayHandoff(["data:image/png;base64,FG"], "data:image/png;base64,A"))
      .toEqual({ fg: "data:image/png;base64,FG", alpha: "data:image/png;base64,A" });
  });

  it("treats a foreground with no matte as opaque", () => {
    expect(buildOverlayHandoff(["data:image/png;base64,FG"], null))
      .toEqual({ fg: "data:image/png;base64,FG", alpha: null });
  });

  it("returns null when no foreground is wired, so a lone matte is ignored", () => {
    expect(buildOverlayHandoff([], "data:image/png;base64,A")).toBeNull();
    expect(buildOverlayHandoff([], null)).toBeNull();
  });
});

describe("capture node spawning", () => {
  it("spawns one node per returned image", () => {
    expect(capturedImageCount({ image: "i", depthImage: null, compositeImage: null })).toBe(1);
    expect(capturedImageCount({ image: "i", depthImage: "d", compositeImage: null })).toBe(2);
    expect(capturedImageCount({ image: "i", depthImage: "d", compositeImage: "c" })).toBe(3);
    expect(capturedImageCount({ image: "i", depthImage: null, compositeImage: "c" })).toBe(2);
  });

  it("counts nothing for a capture with no image", () => {
    expect(capturedImageCount({ image: null, depthImage: null, compositeImage: null })).toBe(0);
  });
});
