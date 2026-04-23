/**
 * fal.ai playground scraper.
 *
 * fal.ai's playground pages (https://fal.ai/models/{endpoint_id}) are rendered
 * with React Server Components and stream data via `self.__next_f.push(...)`
 * script blocks. Each chunk is a JSON string that, among other things,
 * carries the initialInput / schema objects the UI uses to render its form.
 *
 * Strategy:
 *   1. Fetch the HTML page
 *   2. Quick-reject pages that are obviously errors (no `__next_f.push`, or
 *      contain `__next_error__` / 404 markers)
 *   3. Extract every `self.__next_f.push([1, "..."])` payload, JSON-decode it
 *      (they're escaped strings), and walk the tree for schema-like objects
 *   4. Harvest property names ONLY from objects that look like OpenAPI
 *      request schemas (`properties: { key: { type | $ref | enum | anyOf } }`)
 *      — we never scrape loose `name=` attributes or meta tags, because those
 *      drag in `<meta name="viewport">`, `<meta name="robots">`, etc.
 */

import type { PlaygroundScrapeResult } from "./types";

const FAL_TIMEOUT_MS = 20_000;
const UA = "Mozilla/5.0 (compatible; NodeBananaSchemaWarmer/1.0; +https://github.com/)";

function makeUrl(modelId: string): string {
  // Canonical playground URL; no /api suffix (that's a 404).
  return `https://fal.ai/models/${modelId.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Recursively walk an object looking for property bags that look like
 * OpenAPI request schemas — objects with `properties: { ... }` whose values
 * have a `type` or `$ref` field. Adds all such property keys to `acc`.
 */
function harvestSchemaPropertyNames(obj: unknown, acc: Set<string>, depth = 0): void {
  if (depth > 16 || !obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) harvestSchemaPropertyNames(item, acc, depth + 1);
    return;
  }

  const record = obj as Record<string, unknown>;
  const maybeProps = record.properties;
  if (maybeProps && typeof maybeProps === "object" && !Array.isArray(maybeProps)) {
    for (const [key, val] of Object.entries(maybeProps as Record<string, unknown>)) {
      // Only accept schema-shaped values. Anything else (React metadata,
      // page props, etc.) is ignored.
      if (val && typeof val === "object") {
        const v = val as Record<string, unknown>;
        if (
          "type" in v ||
          "$ref" in v ||
          "enum" in v ||
          "anyOf" in v ||
          "oneOf" in v ||
          "allOf" in v
        ) {
          // Key itself must look like an OpenAPI property name.
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) acc.add(key);
        }
      }
    }
  }

  for (const val of Object.values(record)) {
    harvestSchemaPropertyNames(val, acc, depth + 1);
  }
}

/**
 * Decode every `self.__next_f.push([1, "..."])` payload from the HTML,
 * JSON-parse the embedded string, and harvest schema property names from it.
 *
 * Returns the combined sorted set of names.
 */
export function extractFalFields(html: string): string[] {
  // Error-page heuristic: fal's RSC error page has no content chunks.
  if (html.includes("__next_error__")) return [];

  const fields = new Set<string>();

  const pushRe = /self\.__next_f\.push\(\[1,\s*"((?:\\"|[^"])*)"\]\)/g;
  let m: RegExpExecArray | null;
  let chunks = 0;
  while ((m = pushRe.exec(html)) !== null) {
    chunks++;
    const escaped = m[1];
    let decoded: string;
    try {
      // The payload is a JSON-encoded string (already escaped). Wrap in quotes
      // and parse once to resolve \n / \" / \\.
      decoded = JSON.parse(`"${escaped}"`);
    } catch {
      continue;
    }
    // Each chunk may contain multiple embedded JSON fragments. Scan for them.
    const jsonRe = /(\{[\s\S]*?"properties"[\s\S]*?\})/g;
    let j: RegExpExecArray | null;
    while ((j = jsonRe.exec(decoded)) !== null) {
      const candidate = j[1];
      // Try to parse progressively larger slices until we get a valid object.
      for (let len = candidate.length; len > 50; len -= 50) {
        try {
          const parsed = JSON.parse(candidate.slice(0, len));
          harvestSchemaPropertyNames(parsed, fields);
          break;
        } catch {
          // try smaller
        }
      }
    }
  }

  // If we never saw any `__next_f.push`, the page wasn't what we expected.
  if (chunks === 0) return [];

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
