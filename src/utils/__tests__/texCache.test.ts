import { describe, it, expect, vi } from "vitest";
import { TexCache } from "../texCache";

const mk = (budget: number) => {
  const disposed: string[] = [];
  const c = new TexCache<string>(budget, (v) => disposed.push(v));
  return { c, disposed };
};

describe("TexCache", () => {
  it("reorders on get, so the hot entry survives eviction (the FIFO bug)", () => {
    const { c, disposed } = mk(300);
    c.set("a", "A", 100);
    c.set("b", "B", 100);
    c.set("c", "C", 100);
    c.get("a");            // 'a' is oldest by insertion but hottest by use
    c.set("d", "D", 100);  // forces one eviction
    expect(disposed).toEqual(["B"]); // FIFO would have evicted "A"
    expect(c.get("a")).toBe("A");
  });

  it("evicts by BYTES, not entry count, and loops until under budget", () => {
    const { c, disposed } = mk(250);
    c.set("a", "A", 100);
    c.set("b", "B", 100);
    c.set("c", "C", 200); // must evict both a and b
    expect(disposed).toEqual(["A", "B"]);
    expect(c.bytes).toBe(200);
    expect(c.size).toBe(1);
  });

  it("disposes exactly once per evicted entry", () => {
    const dispose = vi.fn();
    const c = new TexCache<string>(100, dispose);
    c.set("a", "A", 100);
    c.set("b", "B", 100);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith("A");
  });

  it("replacing a live key disposes the old value once, not the new one", () => {
    const { c, disposed } = mk(1000);
    c.set("a", "OLD", 100);
    c.set("a", "NEW", 100);
    expect(disposed).toEqual(["OLD"]);
    expect(c.get("a")).toBe("NEW");
    expect(c.bytes).toBe(100);
  });

  it("re-setting the identical value does not dispose it", () => {
    const { c, disposed } = mk(1000);
    c.set("a", "SAME", 100);
    c.set("a", "SAME", 100);
    expect(disposed).toEqual([]);
    expect(c.get("a")).toBe("SAME");
  });

  it("never evicts the entry just inserted, even if it alone exceeds budget", () => {
    const { c, disposed } = mk(50);
    c.set("big", "BIG", 500);
    expect(disposed).toEqual([]);
    expect(c.get("big")).toBe("BIG");
  });

  it("clear disposes everything and resets the byte total", () => {
    const { c, disposed } = mk(1000);
    c.set("a", "A", 100);
    c.set("b", "B", 100);
    c.clear();
    expect(disposed).toEqual(["A", "B"]);
    expect(c.size).toBe(0);
    expect(c.bytes).toBe(0);
  });

  it("delete disposes and frees its bytes; deleting twice is a no-op", () => {
    const { c, disposed } = mk(1000);
    c.set("a", "A", 100);
    expect(c.delete("a")).toBe(true);
    expect(c.delete("a")).toBe(false);
    expect(disposed).toEqual(["A"]);
    expect(c.bytes).toBe(0);
  });
});
