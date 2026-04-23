/**
 * Dispatch to the right playground scraper per provider.
 */

import type { ProviderType } from "@/types";
import type { PlaygroundScrapeResult } from "./types";
import { scrapeFalPlayground } from "./fal";
import { scrapeReplicatePlayground } from "./replicate";
import { scrapeWaveSpeedPlayground } from "./wavespeed";
import { scrapeMuapiPlayground } from "./muapi";

export type { PlaygroundScrapeResult } from "./types";

export async function scrapePlayground(
  provider: ProviderType,
  modelId: string
): Promise<PlaygroundScrapeResult> {
  switch (provider) {
    case "fal":
      return scrapeFalPlayground(modelId);
    case "replicate":
      return scrapeReplicatePlayground(modelId);
    case "wavespeed":
      return scrapeWaveSpeedPlayground(modelId);
    case "muapi":
      return scrapeMuapiPlayground(modelId);
    default:
      return {
        fields: [],
        url: "",
        scrapedAt: Date.now(),
        status: "empty",
      };
  }
}
