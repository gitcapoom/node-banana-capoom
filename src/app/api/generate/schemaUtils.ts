/**
 * Schema Utilities for Generate API Route
 *
 * Provides input parameter pattern matching, type extraction, and coercion
 * from OpenAPI schemas used by multi-provider generation.
 */

import { normalizeProperty } from "@/lib/schema/normalize/openapi";

/**
 * Does this raw OpenAPI property hold a LIST?
 *
 * Not the same question as `prop.type === "array"`. fal writes an *optional*
 * array as a nullable union — `anyOf: [{type:"array",...}, {type:"null"}]` —
 * which carries no top-level `type` at all, so the direct read says "not an
 * array" for 43 of the 220 fal models that have a connectable array input
 * (every Kling o1/o3 reference/edit endpoint, every Ideogram v3 endpoint, …).
 * $ref and allOf hide arrays the same way.
 *
 * Rather than re-derive that, this delegates to `normalizeProperty` — the same
 * flattening the canvas already uses to draw the pins — and then applies the
 * client's own isArray rule verbatim (src/lib/schema/extract.ts). Client and
 * server therefore agree by construction: the shape the canvas builds is the
 * shape the provider expects. The rule was already copied four times across
 * this directory and all four copies were wrong; this is the one test.
 *
 * Note the near-miss it must NOT catch: fal also writes nullable SCALARS as
 * `anyOf:[{type:"string"},{type:"null"}]` (e.g. kling v2.5-turbo's
 * `tail_image_url`). Treating "any union" as an array would wrap those and
 * produce the mirror 422 — "Input should be a valid string".
 *
 * @param components `components.schemas` from the spec, for $ref resolution.
 */
export function isArraySchemaProperty(
  name: string,
  raw: unknown,
  components?: Record<string, unknown>
): boolean {
  if (!raw || typeof raw !== "object") return false;
  const prop = normalizeProperty(name, raw as Record<string, unknown>, components);
  return (
    prop.type === "array" ||
    (prop.type === "union" && !!prop.unionVariants?.some((v) => v.type === "array"))
  );
}

/**
 * Input parameter patterns - maps generic input types to possible schema parameter names
 */
export const INPUT_PATTERNS: Record<string, string[]> = {
  // Text/prompt inputs
  prompt: ["prompt", "text", "caption", "input_text", "description", "query"],
  negativePrompt: ["negative_prompt", "negative", "neg_prompt", "negative_text"],

  // Image inputs
  image: ["image_url", "image_urls", "image", "first_frame", "start_image", "init_image",
          "reference_image", "input_image", "image_input", "source_image", "img", "photo"],

  // Video/media settings
  aspectRatio: ["aspect_ratio", "ratio", "size", "dimensions", "output_size"],
  duration: ["duration", "length", "num_frames", "seconds", "video_length"],
  fps: ["fps", "frame_rate", "framerate", "frames_per_second"],

  // Audio settings
  audio: ["audio_enabled", "with_audio", "enable_audio", "audio", "sound"],

  // Generation settings
  seed: ["seed", "random_seed", "noise_seed"],
  steps: ["steps", "num_steps", "num_inference_steps", "inference_steps"],
  guidance: ["guidance_scale", "guidance", "cfg_scale", "cfg"],

  // Model-specific
  scheduler: ["scheduler", "sampler", "sampler_name"],
  strength: ["strength", "denoise", "denoising_strength"],
};

/**
 * Input mapping result from schema parsing
 */
export interface InputMapping {
  // Maps our generic names to model-specific parameter names
  paramMap: Record<string, string>;
  // Track which generic params expect array types (e.g., "image")
  arrayParams: Set<string>;
  // Track actual schema param names that expect array types (e.g., "image_urls")
  schemaArrayParams: Set<string>;
  /**
   * Did we actually read a schema? Every failure below returns EMPTY sets,
   * which a caller cannot tell apart from "the schema says none of these are
   * arrays". Callers that RESHAPE values on a negative answer (unwrapping an
   * array to its first element) must check this first: unknown is not scalar.
   */
  schemaLoaded: boolean;
}

/**
 * Parameter type information extracted from OpenAPI schema
 */
export interface ParameterTypeInfo {
  [paramName: string]: "string" | "integer" | "number" | "boolean" | "array" | "object";
}

/**
 * Extract parameter types from OpenAPI schema
 */
