import { describe, it, expect } from "vitest";
import { resolveOpenRouterEntry } from "../resolveModelId";
import type { OpenRouterEntry } from "../openrouterCatalogue";

const e = (id: string): OpenRouterEntry => ({
  id, supportedParameters: ["temperature"], contextLength: null, maxCompletionTokens: null,
});
const cat = new Map<string, OpenRouterEntry>([
  ["openai/gpt-4.1", e("openai/gpt-4.1")],
  ["anthropic/claude-sonnet-4", e("anthropic/claude-sonnet-4")],
  ["google/gemini-2.5-flash", e("google/gemini-2.5-flash")],
]);

describe("resolveOpenRouterEntry", () => {
  it("matches an exact namespaced id", () => {
    expect(resolveOpenRouterEntry("openai", "gpt-4.1", cat)?.id).toBe("openai/gpt-4.1");
  });

  it("maps the google provider onto the google namespace", () => {
    expect(resolveOpenRouterEntry("google", "gemini-2.5-flash", cat)?.id).toBe("google/gemini-2.5-flash");
  });

  it("strips a trailing date stamp", () => {
    expect(resolveOpenRouterEntry("anthropic", "claude-sonnet-4-20250514", cat)?.id)
      .toBe("anthropic/claude-sonnet-4");
  });

  it("strips -preview and -latest", () => {
    expect(resolveOpenRouterEntry("google", "gemini-2.5-flash-preview", cat)?.id)
      .toBe("google/gemini-2.5-flash");
    expect(resolveOpenRouterEntry("google", "gemini-2.5-flash-latest", cat)?.id)
      .toBe("google/gemini-2.5-flash");
  });

  it("falls back to the longest family prefix within the provider", () => {
    expect(resolveOpenRouterEntry("anthropic", "claude-sonnet-4-9-turbo", cat)?.id)
      .toBe("anthropic/claude-sonnet-4");
  });

  it("never matches across providers", () => {
    expect(resolveOpenRouterEntry("openai", "claude-sonnet-4", cat)).toBeNull();
  });

  it("returns null for a total miss", () => {
    expect(resolveOpenRouterEntry("openai", "totally-new-thing", cat)).toBeNull();
  });

  it("returns null on an empty catalogue rather than throwing", () => {
    expect(resolveOpenRouterEntry("openai", "gpt-4.1", new Map())).toBeNull();
  });

  it("returns null for an empty model id", () => {
    expect(resolveOpenRouterEntry("openai", "", cat)).toBeNull();
  });
});
