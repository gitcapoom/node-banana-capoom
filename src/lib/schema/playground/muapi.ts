/**
 * muapi.ai playground scraper.
 *
 * muapi exposes `https://api.muapi.ai/openapi.json` with every model's request
 * schema, which we already consume. The playground page is SSR'd HTML but the
 * form field names always mirror the OpenAPI shape. Stub for uniformity.
 */

import type { PlaygroundScrapeResult } from "./types";

export async function scrapeMuapiPlayground(
  modelId: string
): Promise<PlaygroundScrapeResult> {
  return {
    fields: [],
    url: `https://muapi.ai/playground/${modelId}`,
    scrapedAt: Date.now(),
    status: "empty",
  };
}
