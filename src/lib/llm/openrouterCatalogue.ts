const CATALOGUE_URL = "https://openrouter.ai/api/v1/models";
const HIT_TTL_MS = 48 * 60 * 60 * 1000;

export interface OpenRouterEntry {
  id: string;
  supportedParameters: string[];
  contextLength: number | null;
  maxCompletionTokens: number | null;
}

let cache: { at: number; entries: Map<string, OpenRouterEntry> } | null = null;
let inFlight: Promise<Map<string, OpenRouterEntry>> | null = null;

/** The catalogue already in memory, or null. Never fetches. */
export function peekOpenRouterCatalogue(): Map<string, OpenRouterEntry> | null {
  return cache?.entries ?? null;
}

/** Age of the cached catalogue in ms, or null when nothing is cached. */
export function catalogueAgeMs(): number | null {
  return cache ? Date.now() - cache.at : null;
}

export function clearOpenRouterCache(): void {
  cache = null;
  inFlight = null;
}

/**
 * The whole OpenRouter catalogue in ONE request (~420 models, ~690KB), indexed
 * by id. Cheaper than the per-model schema fetches the image/video route makes,
 * because every model's parameters arrive in the same document.
 *
 * A STALE cache is served in preference to failing — the same rule
 * /api/models/[modelId] already follows. Losing precision in the ranges beats
 * losing the node's controls entirely.
 */
export async function getOpenRouterCatalogue(): Promise<Map<string, OpenRouterEntry>> {
  const fresh = cache && Date.now() - cache.at < HIT_TTL_MS;
  if (cache && fresh) return cache.entries;
  // Coalesce concurrent callers: several nodes mount at once on a workflow open
  // and would otherwise each pull 690KB.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(CATALOGUE_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`OpenRouter catalogue: ${res.status}`);
      const json = await res.json();
      const entries = new Map<string, OpenRouterEntry>();
      for (const m of json?.data ?? []) {
        // An entry with no declared parameters tells us nothing; keeping it
        // would look like "this model supports nothing".
        if (!Array.isArray(m?.supported_parameters) || m.supported_parameters.length === 0) continue;
        entries.set(m.id, {
          id: m.id,
          supportedParameters: m.supported_parameters,
          contextLength: typeof m.context_length === "number" ? m.context_length : null,
          maxCompletionTokens:
            typeof m?.top_provider?.max_completion_tokens === "number"
              ? m.top_provider.max_completion_tokens
              : null,
        });
      }
      cache = { at: Date.now(), entries };
      return entries;
    } catch {
      // Stale beats nothing; nothing beats throwing.
      return cache?.entries ?? new Map<string, OpenRouterEntry>();
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
