import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getOpenRouterCatalogue, clearOpenRouterCache } from "../openrouterCatalogue";

const payload = {
  data: [
    { id: "openai/gpt-4.1", context_length: 1047576, top_provider: { max_completion_tokens: 32768 },
      supported_parameters: ["max_tokens", "seed", "temperature", "top_p"] },
    { id: "openai/o3", context_length: 200000, top_provider: { max_completion_tokens: 100000 },
      supported_parameters: ["max_tokens", "reasoning", "seed"] },
  ],
};
const ok = () => new Response(JSON.stringify(payload), { status: 200 });

describe("getOpenRouterCatalogue", () => {
  beforeEach(() => { clearOpenRouterCache(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("indexes entries by id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const cat = await getOpenRouterCatalogue();
    expect(cat.get("openai/gpt-4.1")?.supportedParameters).toContain("temperature");
    // The case this whole feature exists for.
    expect(cat.get("openai/o3")?.supportedParameters).not.toContain("temperature");
    expect(cat.get("openai/o3")?.maxCompletionTokens).toBe(100000);
  });

  it("fetches once and serves the cache for 48 hours", async () => {
    const f = vi.fn(async () => ok());
    vi.stubGlobal("fetch", f);
    await getOpenRouterCatalogue();
    vi.advanceTimersByTime(47 * 60 * 60 * 1000);
    await getOpenRouterCatalogue();
    expect(f).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    await getOpenRouterCatalogue();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("serves a STALE catalogue rather than failing when a refresh errors", async () => {
    const f = vi.fn().mockResolvedValueOnce(ok()).mockRejectedValueOnce(new Error("network"));
    vi.stubGlobal("fetch", f);
    await getOpenRouterCatalogue();
    vi.advanceTimersByTime(49 * 60 * 60 * 1000);
    const cat = await getOpenRouterCatalogue();
    expect(cat.get("openai/gpt-4.1")).toBeDefined();
  });

  it("returns an empty map when the very first fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect((await getOpenRouterCatalogue()).size).toBe(0);
  });

  it("skips entries with no supported_parameters", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "x/y" }, ...payload.data] }), { status: 200 })));
    const cat = await getOpenRouterCatalogue();
    expect(cat.has("x/y")).toBe(false);
    expect(cat.size).toBe(2);
  });

  it("does not fire a second fetch while one is in flight", async () => {
    let resolve!: (r: Response) => void;
    const f = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal("fetch", f);
    const a = getOpenRouterCatalogue();
    const b = getOpenRouterCatalogue();
    resolve(ok());
    await Promise.all([a, b]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("treats a non-200 as a failure and keeps the stale entry", async () => {
    const f = vi.fn().mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(new Response("nope", { status: 503 }));
    vi.stubGlobal("fetch", f);
    await getOpenRouterCatalogue();
    vi.advanceTimersByTime(49 * 60 * 60 * 1000);
    expect((await getOpenRouterCatalogue()).size).toBe(2);
  });
});
