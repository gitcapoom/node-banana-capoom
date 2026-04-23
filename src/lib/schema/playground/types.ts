/**
 * Shared types for playground scrapers.
 */

export interface PlaygroundScrapeResult {
  /** Parameter names detected on the playground page (could be inputs or params). */
  fields: string[];
  /** Source URL of the scrape. */
  url: string;
  /** Millis when scrape completed. */
  scrapedAt: number;
  /** "ok" on success, "empty" if the page loaded but no fields detected, "error" on failure. */
  status: "ok" | "empty" | "error";
  /** Error message when status === "error". */
  error?: string;
}

/**
 * Shape of every provider scraper: takes a modelId, resolves to a result.
 * Scrapers MUST NOT throw — they should return status="error" and log.
 */
export type PlaygroundScraper = (modelId: string) => Promise<PlaygroundScrapeResult>;
