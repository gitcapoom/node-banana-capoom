/**
 * fal.ai → NormalizedSchema.
 *
 * Fetches the OpenAPI for a model using fal's Model Search API:
 *   GET https://api.fal.ai/v1/models?endpoint_id={modelId}&expand=openapi-3.0
 *
 * The response shape is `{ models: [{ openapi: {...} }] }`. We walk `spec.paths`
 * to find the POST endpoint's requestBody, resolve any `$ref` against
 * `spec.components.schemas`, then hand the Input schema to the generic
 * OpenAPI normalizer.
 *
 * Returns `null` on failure so the pipeline can fall back to slug/static schemas.
 */

import type { NormalizedSchema } from "../types";
import { normalizeOpenApiSchema } from "./openapi";

const FAL_TIMEOUT_MS = 15_000;

/**
 * Fetch raw OpenAPI spec for a fal.ai model.
 * Shape: `{ openapi: {...}, ... }` — only the `openapi` field is used.
 */
export async function fetchFalRawSpec(
  modelId: string,
  apiKey: string | null
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Key ${apiKey}`;

  const url = `https://api.fal.ai/v1/models?endpoint_id=${encodeURIComponent(
    modelId
  )}&expand=openapi-3.0`;

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FAL_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      models?: Array<{ openapi?: Record<string, unknown> }>;
    };
    return data.models?.[0]?.openapi ?? null;
  } catch {
    return null;
  }
}

/**
 * Given a fal.ai OpenAPI spec, find the Input schema (POST requestBody) and
 * return it as a NormalizedSchema.
 */
export function normalizeFalSpec(spec: Record<string, unknown>): NormalizedSchema | null {
  const components = ((spec.components as Record<string, unknown> | undefined)?.schemas) as
    | Record<string, unknown>
    | undefined;

  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;

  for (const pathObj of Object.values(paths)) {
    const postOp = (pathObj as Record<string, unknown>).post as Record<string, unknown> | undefined;
    const reqBody = postOp?.requestBody as Record<string, unknown> | undefined;
    const content = reqBody?.content as Record<string, Record<string, unknown>> | undefined;
    const jsonContent = content?.["application/json"];
    if (!jsonContent?.schema) continue;

    let inputSchema = jsonContent.schema as Record<string, unknown>;

    // Resolve top-level $ref
    if (typeof inputSchema.$ref === "string" && components) {
      const refPath = inputSchema.$ref.replace("#/components/schemas/", "");
      const resolved = components[refPath] as Record<string, unknown> | undefined;
      if (resolved) inputSchema = resolved;
    }

    if (inputSchema.properties) {
      return normalizeOpenApiSchema(inputSchema, components);
    }
  }

  return null;
}

/**
 * End-to-end: fetch fal spec + normalize. Returns null on any failure.
 */
export async function fetchAndNormalizeFal(
  modelId: string,
  apiKey: string | null
): Promise<NormalizedSchema | null> {
  const spec = await fetchFalRawSpec(modelId, apiKey);
  if (!spec) return null;
  return normalizeFalSpec(spec);
}
