import { describe, it, expect } from "vitest";
import {
  detectRefConvention,
  slotToLetter,
  letterToSlot,
  stableRefToken,
  translateReferenceTokens,
} from "../refTokens";

describe("refTokens", () => {
  it("detects the @Image / @Video convention from a description", () => {
    expect(detectRefConvention("Refer to them in the prompt as @Image1, @Image2, etc.")).toBe("Image");
    expect(detectRefConvention("Refer to them as @Video1, @Video2.")).toBe("Video");
    expect(detectRefConvention("Just some images, no convention.")).toBeUndefined();
    expect(detectRefConvention(undefined)).toBeUndefined();
  });

  it("maps slots to stable letters and back", () => {
    expect(slotToLetter(0)).toBe("A");
    expect(slotToLetter(2)).toBe("C");
    expect(letterToSlot("A")).toBe(0);
    expect(letterToSlot("C")).toBe(2);
    expect(stableRefToken("Image", 0)).toBe("@ImageA");
  });

  it("translates stable tokens to positional tokens by current order", () => {
    // Slots 0, 1, 2 connected → A,B,C map to @Image1,2,3.
    expect(translateReferenceTokens("@ImageA next to @ImageC", "Image", [0, 1, 2])).toBe(
      "@Image1 next to @Image3"
    );
  });

  it("keeps stable tokens valid after a middle deletion (no prompt edit needed)", () => {
    // Image B (slot 1) deleted → slots 0, 2 remain. @ImageA→@Image1, @ImageC→@Image2.
    expect(translateReferenceTokens("@ImageA with @ImageC", "Image", [0, 2])).toBe(
      "@Image1 with @Image2"
    );
  });

  it("drops a reference whose slot is no longer connected", () => {
    // @ImageB (slot 1) removed from the graph → its token disappears.
    expect(translateReferenceTokens("@ImageA and @ImageB", "Image", [0])).toBe("@Image1 and ");
  });

  it("leaves positional tokens and unrelated text untouched", () => {
    expect(translateReferenceTokens("already @Image1 here", "Image", [0])).toBe("already @Image1 here");
    expect(translateReferenceTokens("see @Images plural", "Image", [0])).toBe("see @Images plural");
  });
});
