/**
 * Replicate playground scraper.
 *
 * Replicate's `GET /v1/models/{owner}/{name}` already returns the exact OpenAPI
 * schema the playground uses, and we already query it in the normalize path.
 * So this scraper is a no-op by default — the playground can't reveal fields
 * the API doesn't already.
 *
 * If we ever want to cross-check (e.g. catch schema drift between API and
 * playground), hit `https://replicate.com/{owner}/{name}/api/schema` and
 * parse the same JSON. For now we return `empty` so merge logic treats
 * Replicate as authoritative.
 */

import type { PlaygroundScrapeResult } from "./types";

export async function scrapeReplicatePlayground(
  modelId: string
): Promise<PlaygroundScrapeResult> {
  return {
    fields: [],
    url: `https://replicate.com/${modelId}`,
    scrapedAt: Date.now(),
    status: "empty",
  };
}
