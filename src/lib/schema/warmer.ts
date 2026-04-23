/**
 * Schema warmer — orchestrates full normalize + scrape + merge across all
 * provider models, writes results to the disk cache.
 *
 * Run modes:
 *   - `warmAllSchemas()` — enumerates every configured provider and every
 *     model from its list endpoint. Invoked from server.js on startup and
 *     every 24h after.
 *   - `warmModelSchema(provider, modelId)` — on-demand refresh for a single
 *     model. Called from `GET /api/models/:modelId` when the disk cache
 *     misses or is older than the TTL.
 *
 * Design constraints:
 *   - Global concurrency limit (default 8) to avoid rate-limiting upstream
 *     APIs and ourselves.
 *   - Per-host jitter (200ms) between requests to the same playground host.
 *   - Single-model failure never aborts the run — we log and keep going.
 *   - If a model has a previously-cached entry and this run fails, we keep
 *     the stale entry on disk (don't write garbage).
 */

import type { ProviderType } from "@/types";
import type { ExtractedResult } from "./types";
import { extractFromNormalized } from "./extract";
import { mergePlaygroundFields } from "./merge";
import { scrapePlayground, type PlaygroundScrapeResult } from "./playground";
import { writeCachedSchema, readCachedSchema } from "./diskCache";

import { fetchAndNormalizeFal } from "./normalize/fal";
import { fetchAndNormalizeReplicate } from "./normalize/replicate";
import { fetchAndNormalizeWaveSpeed } from "./normalize/wavespeed";
import { fetchAndNormalizeMuapi } from "./normalize/muapi";

import {
  getKieStaticSchema,
  getGeminiStaticSchema,
  getWaveSpeedStaticSchema,
  getMuapiSlugSchema,
} from "./static";

// ---------------- Types ----------------

export interface WarmOptions {
  /** Max concurrent requests across all providers. Default 8. */
  concurrency?: number;
  /** If true, refresh even models that already have cache entries. Default true on full warm. */
  force?: boolean;
  /** Called with progress updates (completed / total). */
  onProgress?: (completed: number, total: number, current?: string) => void;
}

export interface WarmReport {
  total: number;
  successful: number;
  failed: number;
  playgroundAugmented: number;
  durationMs: number;
  perProvider: Record<string, {
    total: number;
    successful: number;
    failed: number;
  }>;
}

export interface WarmTask {
  provider: ProviderType;
  modelId: string;
}

// ---------------- Per-model warm ----------------

/**
 * Extraction opts — controls error handling.
 */
export interface WarmModelOpts {
  /** If true, re-throw extraction errors instead of swallowing. Default false. */
  strict?: boolean;
  /** If true, treat missing API keys as errors (throw). Default false. */
  requireApiKey?: boolean;
}

/**
 * Extract a single model's schema: normalize → extract → scrape → merge.
 * Returns the ExtractedResult, or `null` if extraction failed entirely.
 *
 * With `opts.strict=true` any error from the normalizer propagates, letting
 * the caller (e.g. an on-demand API route) convert it into a 5xx response.
 * Without strict mode we log + return null, which is what the bulk warmer
 * wants.
 */
