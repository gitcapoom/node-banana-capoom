/**
 * Google's own per-model metadata.
 *
 * Lives in lib, not in the route, because /api/llm and /api/models both need it
 * and a route module importing another ROUTE module is a build-graph hazard in
 * Next: route files are entry points, not libraries.
 */

export interface GoogleModelMeta {
  temperature?: number;
  maxTemperature?: number;
  topP?: number;
  topK?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  thinking?: boolean;
}

export interface ModelEntry {
  id: string;
  label: string;
  meta?: GoogleModelMeta;
}

/** Human-readable label generator for raw IDs (when the source has no display name). */
export function prettyLabel(id: string): string {
  // "gemini-2.5-flash" → "Gemini 2.5 Flash"
  // "gpt-4.1-mini" → "GPT 4.1 Mini"
  // "claude-sonnet-4-5-20250929" → "Claude Sonnet 4 5 20250929"
  return id
    .split(/[-_]/)
    .map((w) => (/^gpt$/i.test(w) ? "GPT" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export async function fetchGoogle(apiKey: string): Promise<ModelEntry[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google models: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  type GoogleModel = {
    name?: string; displayName?: string; supportedGenerationMethods?: string[];
    // Present on every chat model and previously discarded. `temperature` is the
    // model's DEFAULT; `maxTemperature` its ceiling — for gemini-2.5-flash that
    // is 1 and 2, against the node's hardcoded 0.7 and 2.
    temperature?: number; maxTemperature?: number; topP?: number; topK?: number;
    inputTokenLimit?: number; outputTokenLimit?: number; thinking?: boolean;
  };
  const models: GoogleModel[] = Array.isArray(data?.models) ? data.models : [];
  return models
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => {
      // "models/gemini-2.5-flash" → "gemini-2.5-flash"
      const rawName = m.name || "";
      const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
      const meta: GoogleModelMeta = {};
      if (typeof m.temperature === "number") meta.temperature = m.temperature;
      if (typeof m.maxTemperature === "number") meta.maxTemperature = m.maxTemperature;
      if (typeof m.topP === "number") meta.topP = m.topP;
      if (typeof m.topK === "number") meta.topK = m.topK;
      if (typeof m.inputTokenLimit === "number") meta.inputTokenLimit = m.inputTokenLimit;
      if (typeof m.outputTokenLimit === "number") meta.outputTokenLimit = m.outputTokenLimit;
      if (typeof m.thinking === "boolean") meta.thinking = m.thinking;
      return {
        id,
        label: m.displayName || prettyLabel(id),
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
      };
    })
    .filter((m) => m.id.length > 0);
}

/**
 * Per-model metadata for ONE Google model, for the schema route.
 *
 * Google is the only one of the three that publishes this, and it is
 * authoritative about its own ranges — so where it disagrees with a third-party
 * catalogue, it wins. Returns null rather than throwing: a metadata lookup must
 * never be the reason a node fails to render its controls.
 */
export async function getGoogleModelMeta(
  modelId: string,
  apiKey: string | undefined,
): Promise<GoogleModelMeta | null> {
  if (!apiKey || !modelId) return null;
  try {
    const entries = await fetchGoogle(apiKey);
    return entries.find((e) => e.id === modelId)?.meta ?? null;
  } catch {
    return null;
  }
}
