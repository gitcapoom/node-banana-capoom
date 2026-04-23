/**
 * Disk cache for extracted model schemas.
 *
 * Layout:
 *   .cache/schemas/{provider}/{sanitized-modelId}.json
 *
 * Each file stores a CachedSchemaEntry. The warmer writes fresh entries on
 * every run; the request handler reads from this cache first.
 *
 * Resilience:
 *   - Writes are atomic (write to .tmp, then rename).
 *   - Reads tolerate malformed JSON by returning null.
 *   - If the on-disk `formatVersion` is older than SCHEMA_FORMAT_VERSION,
 *     the entry is treated as missing (re-extraction required).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProviderType } from "@/types";
import type { ModelParameter, ModelInput } from "@/lib/providers/types";
import type { CachedSchemaEntry, ExtractedResult } from "./types";
import { SCHEMA_FORMAT_VERSION } from "./types";

/**
 * Where cached schemas live. Overridable via `SCHEMA_CACHE_ROOT` env var
 * (used by tests to isolate runs).
 */
function getCacheRoot(): string {
  return process.env.SCHEMA_CACHE_ROOT || path.join(process.cwd(), ".cache", "schemas");
}

/**
 * Sanitize a modelId for use as a filename (strip characters unsafe on Windows/*nix).
 */
export function sanitizeId(modelId: string): string {
  return modelId.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
}

export function cachePath(provider: ProviderType, modelId: string): string {
  return path.join(getCacheRoot(), provider, `${sanitizeId(modelId)}.json`);
}

/**
 * Ensure the provider directory exists.
 */
async function ensureDir(provider: ProviderType): Promise<void> {
  await fs.mkdir(path.join(getCacheRoot(), provider), { recursive: true });
}

/**
 * Read a cached schema from disk. Returns null if missing or stale.
 */
export async function readCachedSchema(
  provider: ProviderType,
  modelId: string
): Promise<CachedSchemaEntry | null> {
  try {
    const raw = await fs.readFile(cachePath(provider, modelId), "utf8");
    const entry = JSON.parse(raw) as CachedSchemaEntry;
    if (entry.formatVersion !== SCHEMA_FORMAT_VERSION) return null;
    return entry;
  } catch {
    return null;
  }
}

/**
 * Atomically write an extracted result to disk. Preserves the previous
 * `extractedAt` if the caller passes `preserveTimestamp: true` — useful if
 * the warmer wants to keep track of "last successful extraction" across runs.
 */
export async function writeCachedSchema(
  provider: ProviderType,
  modelId: string,
  result: ExtractedResult,
  opts?: { rawHash?: string }
): Promise<void> {
  await ensureDir(provider);
  const entry: CachedSchemaEntry = {
    provider,
    modelId,
    extractedAt: result.health.extractedAt,
    parameters: result.parameters,
    inputs: result.inputs,
    warnings: result.health.warnings,
    rawHash: opts?.rawHash,
    formatVersion: SCHEMA_FORMAT_VERSION,
  };

  const dest = cachePath(provider, modelId);
  const tmp = `${dest}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entry, null, 2), "utf8");
  await fs.rename(tmp, dest);
}

/**
 * Convenience: convert a CachedSchemaEntry back to an ExtractedResult.
 */
export function cachedToExtracted(entry: CachedSchemaEntry): ExtractedResult {
  return {
    parameters: entry.parameters as ModelParameter[],
    inputs: entry.inputs as ModelInput[],
    health: {
      status: "clean",
      warnings: entry.warnings ?? [],
      extractedAt: entry.extractedAt,
    },
  };
}

/**
 * List all cached model ids for a provider. Returns `[]` if the directory
 * doesn't exist yet.
 */
export async function listCachedModelIds(provider: ProviderType): Promise<string[]> {
  try {
    const dir = path.join(getCacheRoot(), provider);
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
