import { describe, it, expect } from "vitest";
import { isImageSizeError } from "../sizeErrorDetection";

describe("isImageSizeError", () => {
  it("does NOT treat a stack overflow as a size error", () => {
    // Regression: "...size exceeded" used to match /maximum.*size/i and trigger
    // a pointless image-compression retry that masked the real RangeError.
    expect(isImageSizeError("Maximum call stack size exceeded")).toBe(false);
    expect(isImageSizeError("RangeError: Maximum call stack size exceeded")).toBe(false);
  });

  it("still detects genuine upload/payload size errors", () => {
    expect(isImageSizeError("Payload too large")).toBe(true);
    expect(isImageSizeError("Request entity too large")).toBe(true);
    expect(isImageSizeError("HTTP 413")).toBe(true);
    expect(isImageSizeError("maximum image size of 20 MB exceeded")).toBe(true);
    expect(isImageSizeError("the image is too big")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isImageSizeError("Deadline expired before operation could complete")).toBe(false);
    expect(isImageSizeError("Invalid API key")).toBe(false);
  });
});
