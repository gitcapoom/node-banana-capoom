import type { ModelParameter } from "@/lib/providers/types";
import type { OpenRouterEntry } from "./openrouterCatalogue";

/** Per-model facts Google publishes for its own models — authoritative. */
export interface GoogleModelMeta {
  temperature?: number;
  maxTemperature?: number;
  topP?: number;
  topK?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  thinking?: boolean;
}

const REASONING_LEVELS = ["off", "low", "medium", "high"];

/** Builders keyed by OUR name, so two OpenRouter spellings collapse to one. */
const BUILD: Record<string, () => ModelParameter> = {
  temperature: () => ({
    name: "temperature", type: "number", default: 0.7, minimum: 0, maximum: 2,
    description: "Higher is more random.",
  }),
  topP: () => ({ name: "topP", type: "number", default: 1, minimum: 0, maximum: 1,
    description: "Nucleus sampling cutoff." }),
  topK: () => ({ name: "topK", type: "integer", minimum: 1,
    description: "Sample from the K most likely tokens." }),
  maxTokens: () => ({ name: "maxTokens", type: "integer", default: 8192, minimum: 1,
    description: "Ceiling on the reply length." }),
  seed: () => ({ name: "seed", type: "integer", description: "Repeatable sampling." }),
  stopSequences: () => ({ name: "stopSequences", type: "array",
    items: { name: "stop", type: "string" }, description: "Stop generating at these strings." }),
  reasoning: () => ({ name: "reasoning", type: "string", default: "off", enum: REASONING_LEVELS,
    description: "How much the model thinks before answering." }),
  responseFormat: () => ({ name: "responseFormat", type: "string", default: "text",
    enum: ["text", "json"], description: "Force JSON output." }),
  verbosity: () => ({ name: "verbosity", type: "string", enum: ["low", "medium", "high"],
    description: "How much detail the model gives." }),
};

/**
 * OpenRouter's vocabulary -> ours. Anything absent here is ignored rather than
 * rendered raw: their catalogue carries names that are theirs alone
 * (`include_reasoning`) and names for features this node does not have
 * (`tools`, `tool_choice`).
 */
const TRANSLATE: Record<string, string> = {
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK",
  max_tokens: "maxTokens",
  max_completion_tokens: "maxTokens",
  seed: "seed",
  stop: "stopSequences",
  reasoning: "reasoning",
  reasoning_effort: "reasoning",
  response_format: "responseFormat",
  structured_outputs: "responseFormat",
  verbosity: "verbosity",
};

/** Stable render order, independent of the order OpenRouter happens to list. */
const ORDER = [
  "temperature", "topP", "topK", "maxTokens",
  "seed", "stopSequences", "reasoning", "responseFormat", "verbosity",
];

/**
 * Parameters /api/llm can actually forward to a provider today.
 *
 * A control that is shown but not sent is worse than no control: it looks like
 * it works. So the emitted set is intersected with this, and it grows only when
 * the route learns to forward another one. seed, stopSequences, responseFormat
 * and verbosity are translated and tested but deliberately not surfaced yet —
 * each needs a per-provider mapping in the three request builders.
 */
const FORWARDABLE = new Set(["temperature", "topP", "topK", "maxTokens", "reasoning"]);

export function toModelParameters(
  entry: OpenRouterEntry | null,
  google?: GoogleModelMeta | null,
): ModelParameter[] {
  if (!entry) return [];

  const wanted = new Set<string>();
  for (const raw of entry.supportedParameters) {
    const ours = TRANSLATE[raw];
    if (ours) wanted.add(ours);
  }

  // Google is authoritative for its own models: it reports the real ceiling and
  // whether the model thinks at all, where the catalogue only reports presence.
  if (google?.thinking === false) wanted.delete("reasoning");

  const params: ModelParameter[] = [];
  for (const name of ORDER) {
    if (!wanted.has(name) || !FORWARDABLE.has(name)) continue;
    const p = BUILD[name]();

    if (name === "maxTokens") {
      const ceiling = google?.outputTokenLimit ?? entry.maxCompletionTokens;
      if (ceiling) {
        p.maximum = ceiling;
        // Never offer a default above the model's own ceiling.
        p.default = Math.min(Number(p.default ?? 8192), ceiling);
      }
    }
    if (name === "temperature" && google) {
      if (typeof google.maxTemperature === "number") p.maximum = google.maxTemperature;
      if (typeof google.temperature === "number") p.default = google.temperature;
    }
    if (name === "topP" && typeof google?.topP === "number") p.default = google.topP;
    if (name === "topK" && typeof google?.topK === "number") p.default = google.topK;

    params.push(p);
  }
  return params;
}

/**
 * Used when the catalogue is unreachable or the id resolves to nothing.
 *
 * Keyed by family pattern rather than exact id, because parameter surfaces
 * change far more slowly than model ids: a claude shipped tomorrow still takes
 * claude's parameters. The node must never render with no controls, so the
 * last case returns maxTokens rather than an empty list.
 */
export function familyFallback(
  provider: "google" | "openai" | "anthropic",
  modelId: string,
): ModelParameter[] {
  const pick = (names: string[]) => names.filter((n) => FORWARDABLE.has(n)).map((n) => BUILD[n]());

  if (provider === "openai") {
    // o-series reject temperature outright.
    if (/^o\d/.test(modelId)) return pick(["maxTokens", "reasoning", "seed"]);
    if (/^gpt-/.test(modelId)) return pick(["temperature", "topP", "maxTokens", "seed"]);
  }
  if (provider === "anthropic" && /^claude-/.test(modelId)) {
    return pick(["temperature", "topP", "maxTokens", "stopSequences", "reasoning"]);
  }
  if (provider === "google" && /^gemini-/.test(modelId)) {
    return pick(["temperature", "topP", "topK", "maxTokens", "stopSequences", "reasoning"]);
  }
  return pick(["maxTokens"]);
}
