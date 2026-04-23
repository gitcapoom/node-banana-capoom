/**
 * Replicate → NormalizedSchema.
 *
 * Replicate stores its OpenAPI schema at `GET /v1/models/{owner}/{name}`
 * under `latest_version.openapi_schema.components.schemas.Input`.
 *
 * Unlike fal, the Input object is always at a known path — no need to
 * scan `paths`. We just resolve $refs against `components.schemas`.
 */

import type { NormalizedSchema } from "../types";
import { normalizeOpenApiSchema } from "./openapi";

const REPLICATE_TIMEOUT_MS = 15_000;

interface ReplicateModelResponse {
  latest_version?: {
    openapi_schema?: {
      components?: {
        schemas?: Record<string, unknown> & {
          Input?: Record<string, unknown>;
        };
      };
    };
  };
}

/**
 * Fetch raw model metadata from Replicate. Returns null on failure.
 */
export async function fetchReplicateRaw(
  modelId: string,
  apiKey: string
): Promise<ReplicateModelResponse | null> {
  const [owner, name] = modelId.split("/");
  if (!owner || !name) return null;

  try {
    const response = await fetch(`https://api.replicate.com/v1/models/${owner}/${name}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REPLICATE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as ReplicateModelResponse;
  } catch {
    return null;
  }
}

/**
 * Extract the Input schema from Replicate's raw model response + normalize.
 */
export function normalizeReplicateRaw(
  raw: ReplicateModelResponse
): NormalizedSchema | null {
  const openapi = raw.latest_version?.openapi_schema;
  const components = openapi?.components?.schemas;
  const inputSchema = components?.Input;
  if (!inputSchema || typeof inputSchema !== "object") return null;

  return normalizeOpenApiSchema(
    inputSchema as Record<string, unknown>,
    components as Record<string, unknown> | undefined
  );
}

/**
 * End-to-end: fetch + normalize.
 */
export async function fetchAndNormalizeReplicate(
  modelId: string,
  apiKey: string
): Promise<NormalizedSchema | null> {
  const raw = await fetchReplicateRaw(modelId, apiKey);
  if (!raw) return null;
  return normalizeReplicateRaw(raw);
}
