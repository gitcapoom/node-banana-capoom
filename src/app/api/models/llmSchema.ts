import type { NextRequest } from "next/server";
import type { ModelParameter } from "@/lib/providers/types";
import {
  getOpenRouterCatalogue,
  clearOpenRouterCache,
  catalogueAgeMs,
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
