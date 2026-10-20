/**
 * The Unifically catalogue and per-model schemas, fetched at runtime.
 *
 * Nothing here is hardcoded. The model LIST is Unifically's own live
 * `GET /v1/models` (filtered to generation categories), so a model Unifically
 * enables appears without a code change and one it disables disappears. The
 * SCHEMAS come from its published docs (see parseDocs.ts), so a new model's
 * parameters arrive with its docs page.
 *
 * The two can disagree — the docs describe models a key cannot use, and a few
 * live models have no page — and the live list wins: an undocumented model is
 * still listed, it just gets no schema here and falls back to generic pins.
 */

import type { ModelCapability, ProviderModel } from "@/lib/providers/types";
import type { ExtractedResult, NormalizedSchema } from "@/lib/schema/types";
import { extractFromNormalized } from "@/lib/schema/extract";
import { buildSchemaIndex } from "./parseDocs";

export const UNIFICALLY_API_BASE = "https://api.unifically.com";
const DOCS_FULL = "https://docs.unifically.com/llms-full.txt";
const MODELS_TTL = 60 * 60 * 1000; // 1h — the catalogue moves faster than docs
const DOCS_TTL = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 30_000;

const CATEGORY_CAPABILITIES: Record<string, ModelCapability[]> = {
  video: ["text-to-video", "image-to-video"],
  image: ["text-to-image", "image-to-image"],
  audio: ["text-to-audio"],
};

interface LiveModel {
  id: string;
  display_name?: string;
  provider_display?: string;
  category?: string;
}

let modelsCache: { key: string; at: number; models: ProviderModel[] } | null = null;
let docsCache: { at: number; index: Map<string, NormalizedSchema> } | null = null;
let docsInFlight: Promise<Map<string, NormalizedSchema> | null> | null = null;

export function toProviderModel(m: LiveModel): ProviderModel | null {
  const capabilities = CATEGORY_CAPABILITIES[m.category ?? ""];
  if (!capabilities) return null; // llm, or anything not generation
  const name = m.display_name || m.id;
  // Append the provider only when the name does not already say it
  // ("ElevenLabs Audio Isolation" stays as is; "Eleven v4" gains "(ElevenLabs)").
  const showProvider = m.provider_display && !name.toLowerCase().includes(m.provider_display.toLowerCase());
  return {
    id: m.id,
    name: showProvider ? `${name} (${m.provider_display})` : name,
    description: `Unifically · ${m.category}`,
    provider: "unifically",
    capabilities,
  };
}

/** Live generation catalogue for this key. Previous good result on failure. */
export async function getUnificallyModels(apiKey: string): Promise<ProviderModel[]> {
  if (modelsCache && modelsCache.key === apiKey && Date.now() - modelsCache.at < MODELS_TTL) {
    return modelsCache.models;
  }
  try {
    const resp = await fetch(`${UNIFICALLY_API_BASE}/v1/models?category=video,image,audio`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`models ${resp.status}`);
    const json = (await resp.json()) as { data?: LiveModel[] };
    const models = (json.data ?? []).map(toProviderModel).filter((m): m is ProviderModel => !!m);
    modelsCache = { key: apiKey, at: Date.now(), models };
    return models;
  } catch (err) {
    console.warn("[unifically] model list unavailable:", err instanceof Error ? err.message : err);
    return modelsCache?.key === apiKey ? modelsCache.models : [];
  }
}

/**
 * Model id → schema, parsed from llms-full.txt. Cached for a day; concurrent
 * callers share one fetch; on failure the previous index is kept.
 *
 * Only a text/plain response is trusted. A docs host can answer a bad path
 * with an HTML page that parses to zero models — indistinguishable from a real
 * empty answer — so content type is checked rather than assumed.
 */
export async function getUnificallySchemaIndex(): Promise<Map<string, NormalizedSchema> | null> {
  if (docsCache && Date.now() - docsCache.at < DOCS_TTL) return docsCache.index;
  if (!docsInFlight) {
    docsInFlight = (async () => {
      try {
        const resp = await fetch(DOCS_FULL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
        const ctype = resp.headers.get("content-type") ?? "";
        if (!resp.ok || !ctype.includes("text/plain")) throw new Error(`docs ${resp.status} ${ctype}`);
        const index = buildSchemaIndex(await resp.text());
        if (index.size === 0) throw new Error("docs parsed to zero models");
        docsCache = { at: Date.now(), index };
        return index;
      } catch (err) {
        console.warn("[unifically] docs unavailable:", err instanceof Error ? err.message : err);
        return docsCache?.index ?? null;
      } finally {
        docsInFlight = null;
      }
    })();
  }
  return docsInFlight;
}

/** Pins and settings for one model, or null when the docs do not describe it. */
export async function getUnificallySchema(modelId: string): Promise<ExtractedResult | null> {
  const index = await getUnificallySchemaIndex();
  const schema = index?.get(modelId);
  return schema ? extractFromNormalized(schema) : null;
}

/** Raw normalized schema — the provider uses it to place the prompt and shape arrays. */
export async function getUnificallyNormalizedSchema(modelId: string): Promise<NormalizedSchema | null> {
  return (await getUnificallySchemaIndex())?.get(modelId) ?? null;
}

export function clearUnificallyCaches(): void {
  modelsCache = null;
  docsCache = null;
  docsInFlight = null;
}
