import { describe, it, expect, vi, afterEach } from "vitest";
import { getGoogleModelMeta } from "@/lib/llm/googleModels";

/** Shape captured from generativelanguage.googleapis.com on 2026-08-21. */
const googleResponse = {
  models: [
    {
      name: "models/gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      supportedGenerationMethods: ["generateContent"],
      temperature: 1, maxTemperature: 2, topP: 0.95, topK: 64,
      inputTokenLimit: 1048576, outputTokenLimit: 65536, thinking: true,
    },
    {
      name: "models/embedding-001",
      supportedGenerationMethods: ["embedContent"],
    },
  ],
};

describe("getGoogleModelMeta", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the real per-model numbers we used to discard", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(googleResponse), { status: 200 })));
    const meta = await getGoogleModelMeta("gemini-2.5-flash", "key");
    expect(meta).toEqual({
      temperature: 1, maxTemperature: 2, topP: 0.95, topK: 64,
      inputTokenLimit: 1048576, outputTokenLimit: 65536, thinking: true,
    });
  });

  it("returns null for a model that is not a chat model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(googleResponse), { status: 200 })));
    expect(await getGoogleModelMeta("embedding-001", "key")).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(googleResponse), { status: 200 })));
    expect(await getGoogleModelMeta("gemini-99", "key")).toBeNull();
  });

  it("returns null without a key rather than calling out", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await getGoogleModelMeta("gemini-2.5-flash", undefined)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("returns null instead of throwing when the fetch fails", async () => {
    // A metadata lookup must never be why a node cannot render its controls.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await getGoogleModelMeta("gemini-2.5-flash", "key")).toBeNull();
  });
});
