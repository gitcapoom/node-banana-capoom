/**
 * WaveSpeed → NormalizedSchema.
 *
 * WaveSpeed exposes a proprietary `api_schema` wrapper on each model listed by
 * `GET /api/v3/models`. The actual OpenAPI-like request schema is:
 *   apiSchema.api_schemas[0].request_schema
 *
 * There are no `components` / `$ref` in practice, but we still feed it through
 * the generic OpenAPI normalizer to handle `anyOf`/`oneOf`/allOf defensively.
 *
 * Model discovery reuses the existing cached list; if not present we fetch
 * `/api/v3/models` fresh.
 */

import type { NormalizedSchema } from "../types";
import { normalizeOpenApiSchema } from "./openapi";
import {
  getCachedWaveSpeedSchema,
  setCachedWaveSpeedSchema,
  type WaveSpeedApiSchema,
} from "@/lib/providers/cache";

const WAVESPEED_API_BASE = "https://api.wavespeed.ai/api/v3";
const WAVESPEED_TIMEOUT_MS = 15_000;

/**
 * Fetch the raw WaveSpeed api_schema for a model. Uses the shared cache first,
 * then falls back to `/api/v3/models` if an API key is provided.
 */
export async function fetchWaveSpeedRaw(
  modelId: string,
  apiKey: string | null
): Promise<WaveSpeedApiSchema | null> {
  const cached = getCachedWaveSpeedSchema(modelId);
  if (cached) return cached;

  if (!apiKey) return null;

  try {
    const response = await fetch(`${WAVESPEED_API_BASE}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(WAVESPEED_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const data = await response.json();
    const models: Array<Record<string, unknown>> =
      (data.models || data.data || data.results || []) as Array<Record<string, unknown>>;

    const model = models.find((m) => {
      const id = m.model_id || m.id || m.modelId || m.name;
      return id === modelId;
    });

    const apiSchema = model?.api_schema as WaveSpeedApiSchema | undefined;
    if (apiSchema) {
      setCachedWaveSpeedSchema(modelId, apiSchema);
      return apiSchema;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Convert a WaveSpeed api_schema wrapper → NormalizedSchema.
 */
export function normalizeWaveSpeedRaw(apiSchema: WaveSpeedApiSchema): NormalizedSchema | null {
  const apiSchemas = apiSchema.api_schemas;
  if (!Array.isArray(apiSchemas) || apiSchemas.length === 0) return null;

  const requestSchema = apiSchemas[0]?.request_schema;
  if (!requestSchema || typeof requestSchema !== "object") return null;

  return normalizeOpenApiSchema(requestSchema as Record<string, unknown>);
}

/**
 * End-to-end: fetch + normalize.
 */
export async function fetchAndNormalizeWaveSpeed(
  modelId: string,
  apiKey: string | null
): Promise<NormalizedSchema | null> {
  const raw = await fetchWaveSpeedRaw(modelId, apiKey);
  if (!raw) return null;
  return normalizeWaveSpeedRaw(raw);
}
