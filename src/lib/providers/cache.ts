/**
 * Model Caching Utility
 *
 * Two-tier cache for model lists from providers:
 * 1. In-memory Map (fast, lost on restart)
 * 2. File-based JSON cache (persists across restarts, 24h TTL)
 *
 * Features:
 * - 24-hour default TTL
 * - Per-provider cache keys
 * - File persistence in .cache/models/
 * - Optional search query in cache key (search keys are NOT file-cached)
 * - Manual invalidation support
 * - WaveSpeed schema caching (raw API schemas by model ID)
 */

import { ProviderModel } from "./types";
import { ProviderType } from "@/types";
import * as fs from "fs";
import * as path from "path";

/**
 * Cache entry with data and timestamp
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * WaveSpeed raw schema from API
 * Structure: { api_schemas: [{ request_schema: {...} }] }
 */
export interface WaveSpeedApiSchema {
  api_schemas?: Array<{
    request_schema?: Record<string, unknown>;
    response_schema?: Record<string, unknown>;
  }>;
}

/**
 * Default cache TTL: 24 hours
 */
const DEFAULT_TTL = 24 * 60 * 60 * 1000;

/**
 * File-based cache directory
 */
const FILE_CACHE_DIR = path.join(process.cwd(), ".cache", "models");

/**
 * Sanitize cache key for use as a filename
 */
function keyToFilename(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
}

/**
 * Check if a key should be file-cached (only full model lists, not searches)
 */
function isFileCacheable(key: string): boolean {
  return !key.includes(":search:");
}

/**
 * Read models from file cache
 */
function getFileCachedModels(key: string, ttl: number): ProviderModel[] | null {
  if (!isFileCacheable(key)) return null;
  try {
    const filePath = path.join(FILE_CACHE_DIR, keyToFilename(key));
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const entry = JSON.parse(raw) as { models: ProviderModel[]; timestamp: number };
    if (Date.now() - entry.timestamp > ttl) {
      // Expired — remove file
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      return null;
    }
    return entry.models;
  } catch {
    return null;
  }
}

/**
 * Write models to file cache (sync for simplicity — runs server-side)
 */
function setFileCachedModels(key: string, models: ProviderModel[]): void {
  if (!isFileCacheable(key)) return;
  try {
    fs.mkdirSync(FILE_CACHE_DIR, { recursive: true });
    const filePath = path.join(FILE_CACHE_DIR, keyToFilename(key));
    fs.writeFileSync(filePath, JSON.stringify({ models, timestamp: Date.now() }));
  } catch (err) {
    console.warn("[cache] Failed to write file cache:", err);
  }
}

/**
 * In-memory cache storage for models
 */
const cache: Map<string, CacheEntry<ProviderModel[]>> = new Map();

/**
 * In-memory cache for WaveSpeed raw schemas (keyed by model_id)
 * This allows the schema endpoint to retrieve schemas without re-fetching all models
 */
const wavespeedSchemaCache: Map<string, CacheEntry<WaveSpeedApiSchema>> = new Map();

/**
 * Get cached models for a key if not expired
 *
 * @param key - Cache key (use getCacheKey to generate)
 * @param ttl - Optional custom TTL in milliseconds
 * @returns Cached models or null if not in cache or expired
 */
export function getCachedModels(
  key: string,
  ttl: number = DEFAULT_TTL
): ProviderModel[] | null {
  // Tier 1: In-memory cache
  const entry = cache.get(key);
  if (entry) {
    if (Date.now() - entry.timestamp <= ttl) {
      return entry.data;
    }
    cache.delete(key);
  }

  // Tier 2: File-based cache (survives server restarts)
  const fileModels = getFileCachedModels(key, ttl);
  if (fileModels) {
    // Promote to in-memory cache for faster subsequent reads
    cache.set(key, { data: fileModels, timestamp: Date.now() });
    return fileModels;
  }

  return null;
}

/**
 * Store models in cache with current timestamp
 *
 * @param key - Cache key (use getCacheKey to generate)
 * @param models - Models to cache
 */
export function setCachedModels(key: string, models: ProviderModel[]): void {
  cache.set(key, {
    data: models,
    timestamp: Date.now(),
  });
  // Persist to file for survival across server restarts
  setFileCachedModels(key, models);
}

/**
 * Invalidate cache entries
 *
 * @param key - Optional specific key to invalidate. If not provided, clears entire cache.
 */
export function invalidateCache(key?: string): void {
  if (key) {
    cache.delete(key);
    // Also remove file cache
    if (isFileCacheable(key)) {
      try {
        const filePath = path.join(FILE_CACHE_DIR, keyToFilename(key));
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch { /* ignore */ }
    }
  } else {
    cache.clear();
    // Clear all file caches
    try {
      if (fs.existsSync(FILE_CACHE_DIR)) {
        for (const f of fs.readdirSync(FILE_CACHE_DIR)) {
          if (f.endsWith(".json")) {
            try { fs.unlinkSync(path.join(FILE_CACHE_DIR, f)); } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }
  }
}

/**
 * Generate a cache key for provider models
 *
 * @param provider - Provider type
 * @param search - Optional search query
 * @returns Cache key string
 *
 * @example
 * getCacheKey("replicate")           // "replicate:models"
 * getCacheKey("fal", "flux")         // "fal:search:flux"
 */
export function getCacheKey(provider: ProviderType, search?: string): string {
  if (search) {
    return `${provider}:search:${search}`;
  }
  return `${provider}:models`;
}

/**
 * Get cache statistics (for debugging)
 */
export function getCacheStats(): { size: number; keys: string[] } {
  return {
    size: cache.size,
    keys: Array.from(cache.keys()),
  };
}

// ============ WaveSpeed Schema Cache ============

/**
 * Get cached WaveSpeed schema for a model
 *
 * @param modelId - WaveSpeed model ID (e.g., "wavespeed-ai/flux-dev")
 * @param ttl - Optional custom TTL in milliseconds
 * @returns Cached schema or null if not in cache or expired
 */
export function getCachedWaveSpeedSchema(
  modelId: string,
  ttl: number = DEFAULT_TTL
): WaveSpeedApiSchema | null {
  const entry = wavespeedSchemaCache.get(modelId);

  if (!entry) {
    return null;
  }

  const now = Date.now();
  if (now - entry.timestamp > ttl) {
    wavespeedSchemaCache.delete(modelId);
    return null;
  }

  return entry.data;
}

/**
 * Store WaveSpeed schema in cache
 *
 * @param modelId - WaveSpeed model ID
 * @param schema - Raw API schema to cache
 */
export function setCachedWaveSpeedSchema(
  modelId: string,
  schema: WaveSpeedApiSchema
): void {
  wavespeedSchemaCache.set(modelId, {
    data: schema,
    timestamp: Date.now(),
  });
}

/**
 * Store multiple WaveSpeed schemas at once (efficient bulk operation)
 *
 * @param schemas - Map of model ID to schema
 */
export function setCachedWaveSpeedSchemas(
  schemas: Map<string, WaveSpeedApiSchema>
): void {
  const now = Date.now();
  for (const [modelId, schema] of schemas) {
    wavespeedSchemaCache.set(modelId, {
      data: schema,
      timestamp: now,
    });
  }
}

/**
 * Get WaveSpeed schema cache statistics (for debugging)
 */
export function getWaveSpeedSchemaCacheStats(): { size: number; modelIds: string[] } {
  return {
    size: wavespeedSchemaCache.size,
    modelIds: Array.from(wavespeedSchemaCache.keys()),
  };
}
