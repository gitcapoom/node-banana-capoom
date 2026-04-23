/**
 * WaveSpeed playground scraper.
 *
 * WaveSpeed's api_schema (via /api/v3/models) is the same JSON the playground
 * renders, so the playground isn't a meaningful secondary source. Stub out
 * for pipeline uniformity.
 */

import type { PlaygroundScrapeResult } from "./types";

export async function scrapeWaveSpeedPlayground(
  modelId: string
): Promise<PlaygroundScrapeResult> {
  return {
    fields: [],
    url: `https://wavespeed.ai/models/${modelId}`,
    scrapedAt: Date.now(),
    status: "empty",
  };
}
