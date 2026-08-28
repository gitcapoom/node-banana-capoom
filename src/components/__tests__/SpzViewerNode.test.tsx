import { describe, it, expect } from "vitest";
import { getHandleType } from "@/components/WorkflowCanvas";

describe("spzViewer overlay pins", () => {
  it("types both new pins as image", () => {
    // getHandleType tests includes("image") BEFORE startsWith("text-"), so an id
    // containing "image" is an image pin. Both of these are meant to be.
    expect(getHandleType("image-fg")).toBe("image");
    expect(getHandleType("image-fg_alpha")).toBe("image");
  });
});
