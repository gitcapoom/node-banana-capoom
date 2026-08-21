import { describe, it, expect } from "vitest";
import { toModelParameters, familyFallback } from "../llmParameterSchema";
import type { OpenRouterEntry } from "../openrouterCatalogue";

const entry = (params: string[], extra: Partial<OpenRouterEntry> = {}): OpenRouterEntry => ({
  id: "x/y", supportedParameters: params, contextLength: null, maxCompletionTokens: null, ...extra,
});
const names = (ps: ReturnType<typeof toModelParameters>) => ps.map((p) => p.name);

describe("toModelParameters", () => {
  it("translates OpenRouter names to the node's, in a stable order", () => {
    const ps = toModelParameters(entry(["stop", "seed", "top_k", "top_p", "temperature"]));
    // seed and stopSequences translate but are not surfaced: /api/llm cannot
    // forward them yet, and a control that is shown but not sent is worse than
    // no control at all.
    expect(names(ps)).toEqual(["temperature", "topP", "topK"]);
  });

  it("does not surface a parameter the route cannot forward", () => {
    expect(names(toModelParameters(entry(["seed", "stop", "response_format", "verbosity"])))).toEqual([]);
  });

  it("maps both max-token spellings onto maxTokens, once", () => {
    expect(names(toModelParameters(entry(["max_tokens", "max_completion_tokens"])))).toEqual(["maxTokens"]);
  });

  it("maps reasoning and reasoning_effort onto one reasoning control", () => {
    expect(names(toModelParameters(entry(["reasoning"])))).toEqual(["reasoning"]);
    expect(names(toModelParameters(entry(["reasoning_effort"])))).toEqual(["reasoning"]);
  });

  it("drops tools, tool_choice and include_reasoning", () => {
    expect(names(toModelParameters(entry(["tools", "tool_choice", "include_reasoning", "temperature"]))))
      .toEqual(["temperature"]);
  });

  it("ignores an unknown OpenRouter parameter rather than rendering it raw", () => {
    expect(names(toModelParameters(entry(["temperature", "quantum_flux"])))).toEqual(["temperature"]);
  });

  it("omits temperature for a model that does not accept it", () => {
    // openai/o3 is the real case this feature exists for.
    expect(names(toModelParameters(entry(["max_tokens", "reasoning"])))).not.toContain("temperature");
  });

  it("takes the maxTokens ceiling from the catalogue", () => {
    const ps = toModelParameters(entry(["max_tokens"], { maxCompletionTokens: 100000 }));
    expect(ps.find((p) => p.name === "maxTokens")?.maximum).toBe(100000);
  });

  it("never defaults maxTokens above the model's own ceiling", () => {
    const ps = toModelParameters(entry(["max_tokens"], { maxCompletionTokens: 4096 }));
    const p = ps.find((x) => x.name === "maxTokens")!;
    expect(p.default).toBe(4096);
    expect(p.maximum).toBe(4096);
  });

  it("lets Google's own numbers win over the catalogue", () => {
    const ps = toModelParameters(entry(["temperature", "max_tokens"], { maxCompletionTokens: 8192 }), {
      temperature: 1, maxTemperature: 2, outputTokenLimit: 65536,
    });
    const t = ps.find((p) => p.name === "temperature")!;
    expect(t.default).toBe(1);
    expect(t.maximum).toBe(2);
    expect(ps.find((p) => p.name === "maxTokens")?.maximum).toBe(65536);
  });

  it("applies Google's topP and topK defaults", () => {
    const ps = toModelParameters(entry(["top_p", "top_k"]), { topP: 0.95, topK: 64 });
    expect(ps.find((p) => p.name === "topP")?.default).toBe(0.95);
    expect(ps.find((p) => p.name === "topK")?.default).toBe(64);
  });

  it("removes the reasoning control when Google says the model does not think", () => {
    expect(names(toModelParameters(entry(["reasoning"]), { thinking: false }))).not.toContain("reasoning");
  });

  it("keeps reasoning when Google says it does think", () => {
    expect(names(toModelParameters(entry(["reasoning"]), { thinking: true }))).toContain("reasoning");
  });

  it("returns an empty list for a null entry — the caller falls back", () => {
    expect(toModelParameters(null)).toEqual([]);
  });
});

describe("familyFallback", () => {
  const n = (p: "google" | "openai" | "anthropic", id: string) => familyFallback(p, id).map((x) => x.name);

  it("gives o-series reasoning but NOT temperature", () => {
    expect(n("openai", "o3-mini")).toContain("reasoning");
    expect(n("openai", "o3-mini")).not.toContain("temperature");
  });

  it("gives gpt-* temperature and max tokens", () => {
    expect(n("openai", "gpt-5-turbo")).toEqual(expect.arrayContaining(["temperature", "maxTokens"]));
  });

  it("gives claude-* reasoning", () => {
    expect(n("anthropic", "claude-9-opus")).toEqual(expect.arrayContaining(["temperature", "reasoning"]));
  });

  it("gives gemini-* topK, which the others do not have", () => {
    expect(n("google", "gemini-9-pro")).toContain("topK");
  });

  it("always returns at least maxTokens for an unknown model", () => {
    // The node must never render with no controls at all.
    expect(n("openai", "something-unheard-of")).toEqual(["maxTokens"]);
  });
});
