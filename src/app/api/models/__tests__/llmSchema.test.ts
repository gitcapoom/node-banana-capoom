import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { asLlmProvider, llmModelParameters } from "../llmSchema";
import { clearOpenRouterCache } from "@/lib/llm/openrouterCatalogue";
import type { NextRequest } from "next/server";

const req = { headers: { get: () => null } } as unknown as NextRequest;

const catalogue = {
  data: [
    { id: "openai/gpt-4.1", context_length: 1047576, top_provider: { max_completion_tokens: 32768 },
      supported_parameters: ["max_tokens", "seed", "temperature", "top_p"] },
    { id: "openai/o3", context_length: 200000, top_provider: { max_completion_tokens: 100000 },
      supported_parameters: ["max_tokens", "reasoning", "seed"] },
  ],
};

describe("asLlmProvider", () => {
  it("accepts both names this app uses for Google", () => {
    expect(asLlmProvider("google")).toBe("google");
    expect(asLlmProvider("gemini")).toBe("google");
  });
  it("accepts openai and anthropic", () => {
    expect(asLlmProvider("openai")).toBe("openai");
    expect(asLlmProvider("anthropic")).toBe("anthropic");
  });
  it("rejects image providers", () => {
    expect(asLlmProvider("fal")).toBeNull();
    expect(asLlmProvider("")).toBeNull();
  });
});

describe("llmModelParameters", () => {
  beforeEach(() => { clearOpenRouterCache(); });
  afterEach(() => vi.unstubAllGlobals());

  const serve = () => vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(catalogue), { status: 200 })));

  it("resolves a listed model to its own parameters", async () => {
    serve();
    const r = await llmModelParameters("openai", "gpt-4.1", req);
    expect(r.resolved).toBe(true);
    expect(r.parameters.map((p) => p.name)).toContain("temperature");
  });

  it("omits temperature for a model that does not accept it", async () => {
    serve();
    const r = await llmModelParameters("openai", "o3", req);
    expect(r.parameters.map((p) => p.name)).not.toContain("temperature");
  });

  it("falls back to the family for an unlisted model, and says so", async () => {
    serve();
    const r = await llmModelParameters("openai", "gpt-9-unreleased", req);
    expect(r.resolved).toBe(false);
    expect(r.parameters.map((p) => p.name)).toContain("temperature");
  });

  it("still returns controls when the catalogue is unreachable", async () => {
    // The node must never render with nothing.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const r = await llmModelParameters("anthropic", "claude-sonnet-4", req);
    expect(r.resolved).toBe(false);
    expect(r.parameters.length).toBeGreaterThan(0);
  });

  it("never returns an empty parameter list, for any provider or id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    for (const p of ["google", "openai", "anthropic"] as const) {
      const r = await llmModelParameters(p, "nonsense-model", req);
      expect(r.parameters.length).toBeGreaterThan(0);
    }
  });
});