export function getParameterTypesFromSchema(schema: Record<string, unknown> | undefined): ParameterTypeInfo {
  const typeInfo: ParameterTypeInfo = {};

  if (!schema) return typeInfo;

  try {
    const components = schema.components as Record<string, unknown> | undefined;
    const schemas = components?.schemas as Record<string, unknown> | undefined;
    const input = schemas?.Input as Record<string, unknown> | undefined;
    const properties = input?.properties as Record<string, unknown> | undefined;

    if (!properties) return typeInfo;

    for (const [propName, prop] of Object.entries(properties)) {
      const property = prop as Record<string, unknown>;
      const type = property?.type as string | undefined;
      if (type && ["string", "integer", "number", "boolean", "array", "object"].includes(type)) {
        typeInfo[propName] = type as ParameterTypeInfo[string];
      }
    }
  } catch {
    // Schema parsing failed
  }

  return typeInfo;
}

/**
 * Coerce parameter values to their expected types based on schema
 * This handles cases where values were incorrectly stored as strings (e.g., from UI enum selects)
 *
 * UNSET values (null / undefined / "") are DROPPED, not passed through: an
 * empty settings-panel field means "use the model's default", and providers
 * (fal in particular) run model-specific validation that rejects explicit
 * nulls — the field must be absent from the request body entirely.
 */
export function coerceParameterTypes(
  parameters: Record<string, unknown> | undefined,
  typeInfo: ParameterTypeInfo
): Record<string, unknown> {
  if (!parameters) return {};

  const result = { ...parameters };

  for (const [key, value] of Object.entries(result)) {
    if (value === undefined || value === null || value === "") {
      delete result[key];
      continue;
    }

    const expectedType = typeInfo[key];
    if (!expectedType) continue;

    // Coerce string values to their expected types
    if (typeof value === "string") {
      if (expectedType === "integer") {
        const parsed = parseInt(value, 10);
        if (!isNaN(parsed)) result[key] = parsed;
      } else if (expectedType === "number") {
        const parsed = parseFloat(value);
        if (!isNaN(parsed)) result[key] = parsed;
      } else if (expectedType === "boolean") {
        result[key] = value === "true";
      } else if (expectedType === "object" || expectedType === "array") {
        // Try parsing JSON strings for complex types
        try { result[key] = JSON.parse(value); } catch { /* keep as-is */ }
      }
    }
  }

  return result;
}

/**
 * Extract input parameter mappings from OpenAPI schema
 * Returns a mapping of generic parameter names to model-specific names
 */
export function getInputMappingFromSchema(schema: Record<string, unknown> | undefined): InputMapping {
  const paramMap: Record<string, string> = {};
  const arrayParams = new Set<string>();
  const schemaArrayParams = new Set<string>();
  let schemaLoaded = false;

  if (!schema) return { paramMap, arrayParams, schemaArrayParams, schemaLoaded };

  try {
    // Navigate to input schema properties
    const components = schema.components as Record<string, unknown> | undefined;
    const schemas = components?.schemas as Record<string, unknown> | undefined;
    const componentSchemas = schemas;
    const input = schemas?.Input as Record<string, unknown> | undefined;
    const properties = input?.properties as Record<string, unknown> | undefined;

    if (!properties) return { paramMap, arrayParams, schemaArrayParams, schemaLoaded };

    // First pass: detect all array-typed properties by their actual schema name
    for (const [propName, prop] of Object.entries(properties)) {
      if (isArraySchemaProperty(propName, prop, componentSchemas)) {
        schemaArrayParams.add(propName);
      }
    }

    const propertyNames = Object.keys(properties);

    // For each input type pattern, find the matching schema property
    for (const [genericName, patterns] of Object.entries(INPUT_PATTERNS)) {
      for (const pattern of patterns) {
        let matchedParam: string | null = null;

        // Check for exact match first
        if (properties[pattern]) {
          matchedParam = pattern;
        } else {
          // Check for case-insensitive partial match
          const patternLower = pattern.toLowerCase();
          const match = propertyNames.find(name => {
            const nameLower = name.toLowerCase();
            // Property name contains the pattern (intended direction)
            if (nameLower.includes(patternLower)) return true;
            // Pattern contains the property name — only allow for longer patterns
            // to prevent short property names (e.g. "id") matching everything
            if (patternLower.length >= 3 && patternLower.includes(nameLower)) return true;
            return false;
          });
          if (match) {
            matchedParam = match;
          }
        }

        if (matchedParam) {
          paramMap[genericName] = matchedParam;
          // Check if this property expects an array type
          if (isArraySchemaProperty(matchedParam, properties[matchedParam], componentSchemas)) {
            arrayParams.add(genericName);
          }
          break;
        }
      }
    }
    schemaLoaded = true;
  } catch {
    // Schema parsing failed — leave schemaLoaded false so callers do not treat
    // a partially-built schemaArrayParams as authoritative.
  }

  return { paramMap, arrayParams, schemaArrayParams, schemaLoaded };
}
