import type { NextRequest } from "next/server";
import type { ModelParameter } from "@/lib/providers/types";
import {
  getOpenRouterCatalogue,
  clearOpenRouterCache,
  catalogueAgeMs,
  peekOpenRouterCatalogue,
} from "@/lib/llm/openrouterCatalogue";
import { resolveOpenRouterEntry } from "@/lib/llm/resolveModelId";
import { toModelParameters, familyFallback } from "@/lib/llm/llmParameterSchema";
import { getGoogleModelMeta } from "@/app/api/llm/models/route";

/** A model absent from the catalogue is re-checked after an hour, not 48. */
const MISS_RECHECK_MS = 60 * 60 * 1000;

export type LlmProvider = "google" | "openai" | "anthropic";

/** `gemini` is this app's id for the Google IMAGE provider; the LLM side calls
 *  the same vendor `google`. Accept either here. */
export function asLlmProvider(p: string): LlmProvider | null {
  if (p === "google" || p === "gemini") return "google";
  if (p === "openai" || p === "anthropic") return p;
  return null;
}

/**
 * Per-model parameters for a chat model.
 *
 * Never throws and never returns an empty list: an unresolvable id, an offline
 * catalogue or a failed metadata lookup all degrade to the model's family
 * defaults. The node losing precision is acceptable; the node losing its
 * controls is not.
 */
export async function llmModelParameters(
  provider: LlmProvider,
  modelId: string,
  request: NextRequest,
): Promise<{ parameters: ModelParameter[]; resolved: boolean }> {
  let catalogue = await getOpenRouterCatalogue();
  let entry = resolveOpenRouterEntry(provider, modelId, catalogue);

  // A model that shipped this morning is not in the catalogue yet. Caching that
  // absence for the full 48h would pin it to family defaults for two days after
  // OpenRouter adds it, so an unresolved id forces one early refresh.
  if (!entry) {
    const age = catalogueAgeMs();
    if (age === null || age > MISS_RECHECK_MS) {
      clearOpenRouterCache();
      catalogue = await getOpenRouterCatalogue();
      entry = resolveOpenRouterEntry(provider, modelId, catalogue);
    }
  }

  const googleMeta =
    provider === "google"
      ? await getGoogleModelMeta(
          modelId,
          request.headers.get("X-Gemini-Key") ||
            process.env.GEMINI_API_KEY ||
            undefined,
        )
      : null;

  const parameters = toModelParameters(entry, googleMeta);
  if (parameters.length > 0) return { parameters, resolved: true };
  return { parameters: familyFallback(provider, modelId), resolved: false };
}


/**
 * Which parameter names a model accepts, WITHOUT ever hitting the network.
 *
 * Used on the generation path. Filtering must not put a third party between the
 * user and their own provider: if OpenRouter were slow, every reply would wait
 * on it. The catalogue is normally warm already — the UI fetched it to render
 * the controls — and when it is not, the model's family rules give a sound
 * allow-list with no request at all.
 */
export function allowedParameterNames(provider: LlmProvider, modelId: string): Set<string> {
  const catalogue = peekOpenRouterCatalogue();
  const entry = catalogue ? resolveOpenRouterEntry(provider, modelId, catalogue) : null;
  const params = entry ? toModelParameters(entry, null) : familyFallback(provider, modelId);
  return new Set((params.length ? params : familyFallback(provider, modelId)).map((p) => p.name));
}
