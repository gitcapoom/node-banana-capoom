/**
 * Unified schema extraction types.
 *
 * Flow:
 *   Provider raw response → normalize() → NormalizedSchema
 *   NormalizedSchema → extract() → ExtractedResult
 *   ExtractedResult + playground scrape → merge() → ExtractedResult (augmented)
 */

import type { ModelParameter, ModelInput } from "@/lib/providers/types";
import type { ProviderType } from "@/types";

/**
 * Provider-agnostic representation of a single property in an input schema.
 * All $ref/allOf resolved. anyOf/oneOf variants preserved (not collapsed).
 */
export interface NormalizedProperty {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "array" | "object" | "union";
  description?: string;
  format?: string;                               // e.g. "uri", "binary", "data-uri"
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  /** For type="array" */
  items?: NormalizedProperty;
  /** For type="object" */
  properties?: Record<string, NormalizedProperty>;
  /**
   * For type="union" — all non-null variants.
   * Use this to detect e.g. image_size (enum string OR object{width,height}).
   */
  unionVariants?: NormalizedProperty[];
  /** Did the source list this property as required? */
  required?: boolean;
  /** Did the source declare it nullable (e.g. anyOf:[T,null])? */
  nullable?: boolean;
  /** Where did this property come from — used for debugging */
  source?: "openapi" | "slug-fallback" | "playground-scrape" | "override" | "static";
}

export interface NormalizedSchema {
  properties: Record<string, NormalizedProperty>;
  required: string[];
  /** Where the overall schema came from */
  source: "openapi" | "slug-fallback" | "static" | "unknown";
}

export interface ExtractedResult {
  parameters: ModelParameter[];
  inputs: ModelInput[];
  health: SchemaHealth;
}

export interface SchemaHealth {
  status: "clean" | "heuristic-fallback" | "no-inputs" | "playground-augmented" | "extraction-error";
  /** Human-readable notes about decisions made during extraction. */
  warnings: string[];
  /** When the extraction ran. */
  extractedAt: number;
  /** Schema source version/hash for staleness checks. */
  sourceVersion?: string;
}

/**
 * What the disk cache stores per model.
 */
export interface CachedSchemaEntry {
  provider: ProviderType;
  modelId: string;
  extractedAt: number;
  parameters: ModelParameter[];
  inputs: ModelInput[];
  warnings?: string[];
  /** Hash of the raw source schema; used for change detection. */
  rawHash?: string;
  /** Version of the extraction logic that produced this cache. */
  formatVersion: number;
}

/** Bump when extract.ts logic changes. Any cache entries with lower version are re-extracted. */
export const SCHEMA_FORMAT_VERSION = 3; // v3: detect @-reference convention on array inputs (refConvention)
