import { describe, it, expect, vi } from "vitest";
import { derivePrompt, tagInstruction, retryInstruction } from "../derivePrompt";

const deps = (over: Partial<Parameters<typeof derivePrompt>[2]> = {}) => ({
  retry: vi.fn().mockResolvedValue(""),
  shrink: vi.fn(async (t: string) => t),
  ...over,
});

describe("derivePrompt", () => {
  it("uses the block and never retries when one is present", async () => {
    const d = deps();
    const r = await derivePrompt("Sure.\n<prompt>a warehouse</prompt>", { wantNegative: false }, d);
    expect(r.prompt).toBe("a warehouse");
    expect(r.retried).toBe(false);
    expect(d.retry).not.toHaveBeenCalled();
    expect(r.warning).toBeNull();
  });

  it("retries exactly once when the block is missing", async () => {
    const d = deps({ retry: vi.fn().mockResolvedValue("<prompt>recovered</prompt>") });
    const r = await derivePrompt("just prose", { wantNegative: false }, d);
    expect(d.retry).toHaveBeenCalledTimes(1);
    expect(d.retry).toHaveBeenCalledWith("just prose");
    expect(r.prompt).toBe("recovered");
    expect(r.warning).toBeNull();
  });

  it("falls back to the whole reply and warns when the retry also fails", async () => {
    const d = deps({ retry: vi.fn().mockResolvedValue("still no block") });
    const r = await derivePrompt("just prose", { wantNegative: false }, d);
    expect(r.prompt).toBe("just prose");
    expect(r.warning).toContain("prompt not stripped");
  });

  it("falls back when the retry call itself throws", async () => {
    const d = deps({ retry: vi.fn().mockRejectedValue(new Error("network")) });
    const r = await derivePrompt("just prose", { wantNegative: false }, d);
    expect(r.prompt).toBe("just prose");
    expect(r.warning).toContain("prompt not stripped");
  });

  it("returns the negative prompt when asked for one", async () => {
    const d = deps();
    const r = await derivePrompt(
      "<prompt>a warehouse</prompt><negative_prompt>blurry</negative_prompt>",
      { wantNegative: true },
      d,
    );
    expect(r.negativePrompt).toBe("blurry");
    expect(r.warning).toBeNull();
  });

  it("warns but does not fail when the negative is missing", async () => {
    const d = deps({ retry: vi.fn().mockResolvedValue("") });
    const r = await derivePrompt("<prompt>a warehouse</prompt>", { wantNegative: true }, d);
    expect(r.prompt).toBe("a warehouse");
    expect(r.negativePrompt).toBeNull();
    expect(r.warning).toContain("no negative prompt");
  });

  it("ignores a negative block when negatives were not requested", async () => {
    const d = deps();
    const r = await derivePrompt(
      "<prompt>a</prompt><negative_prompt>b</negative_prompt>",
      { wantNegative: false },
      d,
    );
    expect(r.negativePrompt).toBeNull();
  });

  it("applies the character budget to the derived prompt", async () => {
    const d = deps({ shrink: vi.fn().mockResolvedValue("short") });
    const r = await derivePrompt("<prompt>a very long warehouse prompt</prompt>", { wantNegative: false, maxChars: 10 }, d);
    expect(d.shrink).toHaveBeenCalled();
    expect(r.prompt).toBe("short");
  });

  it("skips the budget when none is set", async () => {
    const d = deps();
    await derivePrompt("<prompt>anything at all</prompt>", { wantNegative: false, maxChars: 0 }, d);
    expect(d.shrink).not.toHaveBeenCalled();
  });

  it("combines warnings rather than losing one", async () => {
    const d = deps({
      retry: vi.fn().mockResolvedValue(""),
      shrink: vi.fn(async (t: string) => t),
    });
    const r = await derivePrompt("prose only", { wantNegative: true, maxChars: 3 }, d);
    expect(r.warning).toContain("prompt not stripped");
    expect(r.warning).toContain("no negative prompt");
    expect(r.warning).toContain("over limit");
  });
});

describe("instructions", () => {
  it("asks for the negative block only when wanted", () => {
    expect(tagInstruction(false)).not.toContain("negative_prompt");
    expect(tagInstruction(true)).toContain("negative_prompt");
    expect(retryInstruction(false)).not.toContain("negative_prompt");
    expect(retryInstruction(true)).toContain("negative_prompt");
  });

  it("tells the model to emit the prompt alone", () => {
    expect(tagInstruction(false)).toContain("<prompt></prompt>");
    expect(tagInstruction(false)).toMatch(/ONLY the prompt/);
  });
});
