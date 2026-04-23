/**
 * muapi.ai → NormalizedSchema.
 *
 * muapi publishes a single OpenAPI document at `https://api.muapi.ai/openapi.json`
 * with every model's endpoint as a path. Each endpoint has its own requestBody
 * schema. We fetch the spec once (cached 24h in-memory), look up
 * `/api/v1/{modelId}`, and resolve the request body schema against
 * `components.schemas` before normalizing.
 *
 * If the exact modelId path isn't found we return `null` so the caller can fall
 * back to the slug-based static schema.
 */

import type { NormalizedSchema } from "../types";
import { normalizeOpenApiSchema } from "./openapi";

const MUAPI_OPENAPI_URL = "https://api.muapi.ai/openapi.json";
const MUAPI_TIMEOUT_MS = 15_000;
const MUAPI_SPEC_TTL_MS = 24 * 60 * 60 * 1000; // 24h

let cachedSpec: { spec: Record<string, unknown>; timestamp: number } | null = null;

export async function fetchMuapiOpenApiSpec(): Promise<Record<string, unknown> | null> {
  if (cachedSpec && Date.now() - cachedSpec.timestamp < MUAPI_SPEC_TTL_MS) {
    return cachedSpec.spec;
  }

  try {
    const resp = await fetch(MUAPI_OPENAPI_URL, {
      signal: AbortSignal.timeout(MUAPI_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const spec = (await resp.json()) as Record<string, unknown>;
    cachedSpec = { spec, timestamp: Date.now() };
    return spec;
  } catch {
    return null;
  }
}

/** For testing/warmer: force a re-fetch next time. */
export function clearMuapiSpecCache(): void {
  cachedSpec = null;
}

/**
 * Look up a model's request schema in the muapi OpenAPI spec and normalize it.
 * Returns null if the path isn't present.
 */
export function normalizeMuapiModel(
  spec: Record<string, unknown>,
  modelId: string
): NormalizedSchema | null {
  const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return null;

  const pathKey = `/api/v1/${modelId.toLowerCase()}`;
  const pathDef = paths[pathKey];
  if (!pathDef) return null;

  const postDef = pathDef.post as Record<string, unknown> | undefined;
  const requestBody = postDef?.requestBody as Record<string, unknown> | undefined;
  const content = requestBody?.content as Record<string, Record<string, unknown>> | undefined;
  const jsonSchema = content?.["application/json"]?.schema as Record<string, unknown> | undefined;
  if (!jsonSchema) return null;

  const components = ((spec.components as Record<string, unknown> | undefined)?.schemas) as
    | Record<string, unknown>
    | undefined;

  // Resolve top-level $ref if present
  let schema: Record<string, unknown> = jsonSchema;
  if (typeof jsonSchema.$ref === "string") {
    const refPath = jsonSchema.$ref.replace(/^#\//, "").split("/");
    let resolved: unknown = spec;
    for (const part of refPath) {
      if (resolved && typeof resolved === "object" && part in (resolved as Record<string, unknown>)) {
        resolved = (resolved as Record<string, unknown>)[part];
      } else {
        resolved = null;
        break;
      }
    }
    if (!resolved || typeof resolved !== "object") return null;
    schema = resolved as Record<string, unknown>;
  }

  if (!schema.properties) return null;

  return normalizeOpenApiSchema(schema, components);
}

/**
 * End-to-end: fetch spec + normalize for a specific model. Returns null on any failure.
 */
export async function fetchAndNormalizeMuapi(modelId: string): Promise<NormalizedSchema | null> {
  const spec = await fetchMuapiOpenApiSpec();
  if (!spec) return null;
  return normalizeMuapiModel(spec, modelId);
}
