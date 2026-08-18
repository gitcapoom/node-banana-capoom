import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadMediaById } from "../mediaStorage";

/**
 * These guard the fix for the worst load-time pathology found in this project:
 * every consumer resolved its own inputs, so N nodes sharing one upstream fired
 * N identical full-res reads at once. Measured before the fix: 87 requests for
 * 43 distinct files, one fetched 8 times, each up to 59s off the network share.
 */
describe("loadMediaById — in-flight de-duplication", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /** A fetch stub that resolves only when `release()` is called. */
  function deferredFetch(image = "data:image/png;base64,AAA") {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      await gate;
      return new Response(JSON.stringify({ success: true, image }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls, release, image };
  }

  it("collapses concurrent requests for the same ref into ONE fetch", async () => {
    const { calls, release, image } = deferredFetch();

    const all = Promise.all(
      Array.from({ length: 8 }, () => loadMediaById("img-abc", "/proj", "inputs"))
    );
    release();
    const results = await all;

    expect(calls).toHaveLength(1);
    // Every caller must still get the real value — sharing the promise is only
    // correct if nobody is handed undefined.
    expect(results.every((r) => r === image)).toBe(true);
  });

  it("does not collapse different refs", async () => {
    const { calls, release } = deferredFetch();

    const all = Promise.all([
      loadMediaById("img-a", "/proj", "inputs"),
      loadMediaById("img-b", "/proj", "inputs"),
    ]);
    release();
    await all;

    expect(calls).toHaveLength(2);
  });

  it("does not collapse the same ref across different projects or folders", async () => {
    const { calls, release } = deferredFetch();

    const all = Promise.all([
      loadMediaById("img-a", "/proj-one", "inputs"),
      loadMediaById("img-a", "/proj-two", "inputs"),
      loadMediaById("img-a", "/proj-one", "generations"),
    ]);
    release();
    await all;

    expect(calls).toHaveLength(3);
  });

  it("releases the entry once settled, so a later call re-fetches", async () => {
    const first = deferredFetch();
    const p1 = loadMediaById("img-abc", "/proj", "inputs");
    first.release();
    await p1;
    expect(first.calls).toHaveLength(1);

    // A fresh stub: if the entry had leaked, this second call would resolve from
    // the stale promise and never touch fetch — which would mean an image edited
    // on disk could never be re-read.
    const second = deferredFetch("data:image/png;base64,BBB");
    const p2 = loadMediaById("img-abc", "/proj", "inputs");
    second.release();
    expect(await p2).toBe("data:image/png;base64,BBB");
    expect(second.calls).toHaveLength(1);
  });

  it("returns null without fetching when the ref or path is empty", async () => {
    const { calls } = deferredFetch();

    expect(await loadMediaById("", "/proj", "inputs")).toBeNull();
    expect(await loadMediaById("img-abc", "", "inputs")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