export async function warmModelSchema(
  provider: ProviderType,
  modelId: string,
  apiKeys: Partial<Record<ProviderType, string>> = {},
  opts: WarmModelOpts = {}
): Promise<ExtractedResult | null> {
  let extracted: ExtractedResult | null = null;
  const { strict = false, requireApiKey = false } = opts;

  const missingKey = (p: ProviderType): boolean => {
    switch (p) {
      case "replicate": return !apiKeys.replicate;
      default: return false;
    }
  };
  if (requireApiKey && missingKey(provider)) {
    throw new Error(`${provider} API key required`);
  }

  // Step 1: provider-specific normalize + extract.
  try {
    switch (provider) {
      case "fal": {
        const normalized = await fetchAndNormalizeFal(modelId, apiKeys.fal ?? null);
        if (normalized) extracted = extractFromNormalized(normalized);
        break;
      }
      case "replicate": {
        if (apiKeys.replicate) {
          const normalized = await fetchAndNormalizeReplicate(modelId, apiKeys.replicate);
          if (normalized) extracted = extractFromNormalized(normalized);
        } else if (strict) {
          throw new Error("Replicate API key required");
        }
        break;
      }
      case "wavespeed": {
        const normalized = await fetchAndNormalizeWaveSpeed(
          modelId,
          apiKeys.wavespeed ?? null
        );
        if (normalized) extracted = extractFromNormalized(normalized);
        if (!extracted) extracted = getWaveSpeedStaticSchema(modelId);
        break;
      }
      case "muapi": {
        const normalized = await fetchAndNormalizeMuapi(modelId);
        if (normalized) extracted = extractFromNormalized(normalized);
        if (!extracted) extracted = getMuapiSlugSchema(modelId);
        break;
      }
      case "kie":
        extracted = getKieStaticSchema(modelId);
        break;
      case "gemini":
        extracted = getGeminiStaticSchema(modelId);
        break;
    }
  } catch (err) {
    if (strict) throw err;
    console.warn(`[schema warmer] ${provider}:${modelId} extraction error:`, err);
  }

  if (!extracted) return null;

  // Step 2: playground scrape + merge. Never fail the whole warm on a scrape error.
  let scraped: PlaygroundScrapeResult;
  try {
    scraped = await scrapePlayground(provider, modelId);
  } catch (err) {
    scraped = {
      fields: [],
      url: "",
      scrapedAt: Date.now(),
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return mergePlaygroundFields(extracted, scraped);
}

// ---------------- Concurrency helpers ----------------

/**
 * Run tasks with a hard concurrency cap. Uses Promise.all of workers that
 * each pop from a shared queue.
 */
async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  concurrency: number
): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, queue.length); w++) {
    workers.push(
      (async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          try {
            await worker(next.item, next.index);
          } catch (err) {
            console.warn(`[warmer] worker error at index ${next.index}:`, err);
          }
        }
      })()
    );
  }
  await Promise.all(workers);
}

// ---------------- Model list fetchers ----------------

const REPLICATE_API_BASE = "https://api.replicate.com/v1";
const FAL_API_BASE = "https://api.fal.ai/v1";
const WAVESPEED_API_BASE = "https://api.wavespeed.ai/api/v3";
const PER_LIST_TIMEOUT_MS = 30_000;

interface RawModelListItem {
  id: string;
  provider: ProviderType;
}

async function listReplicateModels(apiKey: string): Promise<RawModelListItem[]> {
  const results: RawModelListItem[] = [];
  let url: string | null = `${REPLICATE_API_BASE}/models`;
  let pages = 0;
  while (url && pages < 15) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PER_LIST_TIMEOUT_MS),
    });
    if (!res.ok) break;
    const data = await res.json() as {
      next: string | null;
      results: Array<{ owner: string; name: string }>;
    };
    for (const m of data.results) {
      results.push({ id: `${m.owner}/${m.name}`, provider: "replicate" });
    }
    url = data.next;
    pages++;
  }
  return results;
}

