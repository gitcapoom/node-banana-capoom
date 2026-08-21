import { describe, it, expect, vi } from "vitest";
import { shrinkToLimit, MAX_SHRINK_CALLS } from "../shrinkPrompt";

describe("shrinkToLimit", () => {
  it("does nothing when already under the limit", async () => {
    const call = vi.fn();
    const r = await shrinkToLimit("short", 100, call);
    expect(call).not.toHaveBeenCalled();
    expect(r.text).toBe("short");
    expect(r.warning).toBeNull();
  });

  it("stops as soon as it fits", async () => {
    const call = vi.fn().mockResolvedValue("ok");
    const r = await shrinkToLimit("wayyy too long", 5, call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(r.text).toBe("ok");
    expect(r.warning).toBeNull();
  });

  it("gives up after the cap and warns with the overage", async () => {
    const call = vi.fn().mockResolvedValue("still far too long"); // 18 chars
    const r = await shrinkToLimit("original overlong text", 5, call);
    expect(call).toHaveBeenCalledTimes(MAX_SHRINK_CALLS);
    expect(r.text).toBe("still far too long");
    expect(r.warning).toMatch(/13 characters over/);
  });

  it("keeps the SHORTEST attempt, not the last", async () => {
    // A reduction pass can come back longer than its input.
    const call = vi.fn()
      .mockResolvedValueOnce("bbbbbbbb")
      .mockResolvedValueOnce("cc")
      .mockResolvedValueOnce("dddddddddd");
    const r = await shrinkToLimit("aaaaaaaaaaaa", 1, call);
    expect(r.text).toBe("cc");
  });

  it("never truncates — an over-length coherent prompt beats a severed one", async () => {
    const call = vi.fn().mockResolvedValue("abcdefghij");
    const r = await shrinkToLimit("abcdefghijkl", 3, call);
    expect(r.text).toBe("abcdefghij");
  });

  it("treats 0, null and undefined as no limit", async () => {
    const call = vi.fn();
    expect((await shrinkToLimit("anything", 0, call)).text).toBe("anything");
    expect((await shrinkToLimit("anything", null, call)).text).toBe("anything");
    expect((await shrinkToLimit("anything", undefined, call)).text).toBe("anything");
    expect(call).not.toHaveBeenCalled();
  });

  it("passes the model the target and the CURRENT text each round", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce("second pass input")
      .mockResolvedValueOnce("ok");
    await shrinkToLimit("first pass input which is long", 5, call);
    expect(call).toHaveBeenNthCalledWith(1, "first pass input which is long", 5);
    expect(call).toHaveBeenNthCalledWith(2, "second pass input", 5);
  });

  it("stops early and keeps the best so far if a pass fails", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce("shorter but still over")
      .mockRejectedValueOnce(new Error("network"));
    const r = await shrinkToLimit("a much longer original string", 5, call);
    expect(r.text).toBe("shorter but still over");
    expect(r.warning).toMatch(/over/);
  });

  it("ignores an empty response rather than blanking the prompt", async () => {
    const call = vi.fn().mockResolvedValue("   ");
    const r = await shrinkToLimit("the original text", 5, call);
    expect(r.text).toBe("the original text");
  });
});
