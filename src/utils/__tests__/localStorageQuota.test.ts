import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setItemReclaiming, setDisposableCache, isQuotaError, storedBytes } from "@/utils/localStorageQuota";

/**
 * The bug this pins:
 *
 * localStorage quota is per ORIGIN, not per key. `node-banana-models-cache` grew
 * to megabytes, and the write that reported "exceeded the quota" was
 * `node-banana-workflow-configs` — a few hundred bytes of project paths that had
 * nothing to do with filling it. The caches swallowed their own failures, so the
 * only visible symptom pointed at the wrong key entirely.
 */

/** A store with a byte budget, so quota can actually be exercised. */
function installStore(budgetChars: number) {
  const data = new Map<string, string>();
  const used = () => [...data].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    removeItem: (k: string) => { data.delete(k); },
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
    clear: () => data.clear(),
    setItem: (k: string, v: string) => {
      const next = used() - (data.has(k) ? k.length + (data.get(k) as string).length : 0) + k.length + v.length;
      if (next > budgetChars) {
        const err = new Error("exceeded the quota");
        err.name = "QuotaExceededError";
        throw err;
      }
      data.set(k, v);
    },
  };
  vi.stubGlobal("localStorage", store);
  vi.stubGlobal("window", { localStorage: store });
  return data;
}

describe("localStorage quota handling", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("recognises a quota error by name", () => {
    const err = new Error("nope");
    err.name = "QuotaExceededError";
    expect(isQuotaError(err)).toBe(true);
    expect(isQuotaError(new Error("something else"))).toBe(false);
  });

  it("counts stored bytes as UTF-16, which is why a 3MB catalogue needs 6MB", () => {
    installStore(10_000);
    localStorage.setItem("k", "x".repeat(1000));
    // (key + value) * 2 — the doubling is the whole reason the catalogue cannot fit.
    expect(storedBytes("k")).toBe((1 + 1000) * 2);
  });

  it("reclaims a disposable cache so a critical write survives a full store", () => {
    const data = installStore(1000);
    // The cache fills the store...
    localStorage.setItem("node-banana-models-cache", "m".repeat(900));
    // ...and the important, tiny write would otherwise fail.
    expect(() => localStorage.setItem("node-banana-workflow-configs", "c".repeat(300)))
      .toThrow(/quota/i);

    setItemReclaiming("node-banana-workflow-configs", "c".repeat(300));

    expect(data.get("node-banana-workflow-configs")).toBe("c".repeat(300));
    expect(data.has("node-banana-models-cache")).toBe(false);
  });

  it("does not drop caches when there is no quota problem", () => {
    const data = installStore(10_000);
    localStorage.setItem("node-banana-models-cache", "m".repeat(100));
    setItemReclaiming("node-banana-workflow-configs", "c".repeat(10));
    expect(data.get("node-banana-models-cache")).toBe("m".repeat(100));
  });

  it("throws with a diagnosis when the value genuinely cannot fit", () => {
    installStore(100);
    expect(() => setItemReclaiming("node-banana-workflow-configs", "c".repeat(500)))
      .toThrow(/localStorage is full/);
  });

  it("a disposable cache reports a full store instead of failing silently", () => {
    installStore(100);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Returns false rather than throwing — a missed cache is not an error...
    expect(setDisposableCache("node-banana-models-cache", "m".repeat(500))).toBe(false);
    // ...but it must SAY so. Silence here is how the origin filled up unnoticed.
    expect(warn).toHaveBeenCalled();
  });
});
