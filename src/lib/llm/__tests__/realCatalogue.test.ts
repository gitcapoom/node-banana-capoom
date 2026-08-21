import { describe, it, expect } from "vitest";
import fixture from "./openrouter.fixture.json";
import { toModelParameters } from "../llmParameterSchema";
import type { OpenRouterEntry } from "../openrouterCatalogue";

/**
 * Against REAL captured entries, not invented ones.
 *
 * Hand-written fixtures only prove the code does what I assumed the API says.
 * These four were captured from openrouter.ai/api/v1/models on 2026-08-21, so
 * they prove it does the right thing with what the API ACTUALLY says.
 */
const entries = new Map<string, OpenRouterEntry>(
  fixture.data.map((m) => [m.id, {
    id: m.id,
    supportedParameters: m.supported_parameters,
    contextLength: m.context_length ?? null,
    maxCompletionTokens: m.top_provider?.max_completion_tokens ?? null,
  }]),
);
const namesFor = (id: string) => toModelParameters(entries.get(id)!).map((p) => p.name);

describe("real OpenRouter entries", () => {
  it("gpt-4.1 gets temperature, topP, maxTokens and seed", () => {
    expect(namesFor("openai/gpt-4.1")).toEqual(
      expect.arrayContaining(["temperature", "topP", "maxTokens", "seed"]));
  });

  it("o3 gets NO temperature — the bug this feature exists to fix", () => {
    const n = namesFor("openai/o3");
    expect(n).not.toContain("temperature");
    expect(n).toContain("reasoning");
  });

  it("claude-opus-5-fast gets no temperature but does get reasoning and verbosity", () => {
    const n = namesFor("anthropic/claude-opus-5-fast");
    expect(n).not.toContain("temperature");
    expect(n).toEqual(expect.arrayContaining(["reasoning", "verbosity", "stopSequences"]));
  });

  it("gemini-2.5-flash gets temperature, topP, seed and stop", () => {
    expect(namesFor("google/gemini-2.5-flash")).toEqual(
      expect.arrayContaining(["temperature", "topP", "seed", "stopSequences"]));
  });

  it("no model surfaces a tools control", () => {
    for (const id of entries.keys()) expect(namesFor(id)).not.toContain("tools");
  });

  it("every real model yields at least one control", () => {
    for (const id of entries.keys()) expect(namesFor(id).length).toBeGreaterThan(0);
  });
});