async function listFalModels(apiKey: string | null): Promise<RawModelListItem[]> {
  const results: RawModelListItem[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  let pages = 0;
  const headers: HeadersInit = {};
  if (apiKey) headers["Authorization"] = `Key ${apiKey}`;
  while (hasMore && pages < 15) {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    const res = await fetch(`${FAL_API_BASE}/models${qs ? `?${qs}` : ""}`, {
      headers,
      signal: AbortSignal.timeout(PER_LIST_TIMEOUT_MS),
    });
    if (!res.ok) break;
    const data = await res.json() as {
      models: Array<{ endpoint_id: string }>;
      next_cursor: string | null;
      has_more: boolean;
    };
    for (const m of data.models) {
      results.push({ id: m.endpoint_id, provider: "fal" });
    }
    cursor = data.next_cursor;
    hasMore = data.has_more;
    pages++;
  }
  return results;
}

async function listWaveSpeedModels(apiKey: string): Promise<RawModelListItem[]> {
  const res = await fetch(`${WAVESPEED_API_BASE}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(PER_LIST_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const data = await res.json() as {
    models?: Array<Record<string, unknown>>;
    data?: Array<Record<string, unknown>>;
    results?: Array<Record<string, unknown>>;
  };
  const models = data.models || data.data || data.results || [];
  return models
    .map((m) => (m.model_id || m.id || m.modelId || m.name) as string | undefined)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => ({ id, provider: "wavespeed" as ProviderType }));
}

async function listStaticModels(
  provider: ProviderType
): Promise<RawModelListItem[]> {
  if (provider === "kie") {
    const { KIE_MODELS_LIST } = await import("./staticModelLists");
    return KIE_MODELS_LIST.map((id) => ({ id, provider }));
  }
  if (provider === "gemini") {
    const { GEMINI_MODELS_LIST } = await import("./staticModelLists");
    return GEMINI_MODELS_LIST.map((id) => ({ id, provider }));
  }
  if (provider === "muapi") {
    const { MUAPI_MODELS } = await import("@/lib/providers/muapi");
    return MUAPI_MODELS.map((m) => ({ id: m.id, provider }));
  }
  return [];
}

// ---------------- Top-level warm ----------------

/**
 * Enumerate all providers with available API keys and warm every model.
 */
export async function warmAllSchemas(opts?: WarmOptions): Promise<WarmReport> {
  const concurrency = opts?.concurrency ?? 8;
  const force = opts?.force ?? true;

  const apiKeys: Partial<Record<ProviderType, string>> = {
    replicate: process.env.REPLICATE_API_KEY ?? undefined,
    fal: process.env.FAL_API_KEY ?? undefined,
    wavespeed: process.env.WAVESPEED_API_KEY ?? undefined,
    kie: process.env.KIE_API_KEY ?? undefined,
    muapi: process.env.MUAPI_API_KEY ?? undefined,
  };

  const startedAt = Date.now();

  // 1. Enumerate model lists in parallel.
  const listTasks: Array<Promise<RawModelListItem[]>> = [];

  if (apiKeys.replicate) listTasks.push(listReplicateModels(apiKeys.replicate).catch(() => []));
  listTasks.push(listFalModels(apiKeys.fal ?? null).catch(() => []));
  if (apiKeys.wavespeed) listTasks.push(listWaveSpeedModels(apiKeys.wavespeed).catch(() => []));
  if (apiKeys.kie) listTasks.push(listStaticModels("kie").catch(() => []));
  listTasks.push(listStaticModels("gemini").catch(() => []));
  if (apiKeys.muapi) listTasks.push(listStaticModels("muapi").catch(() => []));

  const listed = (await Promise.all(listTasks)).flat();
  const tasks: WarmTask[] = listed.map(({ id, provider }) => ({ provider, modelId: id }));

  console.log(`[schema warmer] Starting: ${tasks.length} models across providers`);

  // 2. Execute with concurrency cap.
  const perProvider: WarmReport["perProvider"] = {};
  let successful = 0;
  let failed = 0;
  let playgroundAugmented = 0;
  let completed = 0;

  await runWithConcurrency(
    tasks,
    async ({ provider, modelId }) => {
      const key = provider;
      if (!perProvider[key]) perProvider[key] = { total: 0, successful: 0, failed: 0 };
      perProvider[key].total++;

      // Skip if forced=false and we already have an entry.
      if (!force) {
        const existing = await readCachedSchema(provider, modelId);
        if (existing) {
          perProvider[key].successful++;
          successful++;
          completed++;
          opts?.onProgress?.(completed, tasks.length, `${provider}:${modelId}`);
          return;
        }
      }

      const extracted = await warmModelSchema(provider, modelId, apiKeys);
      completed++;

      if (!extracted) {
        perProvider[key].failed++;
        failed++;
        opts?.onProgress?.(completed, tasks.length, `${provider}:${modelId}`);
        return;
      }

      try {
        await writeCachedSchema(provider, modelId, extracted);
        perProvider[key].successful++;
        successful++;
        if (extracted.health.status === "playground-augmented") playgroundAugmented++;
      } catch (err) {
        console.warn(`[schema warmer] disk write failed for ${provider}:${modelId}:`, err);
        perProvider[key].failed++;
        failed++;
      }
      opts?.onProgress?.(completed, tasks.length, `${provider}:${modelId}`);
    },
    concurrency
  );

  const report: WarmReport = {
    total: tasks.length,
    successful,
    failed,
    playgroundAugmented,
    durationMs: Date.now() - startedAt,
    perProvider,
  };

  console.log(
    `[schema warmer] Done: ${successful}/${tasks.length} ok, ` +
    `${failed} failed, ${playgroundAugmented} playground-augmented, ` +
    `${(report.durationMs / 1000).toFixed(1)}s`
  );

  return report;
}
