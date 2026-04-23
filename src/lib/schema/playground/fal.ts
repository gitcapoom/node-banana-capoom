/**
 * fal.ai playground scraper.
 *
 * fal's playground pages (https://fal.ai/models/{endpoint_id}/api) are Next.js
 * server-rendered and embed a `__NEXT_DATA__` script that contains the full
 * OpenAPI spec used by the playground UI. That spec is a superset of the
 * public `expand=openapi-3.0` response in practice — it sometimes includes
 * preset object shapes (e.g. `image_size` with enum + object) the API version
 * omits.
 *
 * Strategy:
 *   1. Fetch the HTML page
 *   2. Look for the `__NEXT_DATA__` JSON blob
 *   3. Walk it looking for the OpenAPI paths/components
 *   4. Extract all property names under Input/request body
 *   5. Fall back to simple regex over the rendered HTML for field labels
 */

import type { PlaygroundScrapeResult } from "./types";

const FAL_TIMEOUT_MS = 20_000;
const UA = "Mozilla/5.0 (compatible; NodeBananaSchemaWarmer/1.0; +https://github.com/)";

function makeUrl(modelId: string): string {
  // Canonical playground URL. fal accepts both /models/{id}/api and /models/{id}.
  return `https://fal.ai/models/${encodeURI(modelId)}/api`;
}

/**
 * Recursively walk an object looking for property bags that look like
 * OpenAPI request schemas — objects with `properties: { ... }` whose values
 * have a `type` or `$ref` field. Returns all property keys found.
 */
function harvestSchemaPropertyNames(obj: unknown, acc: Set<string>, depth = 0): void {
  if (depth > 12 || !obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) harvestSchemaPropertyNames(item, acc, depth + 1);
    return;
  }

  const record = obj as Record<string, unknown>;
  const maybeProps = record.properties;
  if (maybeProps && typeof maybeProps === "object" && !Array.isArray(maybeProps)) {
    for (const [key, val] of Object.entries(maybeProps as Record<string, unknown>)) {
      if (val && typeof val === "object") {
        const v = val as Record<string, unknown>;
        // Looks like a schema definition
        if ("type" in v || "$ref" in v || "enum" in v || "anyOf" in v || "oneOf" in v) {
          acc.add(key);
        }
      }
    }
  }

  for (const val of Object.values(record)) {
    harvestSchemaPropertyNames(val, acc, depth + 1);
  }
}

/**
 * Extract parameter names from the HTML of a fal.ai playground page.
 * Returns a sorted, deduplicated list.
 */
export function extractFalFields(html: string): string[] {
  const fields = new Set<string>();

  // 1. Try __NEXT_DATA__ script
  const nextDataMatch = html.match(
    /<script\s+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      harvestSchemaPropertyNames(data, fields);
    } catch {
      // fall through
    }
  }

  // 2. Regex fallback: fal's playground renders labels like
  //    <label for="image_size">Image Size</label>
  //    <input name="prompt"
  const labelMatches = html.matchAll(/<label[^>]*for=["']([a-z_][a-z0-9_]*)["']/gi);
  for (const m of labelMatches) fields.add(m[1]);
  const nameMatches = html.matchAll(/\sname=["']([a-z_][a-z0-9_]*)["']/gi);
  for (const m of nameMatches) fields.add(m[1]);

  return [...fields].sort();
}

export async function scrapeFalPlayground(modelId: string): Promise<PlaygroundScrapeResult> {
  const url = makeUrl(modelId);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(FAL_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { fields: [], url, scrapedAt: Date.now(), status: "error", error: `HTTP ${res.status}` };
    }
    const html = await res.text();
    const fields = extractFalFields(html);
    return {
      fields,
      url,
      scrapedAt: Date.now(),
      status: fields.length > 0 ? "ok" : "empty",
    };
  } catch (e) {
    return {
      fields: [],
      url,
      scrapedAt: Date.now(),
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
