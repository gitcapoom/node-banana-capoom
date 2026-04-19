/**
 * Model Schema API Endpoint
 *
 * Fetches parameter schema for a specific model from its provider.
 * Returns simplified parameter list for UI rendering.
 *
 * GET /api/models/:modelId?provider=replicate|fal|wavespeed
 *
 * Headers:
 *   - X-Replicate-Key: Required for Replicate models
 *   - X-Fal-Key: Optional for fal.ai models
 *   - X-WaveSpeed-Key: Optional for WaveSpeed models
 *
 * Response:
 *   {
 *     success: true,
 *     parameters: ModelParameter[],
 *     cached: boolean
 *   }
 *
 * WaveSpeed models fetch schemas dynamically from the /api/v3/models endpoint,
 * with fallback to static definitions for models without api_schema.
 */

import { NextRequest, NextResponse } from "next/server";
import { ProviderType } from "@/types";
import { ModelParameter, ModelInput } from "@/lib/providers/types";
import {
  getCachedWaveSpeedSchema,
  setCachedWaveSpeedSchema,
  WaveSpeedApiSchema,
} from "@/lib/providers/cache";

// Cache for model schemas (10 minute TTL)
const schemaCache = new Map<string, { parameters: ModelParameter[]; inputs: ModelInput[]; timestamp: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Image input property patterns
const IMAGE_INPUT_PATTERNS = [
  "image_url",
  "image_urls",
  "image",
  "images",
  "image_input",
  "input_image",
  "first_frame",
  "last_frame",
  "tail_image_url",
  "start_image",
  "end_image",
  "reference_image",
  "init_image",
  "mask_image",
  "mask_url",
  "mask",
  "control_image",
];

// Video input property patterns
const VIDEO_INPUT_PATTERNS = [
  "video_url",
  "video_urls",
  "video",
  "videos",
  "video_input",
  "input_video",
  "source_video",
];

// Audio input property patterns
const AUDIO_INPUT_PATTERNS = [
  "audio_url",
  "audio_urls",
  "audio",
  "audio_input",
  "input_audio",
  "source_audio",
  "voice_audio",
];

// Text input properties
const TEXT_INPUT_NAMES = ["prompt", "negative_prompt"];

// Properties that start with "image_" but are NOT image inputs
const IMAGE_PREFIX_EXCLUSIONS = ["image_size"];

// Parameters to filter out (truly internal/system params only)
// Keep user-facing params like output_format, safety_checker, sync_mode visible
const EXCLUDED_PARAMS = new Set([
  "webhook",
  "webhook_url",
  "webhook_events_filter",
  "request_id",
]);

// Parameters we want to surface (user-relevant)
const PRIORITY_PARAMS = new Set([
  "seed",
  "num_inference_steps",
  "inference_steps",
  "steps",
  "guidance_scale",
  "guidance",
  "negative_prompt",
  "width",
  "height",
  "image_size",
  "num_outputs",
  "num_images",
  "scheduler",
  "strength",
  "cfg_scale",
  "lora_scale",
]);

interface SchemaSuccessResponse {
  success: true;
  parameters: ModelParameter[];
  inputs: ModelInput[];
  cached: boolean;
}

interface SchemaErrorResponse {
  success: false;
  error: string;
}

type SchemaResponse = SchemaSuccessResponse | SchemaErrorResponse;

/**
 * Convert property name to human-readable label
 */
function toLabel(name: string): string {
  return name
    .replace(/_url$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Check if property is an image input based on BOTH schema type AND name.
 *
 * Image inputs must be strings (URLs or base64) or arrays of strings.
 * Integers, booleans, numbers with "image" in the name are NOT image inputs.
 */
function isImageInput(name: string, prop: Record<string, unknown>, schemaComponents?: Record<string, unknown>): boolean {
  // First check: must be a string type (images are URLs or base64 strings)
  // Integers, booleans, numbers are NEVER image inputs regardless of name
  const resolved = resolvePropertyType(prop, schemaComponents);
  const propType = resolved.type;
  if (propType !== "string" && propType !== "array") {
    return false;
  }

  // Enum properties (dropdowns) are never media inputs
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return false;
  const variants = (prop.anyOf ?? prop.oneOf) as Array<Record<string, unknown>> | undefined;
  if (variants?.some(v => Array.isArray(v.enum) && v.enum.length > 0)) return false;

  // Enum/config suffixes (image_type, image_mode, image_format) are not inputs
  if (/_(type|mode|quality|format|codec|preset|style|method|strategy)$/.test(name)) return false;

  // For arrays, check if items are strings (or unspecified - be lenient)
  if (propType === "array") {
    const items = prop.items as Record<string, unknown> | undefined;
    // Only reject if items.type is explicitly specified AND not "string"
    // Many schemas don't specify items type for image arrays
    if (items && items.type && items.type !== "string") {
      return false;
    }
  }

  // Check exclusions (e.g., image_size is a parameter, not an image input)
  if (IMAGE_PREFIX_EXCLUSIONS.includes(name)) {
    return false;
  }

  // Check format hints (OpenAPI format field or resolved format) - strong signal for image URLs
  const format = (prop.format ?? resolved.format) as string | undefined;
  if (format === "uri" || format === "data-uri" || format === "binary") {
    // Only treat as image if name also suggests it's an image
    if (IMAGE_INPUT_PATTERNS.includes(name) ||
        name.endsWith("_image") ||
        name.startsWith("image_") ||
        name.includes("_image_")) {
      return true;
    }
  }

  // Check description for image-related keywords
  const description = (prop.description as string || "").toLowerCase();
  if (description.includes("image url") ||
      description.includes("base64 image") ||
      description.includes("data uri") ||
      description.includes("image file") ||
      description.includes("url of the image") ||
      description.includes("path to image")) {
    return true;
  }

  // Check explicit patterns (exact matches like "image_url", "image")
  if (IMAGE_INPUT_PATTERNS.includes(name)) {
    return true;
  }

  // More restrictive name pattern matching for strings
  // Exclude names that suggest counts or settings rather than actual images
  if (name.includes("_images") ||    // max_images, num_images
      name.includes("guidance") ||   // image_guidance_scale
      name.includes("generation") || // sequential_image_generation
      name.includes("_count") ||     // image_count
      name.includes("_size") ||      // image_size (already in exclusions but belt-and-suspenders)
      name.includes("_scale")) {     // image_scale
    return false;
  }

  // Finally, check name patterns for remaining string types
  return name.endsWith("_image") ||
         name.endsWith("_image_url") ||
         name.startsWith("image_") ||
         name.includes("_image_");
}

/**
 * Check if property is a video input based on name patterns.
 * Must be checked BEFORE isImageInput to prevent video URLs from being mislabeled.
 */
function isVideoInput(name: string, prop: Record<string, unknown>, schemaComponents?: Record<string, unknown>): boolean {
  // Must be a string or array type (URLs)
  const resolved = resolvePropertyType(prop, schemaComponents);
  const propType = resolved.type;
  if (propType !== "string" && propType !== "array") return false;

  // Enum properties (dropdowns) are never media inputs
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return false;
  // Check for enum in anyOf/oneOf variants
  const variants = (prop.anyOf ?? prop.oneOf) as Array<Record<string, unknown>> | undefined;
  if (variants?.some(v => Array.isArray(v.enum) && v.enum.length > 0)) return false;

  if (VIDEO_INPUT_PATTERNS.includes(name)) return true;

  // Check description for video-related keywords
  const description = (prop.description as string || "").toLowerCase();
  if (description.includes("video url") || description.includes("video file") || description.includes("url of the video")) {
    return true;
  }

  // Name-based fallback — exclude common enum/config suffixes
  const isNonInputSuffix = /_(type|mode|quality|format|codec|preset|size|count|length|duration|width|height)$/.test(name);
  if (isNonInputSuffix) return false;

  return name.endsWith("_video") || name.endsWith("_video_url") || (name.startsWith("video_") && !name.includes("_size") && !name.includes("_count"));
}

/**
 * Check if property is an audio input based on name patterns.
 * Must be checked BEFORE isImageInput to prevent audio URLs from being mislabeled.
 */
function isAudioInput(name: string, prop: Record<string, unknown>, schemaComponents?: Record<string, unknown>): boolean {
  const resolved = resolvePropertyType(prop, schemaComponents);
  const propType = resolved.type;
  if (propType !== "string" && propType !== "array") return false;

  // Enum properties (dropdowns) are never media inputs
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return false;
  const variants = (prop.anyOf ?? prop.oneOf) as Array<Record<string, unknown>> | undefined;
  if (variants?.some(v => Array.isArray(v.enum) && v.enum.length > 0)) return false;

  if (AUDIO_INPUT_PATTERNS.includes(name)) return true;

  const description = (prop.description as string || "").toLowerCase();
  if (description.includes("audio url") || description.includes("audio file") || description.includes("url of the audio")) {
    return true;
  }

  const isNonInputSuffix = /_(type|mode|quality|format|codec|preset|size|count|length|duration|bitrate|rate|channels)$/.test(name);
  if (isNonInputSuffix) return false;

  return name.endsWith("_audio") || name.endsWith("_audio_url") || (name.startsWith("audio_") && !name.includes("_size") && !name.includes("_count"));
}

/**
 * Check if property is a text input
 */
function isTextInput(name: string): boolean {
  return TEXT_INPUT_NAMES.includes(name);
}

/**
 * Check if a resolved schema is an "image URL wrapper" object.
 * fal.ai defines image inputs as objects like ImageUrl: { type: "object", properties: { url: { type: "string" } } }
 * These should be treated as string type for input detection purposes.
 */
function isImageUrlWrapperObject(schema: Record<string, unknown>): boolean {
  if (schema.type !== "object") return false;
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return false;
  // Has a "url" property that is a string — this is an image/file URL wrapper
  return props.url !== undefined && props.url.type === "string";
}

/**
 * Resolve a $ref reference in OpenAPI schema
 * E.g., "#/components/schemas/AspectRatio" -> schema object
 */
function resolveRef(
  ref: string,
  schemaComponents: Record<string, unknown>
): Record<string, unknown> | null {
  // Parse reference path like "#/components/schemas/AspectRatio"
  const match = ref.match(/^#\/components\/schemas\/(.+)$/);
  if (!match) return null;

  const schemaName = match[1];
  const resolved = schemaComponents[schemaName] as Record<string, unknown> | undefined;
  return resolved || null;
}

/**
 * Resolve the effective type and format from an OpenAPI property.
 *
 * Handles wrapper patterns used by code generators (e.g. Pydantic → OpenAPI):
 *   - anyOf / oneOf: picks the first non-null type (nullable pattern)
 *   - allOf: merges referenced schemas
 *   - $ref: resolves from schemaComponents
 *   - Direct type: returns immediately (fast path — no behavior change)
 */
function resolvePropertyType(
  prop: Record<string, unknown>,
  schemaComponents?: Record<string, unknown>
): { type?: string; format?: string } {
  // Fast path: direct type is defined — existing behaviour, no change
  if (prop.type !== undefined) {
    return { type: prop.type as string, format: prop.format as string | undefined };
  }

  // anyOf / oneOf — prefer primitive types over "object"/"array" when both exist
  const variants = (prop.anyOf ?? prop.oneOf) as Array<Record<string, unknown>> | undefined;
  if (variants && Array.isArray(variants)) {
    // First pass: collect all non-null resolved types
    const resolved: Array<{ type: string; format?: string }> = [];
    for (const variant of variants) {
      if (variant.$ref && typeof variant.$ref === "string" && schemaComponents) {
        const ref = resolveRef(variant.$ref as string, schemaComponents);
        if (ref && ref.type && ref.type !== "null") {
          resolved.push({ type: ref.type as string, format: (ref.format ?? prop.format) as string | undefined });
        }
      } else if (variant.type && variant.type !== "null") {
        resolved.push({ type: variant.type as string, format: (variant.format ?? prop.format) as string | undefined });
      }
    }
    // Prefer primitive types (number, integer, string, boolean) over complex (object, array)
    // e.g. anyOf: [{type:"object"},{type:"number"}] → pick number (LoRA scale pattern)
    const primitive = resolved.find(r => ["number", "integer", "string", "boolean"].includes(r.type));
    if (primitive) return primitive;
    if (resolved.length > 0) return resolved[0];
  }

  // allOf — merge referenced schemas
  const allOf = prop.allOf as Array<Record<string, unknown>> | undefined;
  if (allOf && Array.isArray(allOf) && schemaComponents) {
    for (const item of allOf) {
      if (item.$ref && typeof item.$ref === "string") {
        const resolved = resolveRef(item.$ref as string, schemaComponents);
        if (resolved && resolved.type) {
          return { type: resolved.type as string, format: (resolved.format ?? prop.format) as string | undefined };
        }
      }
      if (item.type) {
        return { type: item.type as string, format: (item.format ?? prop.format) as string | undefined };
      }
    }
  }

  // $ref at top level
  if (prop.$ref && typeof prop.$ref === "string" && schemaComponents) {
    const resolved = resolveRef(prop.$ref as string, schemaComponents);
    if (resolved && resolved.type) {
      return { type: resolved.type as string, format: (resolved.format ?? prop.format) as string | undefined };
    }
  }

  return {};
}

/**
 * Convert OpenAPI schema property to ModelParameter
 */
function convertSchemaProperty(
  name: string,
  prop: Record<string, unknown>,
  required: string[],
  schemaComponents?: Record<string, unknown>
): ModelParameter | null {
  // Skip excluded parameters
  if (EXCLUDED_PARAMS.has(name)) {
    return null;
  }

  // Determine type and extract enum from allOf/$ref/anyOf/oneOf if present
  let type: ModelParameter["type"] = "string";
  let enumValues: unknown[] | undefined;
  let resolvedDefault: unknown;
  let resolvedDescription: string | undefined;

  // Use resolvePropertyType() to handle anyOf/oneOf/allOf/$ref patterns
  const resolved = resolvePropertyType(prop, schemaComponents);
  const effectiveType = resolved.type;

  if (effectiveType === "integer") {
    type = "integer";
  } else if (effectiveType === "number") {
    type = "number";
  } else if (effectiveType === "boolean") {
    type = "boolean";
  } else if (effectiveType === "array") {
    type = "array";
  } else if (effectiveType === "object") {
    type = "object";
  }

  // Extract enum/default/description from allOf with $ref
  const allOf = prop.allOf as Array<Record<string, unknown>> | undefined;
  if (allOf && allOf.length > 0 && schemaComponents) {
    for (const item of allOf) {
      const itemRef = item.$ref as string | undefined;
      if (itemRef) {
        const refResolved = resolveRef(itemRef, schemaComponents);
        if (refResolved) {
          if (Array.isArray(refResolved.enum)) {
            enumValues = refResolved.enum;
          }
          if (refResolved.default !== undefined && resolvedDefault === undefined) {
            resolvedDefault = refResolved.default;
          }
          if (refResolved.description && !resolvedDescription) {
            resolvedDescription = refResolved.description as string;
          }
        }
      } else if (Array.isArray(item.enum)) {
        enumValues = item.enum;
      }
    }
  }

  // Extract enum/default/description from anyOf/oneOf variants
  const variants = (prop.anyOf ?? prop.oneOf) as Array<Record<string, unknown>> | undefined;
  if (variants && Array.isArray(variants)) {
    for (const variant of variants) {
      if (variant.type === "null") continue;
      // Resolve $ref inside variant
      if (variant.$ref && typeof variant.$ref === "string" && schemaComponents) {
        const refResolved = resolveRef(variant.$ref as string, schemaComponents);
        if (refResolved) {
          if (Array.isArray(refResolved.enum) && !enumValues) {
            enumValues = refResolved.enum;
          }
          if (refResolved.default !== undefined && resolvedDefault === undefined) {
            resolvedDefault = refResolved.default;
          }
          if (refResolved.description && !resolvedDescription) {
            resolvedDescription = refResolved.description as string;
          }
        }
      } else {
        if (Array.isArray(variant.enum) && !enumValues) {
          enumValues = variant.enum;
        }
        if (variant.default !== undefined && resolvedDefault === undefined) {
          resolvedDefault = variant.default;
        }
      }
    }
  }

  const parameter: ModelParameter = {
    name,
    type,
    description: (prop.description as string | undefined) || resolvedDescription,
    default: prop.default !== undefined ? prop.default : resolvedDefault,
    required: required.includes(name),
  };

  // Add constraints (support OpenAPI minimum/maximum + pydantic ge/le/gt/lt + exclusiveMinimum/exclusiveMaximum)
  const minVal = prop.minimum ?? prop.ge ?? (typeof prop.exclusiveMinimum === "number" ? prop.exclusiveMinimum + 1 : undefined) ?? (typeof prop.gt === "number" ? (prop.gt as number) + (type === "integer" ? 1 : 0.01) : undefined);
  const maxVal = prop.maximum ?? prop.le ?? (typeof prop.exclusiveMaximum === "number" ? prop.exclusiveMaximum - 1 : undefined) ?? (typeof prop.lt === "number" ? (prop.lt as number) - (type === "integer" ? 1 : 0.01) : undefined);
  if (typeof minVal === "number") {
    parameter.minimum = minVal;
  }
  if (typeof maxVal === "number") {
    parameter.maximum = maxVal;
  }

  // Use enum from property directly, or from resolved $ref
  if (Array.isArray(prop.enum)) {
    parameter.enum = prop.enum;
  } else if (enumValues) {
    parameter.enum = enumValues;
  }

  // Detect anyOf/oneOf union of enum + object (e.g., image_size: preset enum OR custom {width, height})
  // When both variants exist, expose as type="object" with both enum and properties
  if (variants && Array.isArray(variants) && schemaComponents) {
    let unionEnumValues: unknown[] | undefined;
    let unionObjProps: Record<string, unknown> | undefined;
    let unionObjRequired: string[] = [];

    for (const v of variants) {
      if (v.type === "null") continue;
      let resolved2 = v;
      if (v.$ref && typeof v.$ref === "string") {
        resolved2 = resolveRef(v.$ref as string, schemaComponents) || v;
      }
      // Collect enum variant
      if (Array.isArray(resolved2.enum) && resolved2.enum.length > 0 && !unionEnumValues) {
        unionEnumValues = resolved2.enum;
      }
      // Collect object variant with properties
      if ((resolved2.type === "object" || resolved2.properties) && resolved2.properties && !unionObjProps) {
        unionObjProps = resolved2.properties as Record<string, unknown>;
        unionObjRequired = (resolved2.required || []) as string[];
      }
    }

    // If we found BOTH enum and object variants, upgrade to object with both
    if (unionEnumValues && unionObjProps) {
      type = "object";
      parameter.type = "object";
      if (!enumValues) enumValues = unionEnumValues;
      parameter.enum = unionEnumValues;
      parameter.properties = [];
      for (const [subName, subProp] of Object.entries(unionObjProps)) {
        if (EXCLUDED_PARAMS.has(subName)) continue;
        const subParam = convertSchemaProperty(subName, subProp as Record<string, unknown>, unionObjRequired, schemaComponents);
        if (subParam) parameter.properties.push(subParam);
      }
    }
  }

  // Extract sub-properties for object types (if not already populated by union detection above)
  if (type === "object" && !parameter.properties) {
    let objProps: Record<string, unknown> | undefined;
    let objRequired: string[] = [];

    // Direct properties
    if (prop.properties) {
      objProps = prop.properties as Record<string, unknown>;
      objRequired = (prop.required || []) as string[];
    }
    // Resolve from $ref
    if (!objProps && prop.$ref && typeof prop.$ref === "string" && schemaComponents) {
      const refResolved = resolveRef(prop.$ref as string, schemaComponents);
      if (refResolved?.properties) {
        objProps = refResolved.properties as Record<string, unknown>;
        objRequired = (refResolved.required || []) as string[];
      }
    }
    // Resolve from anyOf/oneOf (pick first object variant)
    if (!objProps && schemaComponents) {
      const vars = (prop.anyOf ?? prop.oneOf) as Array<Record<string, unknown>> | undefined;
      if (vars) {
        for (const v of vars) {
          if (v.type === "null") continue;
          let resolved2 = v;
          if (v.$ref && typeof v.$ref === "string") {
            resolved2 = resolveRef(v.$ref as string, schemaComponents) || v;
          }
          if (resolved2.properties) {
            objProps = resolved2.properties as Record<string, unknown>;
            objRequired = (resolved2.required || []) as string[];
            break;
          }
        }
      }
    }

    if (objProps) {
      parameter.properties = [];
      for (const [subName, subProp] of Object.entries(objProps)) {
        if (EXCLUDED_PARAMS.has(subName)) continue;
        const subParam = convertSchemaProperty(subName, subProp as Record<string, unknown>, objRequired, schemaComponents);
        if (subParam) parameter.properties.push(subParam);
      }
    }
  }

  // Extract items schema for array types
  if (type === "array") {
    let itemsSchema: Record<string, unknown> | undefined;

    // Direct items
    if (prop.items && typeof prop.items === "object") {
      itemsSchema = prop.items as Record<string, unknown>;
    }

    // Resolve $ref on items
    if (itemsSchema?.$ref && typeof itemsSchema.$ref === "string" && schemaComponents) {
      const refResolved = resolveRef(itemsSchema.$ref as string, schemaComponents);
      if (refResolved) itemsSchema = refResolved;
    }

    if (itemsSchema) {
      const itemType = (itemsSchema.type as string) || "string";

      if (itemType === "object" && itemsSchema.properties) {
        // Array of objects (e.g., LoRAs)
        const subRequired = (itemsSchema.required || []) as string[];
        const itemProperties: ModelParameter[] = [];
        for (const [subName, subProp] of Object.entries(itemsSchema.properties as Record<string, unknown>)) {
          const subParam = convertSchemaProperty(subName, subProp as Record<string, unknown>, subRequired, schemaComponents);
          if (subParam) itemProperties.push(subParam);
        }
        parameter.items = { name: "item", type: "object", properties: itemProperties };
      } else {
        // Array of primitives
        parameter.items = { name: "item", type: itemType as ModelParameter["type"] };
        if (Array.isArray(itemsSchema.enum)) parameter.items.enum = itemsSchema.enum;
        if (itemsSchema.minimum !== undefined) parameter.items.minimum = itemsSchema.minimum as number;
        if (itemsSchema.maximum !== undefined) parameter.items.maximum = itemsSchema.maximum as number;
      }
    }
  }

  return parameter;
}

interface ExtractedSchema {
  parameters: ModelParameter[];
  inputs: ModelInput[];
}

/**
 * Fetch and parse schema from Replicate
 */
async function fetchReplicateSchema(
  modelId: string,
  apiKey: string
): Promise<ExtractedSchema> {
  const [owner, name] = modelId.split("/");

  const response = await fetch(
    `https://api.replicate.com/v1/models/${owner}/${name}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Replicate API error: ${response.status}`);
  }

  const data = await response.json();

  // Extract schema from latest_version.openapi_schema
  const openApiSchema = data.latest_version?.openapi_schema;
  if (!openApiSchema) {
    return { parameters: [], inputs: [] };
  }

  // Navigate to Input schema
  const inputSchema = openApiSchema.components?.schemas?.Input;
  if (!inputSchema || typeof inputSchema !== "object") {
    return { parameters: [], inputs: [] };
  }

  // Pass components.schemas for $ref resolution
  const schemaComponents = openApiSchema.components?.schemas as Record<string, unknown> | undefined;
  return extractParametersFromSchema(inputSchema as Record<string, unknown>, schemaComponents);
}

/**
 * Fetch and parse schema from fal.ai using Model Search API
 * Uses: GET https://api.fal.ai/v1/models?endpoint_id={modelId}&expand=openapi-3.0
 */
async function fetchFalSchema(
  modelId: string,
  apiKey: string | null
): Promise<ExtractedSchema> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Key ${apiKey}`;
  }

  // Use fal.ai Model Search API with OpenAPI expansion
  const url = `https://api.fal.ai/v1/models?endpoint_id=${encodeURIComponent(modelId)}&expand=openapi-3.0`;

  const response = await fetch(url, { headers });

  if (!response.ok) {
    // Return empty params if API fails so generation still works
    return { parameters: [], inputs: [] };
  }

  const data = await response.json();

  // Response is { models: [{ openapi: {...}, ... }] }
  const modelData = data.models?.[0];
  if (!modelData?.openapi) {
    return { parameters: [], inputs: [] };
  }

  const spec = modelData.openapi;

  // Find POST endpoint with requestBody - paths are keyed by full endpoint path
  let inputSchema: Record<string, unknown> | null = null;

  for (const pathObj of Object.values(spec.paths || {})) {
    const postOp = (pathObj as Record<string, unknown>)?.post as Record<string, unknown> | undefined;
    const reqBody = postOp?.requestBody as Record<string, unknown> | undefined;
    const content = reqBody?.content as Record<string, Record<string, unknown>> | undefined;
    const jsonContent = content?.["application/json"];

    if (jsonContent?.schema) {
      const schema = jsonContent.schema as Record<string, unknown>;

      // Handle $ref - resolve from components.schemas
      if (schema.$ref && typeof schema.$ref === "string") {
        const refPath = schema.$ref.replace("#/components/schemas/", "");
        const resolvedSchema = spec.components?.schemas?.[refPath] as Record<string, unknown> | undefined;
        if (resolvedSchema) {
          inputSchema = resolvedSchema;
          break;
        }
      } else if (schema.properties) {
        inputSchema = schema;
        break;
      }
    }
  }

  if (!inputSchema) {
    return { parameters: [], inputs: [] };
  }

  // Pass components.schemas for $ref resolution
  const schemaComponents = spec.components?.schemas as Record<string, unknown> | undefined;
  return extractParametersFromSchema(inputSchema, schemaComponents);
}

/**
 * Extract ModelParameters and ModelInputs from an OpenAPI schema object
 */
function extractParametersFromSchema(
  schema: Record<string, unknown>,
  schemaComponents?: Record<string, unknown>
): ExtractedSchema {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = (schema.required as string[]) || [];

  if (!properties) {
    return { parameters: [], inputs: [] };
  }

  const parameters: ModelParameter[] = [];
  const inputs: ModelInput[] = [];

  for (const [name, rawProp] of Object.entries(properties)) {
    // Resolve $ref if present (property-level references like { "$ref": "#/components/schemas/ImageUrl" })
    let prop = rawProp;
    if (rawProp.$ref && typeof rawProp.$ref === "string" && schemaComponents) {
      const resolved = resolveRef(rawProp.$ref as string, schemaComponents);
      if (resolved) {
        // Image URL wrapper objects (e.g. ImageUrl: {type: "object", properties: {url: ...}})
        // should be treated as string type for input detection
        const resolvedType = isImageUrlWrapperObject(resolved) ? "string" : resolved.type;
        prop = { ...resolved, ...rawProp, type: resolvedType || rawProp.type };
      }
    }
    // Handle anyOf/oneOf (common in OpenAPI 3.1 for nullable types, e.g. anyOf: [{$ref: "..."}, {type: "null"}])
    if (!prop.type && (prop.anyOf || prop.oneOf) && Array.isArray(prop.anyOf || prop.oneOf)) {
      const variants = (prop.anyOf || prop.oneOf) as Record<string, unknown>[];
      const nonNull = variants.find((s) => s.type !== "null");
      if (nonNull) {
        if (nonNull.$ref && typeof nonNull.$ref === "string" && schemaComponents) {
          const resolved = resolveRef(nonNull.$ref as string, schemaComponents);
          if (resolved) {
            const resolvedType = isImageUrlWrapperObject(resolved) ? "string" : resolved.type;
            prop = { ...prop, ...resolved, type: resolvedType };
          }
        } else if (nonNull.type) {
          prop = { ...prop, type: nonNull.type };
        }
      }
    }

    // Check if this is a connectable input (video, audio, image, or text)
    // Video/audio checks MUST come before image to prevent mislabeling
    if (isVideoInput(name, prop, schemaComponents)) {
      const resolvedType = resolvePropertyType(prop, schemaComponents).type;
      inputs.push({
        name,
        type: "video",
        required: required.includes(name),
        label: toLabel(name),
        description: (prop.description || rawProp.description) as string | undefined,
        isArray: resolvedType === "array",
      });
      continue;
    }

    if (isAudioInput(name, prop, schemaComponents)) {
      const resolvedType = resolvePropertyType(prop, schemaComponents).type;
      inputs.push({
        name,
        type: "audio",
        required: required.includes(name),
        label: toLabel(name),
        description: (prop.description || rawProp.description) as string | undefined,
        isArray: resolvedType === "array",
      });
      continue;
    }

    if (isImageInput(name, prop, schemaComponents)) {
      const resolvedType = resolvePropertyType(prop, schemaComponents).type;
      inputs.push({
        name,
        type: "image",
        required: required.includes(name),
        label: toLabel(name),
        description: (prop.description || rawProp.description) as string | undefined,
        isArray: resolvedType === "array",
      });
      continue;
    }

    if (isTextInput(name)) {
      inputs.push({
        name,
        type: "text",
        required: required.includes(name),
        label: toLabel(name),
        description: (prop.description || rawProp.description) as string | undefined,
        isArray: prop.type === "array",
      });
      continue;
    }

    // Otherwise it's a parameter (pass resolved prop for better type detection)
    const param = convertSchemaProperty(name, prop, required, schemaComponents);
    if (param) {
      parameters.push(param);
    }
  }

  // Sort parameters: priority params first, then alphabetically
  parameters.sort((a, b) => {
    const aIsPriority = PRIORITY_PARAMS.has(a.name);
    const bIsPriority = PRIORITY_PARAMS.has(b.name);
    if (aIsPriority && !bIsPriority) return -1;
    if (!aIsPriority && bIsPriority) return 1;
    return a.name.localeCompare(b.name);
  });

  // Sort inputs: required first, then by type (image before text), then alphabetically
  inputs.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    if (a.type !== b.type) return a.type === "image" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { parameters, inputs };
}

/**
 * Get hardcoded schema for Kie.ai models
 * Kie.ai doesn't have a schema discovery API, so we define these manually
 */
function getKieSchema(modelId: string): ExtractedSchema {
  // Common parameters for image models
  const imageParams: ModelParameter[] = [
    { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16"], default: "1:1" },
    { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
  ];

  // Flux-2 aspect ratios (includes auto and additional ratios)
  const flux2AspectRatios = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "auto"];

  // Model-specific schemas
  const schemas: Record<string, ExtractedSchema> = {
    // ============ Image models ============
    "z-image": {
      parameters: imageParams,
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "seedream/4.5-text-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"], default: "1:1" },
        { name: "quality", type: "string", description: "Output quality", enum: ["basic", "high"], default: "basic" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "seedream/4.5-edit": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"], default: "1:1" },
        { name: "quality", type: "string", description: "Output quality", enum: ["basic", "high"], default: "basic" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "gpt-image/1.5-text-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "2:3", "3:2"], default: "3:2" },
        { name: "quality", type: "string", description: "Output quality", enum: ["medium", "high"], default: "medium" },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "gpt-image/1.5-image-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "2:3", "3:2"], default: "3:2" },
        { name: "quality", type: "string", description: "Output quality", enum: ["medium", "high"], default: "medium" },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "input_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "flux-2/pro-text-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: flux2AspectRatios, default: "1:1" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K"], default: "1K" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "flux-2/pro-image-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: flux2AspectRatios, default: "1:1" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K"], default: "1K" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "input_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "flux-2/flex-text-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: flux2AspectRatios, default: "1:1" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K"], default: "1K" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "flux-2/flex-image-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: flux2AspectRatios, default: "1:1" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K"], default: "1K" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "input_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "nano-banana-pro": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "2:3", "3:2", "4:3", "16:9", "9:16", "21:9", "auto"], default: "1:1" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K", "4K"], default: "1K" },
        { name: "output_format", type: "string", description: "Output format", enum: ["png", "jpg"], default: "png" },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "image_input", type: "image", required: false, label: "Image", isArray: true },
      ],
    },
    "grok-imagine/text-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["2:3", "3:2", "1:1", "16:9", "9:16"], default: "1:1" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "grok-imagine/image-to-image": {
      parameters: [],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    // ============ Audio/TTS models ============
    "elevenlabs/turbo-v2.5": {
      parameters: [
        { name: "voice_id", type: "string", description: "Voice ID to use for synthesis" },
        { name: "stability", type: "number", description: "Voice stability (0-1)", default: 0.5, minimum: 0, maximum: 1 },
        { name: "similarity_boost", type: "number", description: "Similarity boost (0-1)", default: 0.75, minimum: 0, maximum: 1 },
        { name: "output_format", type: "string", description: "Audio output format", enum: ["mp3_44100_128", "mp3_44100_192", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"], default: "mp3_44100_128" },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Text" }],
    },
    "elevenlabs/multilingual-v2": {
      parameters: [
        { name: "voice_id", type: "string", description: "Voice ID to use for synthesis" },
        { name: "stability", type: "number", description: "Voice stability (0-1)", default: 0.5, minimum: 0, maximum: 1 },
        { name: "similarity_boost", type: "number", description: "Similarity boost (0-1)", default: 0.75, minimum: 0, maximum: 1 },
        { name: "output_format", type: "string", description: "Audio output format", enum: ["mp3_44100_128", "mp3_44100_192", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"], default: "mp3_44100_128" },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Text" }],
    },
    "elevenlabs/text-to-dialogue-v3": {
      parameters: [
        { name: "stability", type: "number", description: "Voice stability (0-1)", default: 0.5, minimum: 0, maximum: 1 },
        { name: "similarity_boost", type: "number", description: "Similarity boost (0-1)", default: 0.75, minimum: 0, maximum: 1 },
        { name: "output_format", type: "string", description: "Audio output format", enum: ["mp3_44100_128", "mp3_44100_192", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"], default: "mp3_44100_128" },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Text / Dialogue Script" }],
    },
    "elevenlabs/sound-effect-v2": {
      parameters: [
        { name: "duration_seconds", type: "number", description: "Duration in seconds (0.5-22)", minimum: 0.5, maximum: 22 },
        { name: "loop", type: "boolean", description: "Enable smooth looping", default: false },
        { name: "prompt_influence", type: "number", description: "How closely to follow the prompt (0-1)", default: 0.3, minimum: 0, maximum: 1 },
        { name: "output_format", type: "string", description: "Audio output format", enum: ["mp3_44100_128", "mp3_44100_192", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"], default: "mp3_44100_128" },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Sound Description" }],
    },
    // ============ Video models ============
    "grok-imagine/text-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["2:3", "3:2", "1:1", "16:9", "9:16"], default: "2:3" },
        { name: "duration", type: "string", description: "Video duration in seconds", enum: ["6", "10"], default: "6" },
        { name: "mode", type: "string", description: "Generation mode", enum: ["fun", "normal", "spicy"], default: "normal" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "grok-imagine/image-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["2:3", "3:2", "1:1", "16:9", "9:16"], default: "2:3" },
        { name: "duration", type: "string", description: "Video duration in seconds", enum: ["6", "10"], default: "6" },
        { name: "mode", type: "string", description: "Generation mode", enum: ["fun", "normal", "spicy"], default: "normal" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "kling-2.6/text-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
        { name: "duration", type: "string", description: "Video duration", enum: ["5", "10"], default: "5" },
        { name: "sound", type: "boolean", description: "Enable sound generation", default: true },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "kling-2.6/image-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
        { name: "duration", type: "string", description: "Video duration", enum: ["5", "10"], default: "5" },
        { name: "sound", type: "boolean", description: "Enable sound generation", default: true },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "kling-2.6/motion-control": {
      parameters: [
        { name: "mode", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "720p" },
        { name: "character_orientation", type: "string", description: "Character orientation source", enum: ["image", "video"], default: "video" },
      ],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "input_urls", type: "image", required: true, label: "Image", isArray: true },
        { name: "video_urls", type: "video", required: true, label: "Video", isArray: true },
      ],
    },
    "kling/v2-5-turbo-text-to-video-pro": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
        { name: "duration", type: "string", description: "Video duration", enum: ["5", "10"], default: "5" },
        { name: "cfg_scale", type: "number", description: "Guidance scale", minimum: 0, maximum: 1, default: 0.5 },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "negative_prompt", type: "text", required: false, label: "Negative Prompt" },
      ],
    },
    "kling/v2-5-turbo-image-to-video-pro": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
        { name: "duration", type: "string", description: "Video duration", enum: ["5", "10"], default: "5" },
        { name: "cfg_scale", type: "number", description: "Guidance scale", minimum: 0, maximum: 1, default: 0.5 },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "negative_prompt", type: "text", required: false, label: "Negative Prompt" },
        { name: "image_url", type: "image", required: true, label: "Image" },
        { name: "tail_image_url", type: "image", required: false, label: "Tail Image" },
      ],
    },
    "wan/2-6-text-to-video": {
      parameters: [
        { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "10", "15"], default: "5" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "1080p" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "wan/2-6-image-to-video": {
      parameters: [
        { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "10", "15"], default: "5" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "1080p" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "wan/2-6-video-to-video": {
      parameters: [
        { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "10"], default: "5" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "1080p" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "video_urls", type: "video", required: true, label: "Video", isArray: true },
      ],
    },
    "runway/aleph-video-to-video": {
      parameters: [
        { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "10"], default: "5" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "720p" },
      ],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "video_url", type: "video", required: true, label: "Video" },
      ],
    },
    "luma/modify-video": {
      parameters: [
        { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "10"], default: "5" },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "video_url", type: "video", required: true, label: "Video" },
      ],
    },
    "topaz/video-upscale": {
      parameters: [
        { name: "upscale_factor", type: "string", description: "Upscale factor", enum: ["1", "2", "4"], default: "2" },
      ],
      inputs: [
        { name: "video_url", type: "video", required: true, label: "Video" },
      ],
    },
    "veo3/text-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
        { name: "seeds", type: "integer", description: "Random seed (10000-99999)", minimum: 10000, maximum: 99999 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "veo3/image-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
        { name: "seeds", type: "integer", description: "Random seed (10000-99999)", minimum: 10000, maximum: 99999 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "imageUrls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "veo3-fast/text-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
        { name: "seeds", type: "integer", description: "Random seed (10000-99999)", minimum: 10000, maximum: 99999 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "veo3-fast/image-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
        { name: "seeds", type: "integer", description: "Random seed (10000-99999)", minimum: 10000, maximum: 99999 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "imageUrls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
  };

  return schemas[modelId] || { parameters: [], inputs: [] };
}

/**
 * Cache for muapi.ai OpenAPI spec (fetched once, cached 24h).
 * This gives us the full schema for every model including all optional parameters.
 */
let muapiOpenApiCache: { spec: Record<string, unknown>; timestamp: number } | null = null;
const MUAPI_OPENAPI_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch the muapi.ai OpenAPI spec (cached 24h).
 */
async function fetchMuapiOpenApiSpec(): Promise<Record<string, unknown> | null> {
  if (muapiOpenApiCache && Date.now() - muapiOpenApiCache.timestamp < MUAPI_OPENAPI_TTL) {
    return muapiOpenApiCache.spec;
  }
  try {
    console.log(`[muapi openapi] Fetching OpenAPI spec...`);
    const resp = await fetch("https://api.muapi.ai/openapi.json", { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      console.log(`[muapi openapi] Failed: ${resp.status}`);
      return null;
    }
    const spec = await resp.json() as Record<string, unknown>;
    muapiOpenApiCache = { spec, timestamp: Date.now() };
    const paths = Object.keys((spec.paths || {}) as Record<string, unknown>);
    console.log(`[muapi openapi] Loaded ${paths.length} endpoints`);
    return spec;
  } catch (e) {
    console.log(`[muapi openapi] Error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Extract schema for a specific model from the muapi OpenAPI spec.
 * Returns parameters + inputs by parsing the request body schema.
 */
function extractMuapiOpenApiSchema(spec: Record<string, unknown>, modelId: string): ExtractedSchema | null {
  const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return null;

  // Find the path for this model
  const pathKey = `/api/v1/${modelId}`;
  const pathDef = paths[pathKey] as Record<string, unknown> | undefined;
  if (!pathDef) return null;

  const postDef = pathDef.post as Record<string, unknown> | undefined;
  if (!postDef) return null;

  // Get the request body schema ref
  const requestBody = postDef.requestBody as Record<string, unknown> | undefined;
  const content = requestBody?.content as Record<string, Record<string, unknown>> | undefined;
  const jsonSchema = content?.["application/json"]?.schema as Record<string, unknown> | undefined;
  if (!jsonSchema) return null;

  // Resolve $ref to get actual schema
  let schema: Record<string, unknown> | null = null;
  if (jsonSchema.$ref && typeof jsonSchema.$ref === "string") {
    const refPath = (jsonSchema.$ref as string).replace("#/", "").split("/");
    let resolved: unknown = spec;
    for (const part of refPath) {
      resolved = (resolved as Record<string, unknown>)?.[part];
    }
    schema = resolved as Record<string, unknown> | null;
  } else {
    schema = jsonSchema;
  }

  if (!schema?.properties) return null;

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const required = (schema.required || []) as string[];
  const components = spec.components as Record<string, unknown> | undefined;

  // Fields to skip entirely
  const skipFields = new Set(["webhook_url", "webhook"]);

  // Connectable input field patterns (image/video/audio/text URLs and lists)
  const isInputField = (name: string, prop: Record<string, unknown>): "image" | "video" | "audio" | "text" | null => {
    if (name === "prompt" || name === "negative_prompt" || name === "text") return "text";
    const format = prop.format as string | undefined;
    const isUrl = format === "uri" || name.endsWith("_url") || name.endsWith("_urls") || name === "images_list";
    if (!isUrl) return null;
    if (name.includes("audio")) return "audio";
    if (name.includes("video")) return "video";
    return "image"; // image_url, images_list, face_url, etc.
  };

  const parameters: ModelParameter[] = [];
  const inputs: ModelInput[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    if (skipFields.has(name)) continue;

    // Resolve anyOf/oneOf (nullable types)
    let effectiveProp = prop;
    const anyOf = prop.anyOf as Array<Record<string, unknown>> | undefined;
    if (anyOf) {
      const nonNull = anyOf.find(v => v.type !== "null");
      if (nonNull) effectiveProp = { ...prop, ...nonNull };
    }

    const inputType = isInputField(name, effectiveProp);
    if (inputType) {
      const isArray = effectiveProp.type === "array" || name.endsWith("_list") || name.endsWith("_urls");
      inputs.push({
        name,
        type: inputType,
        required: required.includes(name),
        label: name.replace(/_url$/, "").replace(/_urls$/, "").replace(/_list$/, "")
          .replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
        ...(isArray ? { isArray: true } : {}),
      });
    } else {
      // It's a parameter
      const param: ModelParameter = {
        name,
        type: effectiveProp.type === "integer" ? "integer" :
              effectiveProp.type === "number" ? "number" :
              effectiveProp.type === "boolean" ? "boolean" : "string",
        description: (effectiveProp.title || effectiveProp.description || name.replace(/_/g, " ")) as string,
      };
      if (effectiveProp.enum) param.enum = effectiveProp.enum as (string | number)[];
      if (effectiveProp.default !== undefined) param.default = effectiveProp.default;
      if (effectiveProp.minimum !== undefined) param.minimum = effectiveProp.minimum as number;
      if (effectiveProp.maximum !== undefined) param.maximum = effectiveProp.maximum as number;
      parameters.push(param);
    }
  }

  if (parameters.length === 0 && inputs.length === 0) return null;

  console.log(`[muapi openapi] ${modelId}: ${parameters.length} params (${parameters.map(p => p.name).join(", ")}), ${inputs.length} inputs (${inputs.map(i => i.name).join(", ")})`);
  return { parameters, inputs };
}

/**
 * Get schema for muapi.ai models.
 * Priority: 1) OpenAPI spec (exact schema with all params), 2) slug-based fallback.
 */
async function getMuapiSchema(modelId: string, _apiKey: string | null): Promise<ExtractedSchema> {
  const id = modelId.toLowerCase();

  // Try OpenAPI spec first — this gives us the exact schema for every model
  const spec = await fetchMuapiOpenApiSpec();
  if (spec) {
    const openApiSchema = extractMuapiOpenApiSchema(spec, id);
    if (openApiSchema && (openApiSchema.parameters.length > 0 || openApiSchema.inputs.length > 0)) {
      return openApiSchema;
    }
  }

  // Fallback: slug-based inference (model-specific overrides + generic patterns)
  console.log(`[muapi] No OpenAPI schema for ${id}, using slug fallback`);
  return getMuapiSlugSchema(id);
}

function getMuapiSlugSchema(id: string): ExtractedSchema {

  // Common parameters — no defaults on generic params to avoid sending values that
  // specific models reject. The UI shows "Default" and lets each model's API decide.
  const aspectRatio: ModelParameter = { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16"] };
  const videoAspectRatio: ModelParameter = { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"] };
  const resolution: ModelParameter = { name: "resolution", type: "string", description: "Output resolution", enum: ["480p", "720p", "1080p"] };
  const duration: ModelParameter = { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "8", "10"] };
  const seed: ModelParameter = { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 };

  // === Model-specific overrides (before generic pattern matching) ===

  // Nano Banana 2 Edit: needs images_list (array), supports resolution + aspect_ratio
  const nb2EditResolution: ModelParameter = { name: "resolution", type: "string", description: "Output resolution", enum: ["1k", "2k", "4k"], default: "1k" };
  if (id === "nano-banana-2-edit") {
    return {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "1:4", "4:1", "1:8", "8:1"], default: "1:1" },
        nb2EditResolution,
        seed,
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "images_list", type: "image", required: true, label: "Image", isArray: true },
      ],
    };
  }

  // Nano Banana Pro Edit: similar to NB2 edit
  if (id === "nano-banana-pro-edit") {
    return {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16"], default: "1:1" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["1k", "2k", "4k"], default: "1k" },
        seed,
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "images_list", type: "image", required: true, label: "Image", isArray: true },
      ],
    };
  }

  // Nano Banana Edit (original): similar structure
  if (id === "nano-banana-edit") {
    return {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16"], default: "1:1" },
        seed,
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "images_list", type: "image", required: true, label: "Image", isArray: true },
      ],
    };
  }

  // Veo 3.1 models: fixed duration=8, limited aspect ratios, uses images_list for I2V
  const veo31AspectRatio: ModelParameter = { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" };
  const veo3AspectRatio: ModelParameter = { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" };
  const veo31Duration: ModelParameter = { name: "duration", type: "integer", description: "Video duration in seconds (fixed)", enum: ["8"], default: "8" };

  if (id.startsWith("veo3.1") && (id.includes("i2v") || id.includes("image-to-video") || id.includes("reference-to-video"))) {
    return {
      parameters: [veo31AspectRatio, veo31Duration, seed],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "images_list", type: "image", required: true, label: "Image", isArray: true },
      ],
    };
  }

  if (id.startsWith("veo3.1") && (id.includes("t2v") || id.includes("text-to-video") || id.includes("4k-video") || id.includes("extend"))) {
    return {
      parameters: [veo31AspectRatio, veo31Duration, seed],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
      ],
    };
  }

  // Veo 3 (non-3.1) models: more flexible duration
  if (id.startsWith("veo3") && (id.includes("i2v") || id.includes("image-to-video"))) {
    return {
      parameters: [veo3AspectRatio, duration, seed],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "images_list", type: "image", required: true, label: "Image", isArray: true },
      ],
    };
  }

  if (id.startsWith("veo3") && (id.includes("t2v") || id.includes("text-to-video"))) {
    return {
      parameters: [veo3AspectRatio, duration, seed],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
      ],
    };
  }

  // Seedance I2V models: need first_frame + last_frame (not generic image_url)
  const seedanceQuality: ModelParameter = { name: "quality", type: "string", description: "Output quality", enum: ["basic", "high"], default: "basic" };
  if (id.includes("seedance") && (id.includes("i2v") || id.includes("image-to-video"))) {
    return {
      parameters: [videoAspectRatio, duration, seedanceQuality, seed],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "first_frame", type: "image", required: true, label: "First Frame" },
        { name: "last_frame", type: "image", required: false, label: "Last Frame" },
      ],
    };
  }

  // Start-end video models (Vidu etc.): need start_image + end_image
  if (id.includes("start-end-video")) {
    return {
      parameters: [videoAspectRatio, duration, seed],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "start_image", type: "image", required: true, label: "Start Image" },
        { name: "end_image", type: "image", required: false, label: "End Image" },
      ],
    };
  }

  // === Generic pattern matching ===
  // Note: muapi ignores unknown parameters, so it's safe to include common optional
  // params broadly. This ensures the UI exposes settings even when the probe can't
  // discover them (the probe only finds required fields via validation errors).

  // Common optional parameters shared across categories
  // No defaults — the UI shows "Default" and lets the API use its own default per model.
  // Setting defaults here caused errors when models only accept specific values (e.g. veo3.1 duration=8 only).
  const videoQuality: ModelParameter = { name: "quality", type: "string", description: "Output quality", enum: ["basic", "high"] };
  const imageResolution: ModelParameter = { name: "resolution", type: "string", description: "Output resolution", enum: ["1k", "2k", "4k"] };

  // Video-to-video models: need video_url input
  if (id.includes("v2v") || id.includes("video-to-video") || id.includes("video-edit") ||
      id.includes("video-face-swap") || id.includes("video-translate") ||
      id.includes("video-upscaler") || id.includes("video-extend") ||
      id.includes("video-watermark") || id.includes("motion-control") ||
      id.includes("video-combiner") || id.includes("clipping") ||
      id.includes("animate") || id.includes("edit-video") ||
      id.includes("remix-video") || id.includes("captions") ||
      id.includes("luma-modify") || id.includes("luma-flash") ||
      id.includes("runway-aleph") || id.includes("dance-effects")) {
    return {
      parameters: [videoAspectRatio, duration, seed],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "video_url", type: "image", required: true, label: "Video" },
      ],
    };
  }

  // Lipsync / avatar models: need image + audio
  if (id.includes("lipsync") || id.includes("avatar") || id.includes("speech-to-video")) {
    return {
      parameters: [seed],
      inputs: [
        { name: "image_url", type: "image", required: true, label: "Image" },
        { name: "audio_url", type: "image", required: true, label: "Audio" },
      ],
    };
  }

  // Image-to-video models: need image_url input
  if (id.includes("i2v") || id.includes("image-to-video") || id.includes("reference-to-video") ||
      id.includes("reference-video") || id.includes("start-end-video") ||
      id.includes("video-effects") || id.includes("vfx") || id.includes("motion-controls")) {
    return {
      parameters: [videoAspectRatio, resolution, duration, videoQuality, seed],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "image_url", type: "image", required: true, label: "Image" },
      ],
    };
  }

  // Text-to-video models
  if (id.includes("t2v") || id.includes("text-to-video") || id.includes("4k-video")) {
    return {
      parameters: [videoAspectRatio, resolution, duration, videoQuality, seed],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
      ],
    };
  }

  // Image-to-image models: need image_url input
  if (id.includes("i2i") || id.includes("image-to-image") || id.includes("-edit") ||
      id.includes("face-swap") || id.includes("upscaler") || id.includes("upscale") ||
      id.includes("background-remover") || id.includes("object-eraser") ||
      id.includes("skin-enhancer") || id.includes("color-photo") ||
      id.includes("product-shot") || id.includes("product-photography") ||
      id.includes("ghibli-style") || id.includes("image-extension") ||
      id.includes("watermark") || id.includes("pulid") || id.includes("redux") ||
      id.includes("reframe") || id.includes("character") || id.includes("reference-to-image") ||
      id.includes("effects") || id.includes("photo-pack") || id.includes("portrait-stylist") ||
      id.includes("dress-change") || id.includes("omni-reference") || id.includes("style-reference")) {
    return {
      parameters: [aspectRatio, imageResolution, seed],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "image_url", type: "image", required: true, label: "Image" },
      ],
    };
  }

  // Audio models
  if (id.includes("music") || id.includes("audio") || id.includes("speech") ||
      id.includes("vocals") || id.includes("instrumental") || id.includes("sounds") ||
      id.includes("voice-clone") || id.includes("lyrics") || id.includes("mashup")) {
    return {
      parameters: [seed],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Text" },
      ],
    };
  }

  // Default: text-to-image
  return {
    parameters: [aspectRatio, imageResolution, seed],
    inputs: [
      { name: "prompt", type: "text", required: true, label: "Prompt" },
    ],
  };
}

/**
 * Get schema for Gemini video models (native Veo via Gemini API)
 * Returns null if the model is not a Gemini video model.
 */
function getGeminiVideoSchema(modelId: string): ExtractedSchema | null {
  const commonParams: ModelParameter[] = [
    { name: "aspectRatio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
    { name: "durationSeconds", type: "string", description: "Video duration in seconds", enum: ["4", "6", "8"], default: "8" },
    { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p", "4k"], default: "720p" },
    { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
  ];

  const textInputs: ModelInput[] = [
    { name: "prompt", type: "text", required: true, label: "Prompt" },
    { name: "negative_prompt", type: "text", required: false, label: "Neg. Prompt" },
  ];

  const schemas: Record<string, ExtractedSchema> = {
    "veo-3.1/text-to-video": {
      parameters: commonParams,
      inputs: textInputs,
    },
    "veo-3.1/image-to-video": {
      parameters: commonParams,
      inputs: [
        ...textInputs,
        { name: "image", type: "image", required: true, label: "Image" },
      ],
    },
    "veo-3.1-fast/text-to-video": {
      parameters: commonParams,
      inputs: textInputs,
    },
    "veo-3.1-fast/image-to-video": {
      parameters: commonParams,
      inputs: [
        ...textInputs,
        { name: "image", type: "image", required: true, label: "Image" },
      ],
    },
  };

  return schemas[modelId] ?? null;
}

/**
 * Get static schema for WaveSpeed models (fallback when dynamic schema not available)
 */
function getStaticWaveSpeedSchema(modelId: string): ExtractedSchema {
  const modelIdLower = modelId.toLowerCase();

  // Common image generation parameters for FLUX, SD3, etc.
  const imageParams: ModelParameter[] = [
    {
      name: "num_inference_steps",
      type: "integer",
      description: "Number of denoising steps. More steps usually lead to higher quality but slower generation.",
      default: 28,
      minimum: 1,
      maximum: 100,
    },
    {
      name: "guidance_scale",
      type: "number",
      description: "Guidance scale for classifier-free guidance. Higher values follow the prompt more closely.",
      default: 3.5,
      minimum: 0,
      maximum: 20,
    },
    {
      name: "seed",
      type: "integer",
      description: "Random seed for reproducibility. Use -1 for random.",
      default: -1,
    },
    {
      name: "image_size",
      type: "string",
      description: "Output image dimensions",
      default: "1024x1024",
      enum: ["512x512", "768x768", "1024x1024", "1024x576", "576x1024", "1024x768", "768x1024", "1280x720", "720x1280"],
    },
  ];

  // Image inputs for image-to-image models
  const imageInputs: ModelInput[] = [];

  // Video model parameters (WAN, Kling, Luma, etc.)
  const videoParams: ModelParameter[] = [
    {
      name: "num_frames",
      type: "integer",
      description: "Number of frames to generate",
      default: 81,
      minimum: 16,
      maximum: 256,
    },
    {
      name: "fps",
      type: "integer",
      description: "Frames per second for the output video",
      default: 16,
      minimum: 8,
      maximum: 30,
    },
    {
      name: "seed",
      type: "integer",
      description: "Random seed for reproducibility. Use -1 for random.",
      default: -1,
    },
    {
      name: "resolution",
      type: "string",
      description: "Output video resolution",
      default: "480p",
      enum: ["480p", "720p", "1080p"],
    },
  ];

  // Check if it's a video model
  const isVideoModel =
    modelIdLower.includes("wan") ||
    modelIdLower.includes("video") ||
    modelIdLower.includes("kling") ||
    modelIdLower.includes("luma") ||
    modelIdLower.includes("minimax") ||
    modelIdLower.includes("t2v") ||
    modelIdLower.includes("i2v");

  // Check if it's an image-to-image model
  const isImg2ImgModel =
    modelIdLower.includes("kontext") ||
    modelIdLower.includes("img2img") ||
    modelIdLower.includes("edit") ||
    modelIdLower.includes("inpaint") ||
    modelIdLower.includes("controlnet");

  if (isVideoModel) {
    // For i2v models, add image input
    if (modelIdLower.includes("i2v")) {
      imageInputs.push({
        name: "image",  // i2v models typically use singular "image"
        type: "image",
        required: true,
        label: "Input Image",
        description: "Starting image for video generation",
      });
    }
    return { parameters: videoParams, inputs: imageInputs };
  }

  // Image generation model
  if (isImg2ImgModel) {
    imageInputs.push({
      name: "images",  // WaveSpeed edit models expect "images" (plural array)
      type: "image",
      required: true,
      label: "Input Image",
      description: "Image to transform or edit",
      isArray: true,  // Signal that this should be sent as an array
    });

    // Add strength parameter for img2img
    imageParams.push({
      name: "strength",
      type: "number",
      description: "How much to transform the input image. 0 = no change, 1 = ignore input completely.",
      default: 0.8,
      minimum: 0,
      maximum: 1,
    });
  }

  return { parameters: imageParams, inputs: imageInputs };
}

// WaveSpeed API base URL
const WAVESPEED_API_BASE = "https://api.wavespeed.ai/api/v3";

/**
 * Fetch WaveSpeed schema dynamically from cache or API
 * Falls back to static schema if dynamic schema not available
 */
async function fetchWaveSpeedSchema(
  modelId: string,
  apiKey: string | null
): Promise<ExtractedSchema> {
  // First check if we have a cached schema from the models list
  const cachedSchema = getCachedWaveSpeedSchema(modelId);
  if (cachedSchema) {
    console.log(`[WaveSpeed Schema] Using cached schema for ${modelId}`);
    const result = extractWaveSpeedSchema(cachedSchema, modelId);
    if (result.parameters.length > 0 || result.inputs.length > 0) {
      return result;
    }
  }

  // If no cache and we have an API key, try fetching the model directly
  if (apiKey) {
    try {
      console.log(`[WaveSpeed Schema] Fetching schema for ${modelId} from API`);
      const response = await fetch(`${WAVESPEED_API_BASE}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json();
        const models = data.models || data.data || data.results || [];

        // Find the model by ID
        const model = models.find((m: Record<string, unknown>) => {
          const id = m.model_id || m.id || m.modelId || m.name;
          return id === modelId;
        });

        if (model?.api_schema) {
          // Cache the schema for future use
          setCachedWaveSpeedSchema(modelId, model.api_schema as WaveSpeedApiSchema);

          const result = extractWaveSpeedSchema(model.api_schema as WaveSpeedApiSchema, modelId);
          if (result.parameters.length > 0 || result.inputs.length > 0) {
            console.log(`[WaveSpeed Schema] Found dynamic schema with ${result.parameters.length} params, ${result.inputs.length} inputs`);
            return result;
          }
        }
      }
    } catch (error) {
      console.warn(`[WaveSpeed Schema] Failed to fetch from API: ${error}`);
    }
  }

  // Fall back to static schema
  console.log(`[WaveSpeed Schema] Using static fallback for ${modelId}`);
  return getStaticWaveSpeedSchema(modelId);
}

/**
 * Extract parameters and inputs from WaveSpeed api_schema
 * Schema structure: { api_schemas: [{ request_schema: { properties, required } }] }
 */
function extractWaveSpeedSchema(
  apiSchema: WaveSpeedApiSchema,
  modelId: string
): ExtractedSchema {
  // WaveSpeed schema structure: api_schema.api_schemas[].request_schema
  const apiSchemas = apiSchema.api_schemas;
  if (!apiSchemas || !Array.isArray(apiSchemas) || apiSchemas.length === 0) {
    console.log(`[WaveSpeed Schema] No api_schemas array found for ${modelId}`);
    return { parameters: [], inputs: [] };
  }

  // Use the first schema (primary request schema)
  const requestSchema = apiSchemas[0]?.request_schema;
  if (!requestSchema || typeof requestSchema !== "object") {
    console.log(`[WaveSpeed Schema] No request_schema found for ${modelId}`);
    return { parameters: [], inputs: [] };
  }

  // Log the schema structure for debugging
  const schemaKeys = Object.keys(requestSchema);
  console.log(`[WaveSpeed Schema] Schema keys for ${modelId}: ${schemaKeys.join(", ")}`);

  // Extract parameters using the shared extraction function
  return extractParametersFromSchema(requestSchema as Record<string, unknown>);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
): Promise<NextResponse<SchemaResponse>> {
  // Await params before accessing properties
  const { modelId } = await params;
  const decodedModelId = decodeURIComponent(modelId);
  const provider = request.nextUrl.searchParams.get("provider") as ProviderType | null;

  const validProviders = ["replicate", "fal", "kie", "wavespeed", "gemini", "muapi"];
  if (!provider || !validProviders.includes(provider)) {
    return NextResponse.json<SchemaErrorResponse>(
      {
        success: false,
        error: `Invalid or missing provider. Use ?provider=${validProviders.join(", ?provider=")}`,
      },
      { status: 400 }
    );
  }

  // Check cache
  const cacheKey = `${provider}:${decodedModelId}`;
  const cached = schemaCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json<SchemaSuccessResponse>({
      success: true,
      parameters: cached.parameters,
      inputs: cached.inputs,
      cached: true,
    });
  }

  try {
    let result: ExtractedSchema;

    if (provider === "gemini") {
      // Gemini video models use hardcoded schemas
      const geminiVideoSchema = getGeminiVideoSchema(decodedModelId);
      if (geminiVideoSchema) {
        result = geminiVideoSchema;
      } else {
        // Gemini image models don't use schema endpoint (params are built-in)
        result = { parameters: [], inputs: [] };
      }
    } else if (provider === "replicate") {
      // User-provided key takes precedence over env variable
      const apiKey = request.headers.get("X-Replicate-Key") || process.env.REPLICATE_API_KEY;
      if (!apiKey) {
        return NextResponse.json<SchemaErrorResponse>(
          {
            success: false,
            error: "Replicate API key required. Add REPLICATE_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      }
      result = await fetchReplicateSchema(decodedModelId, apiKey);
    } else if (provider === "kie") {
      // Kie.ai uses hardcoded schemas (no schema discovery API)
      result = getKieSchema(decodedModelId);
    } else if (provider === "muapi") {
      // muapi.ai uses inferred schemas based on model slug patterns
      const muapiKey = request.headers.get("X-Muapi-API-Key") || process.env.MUAPI_API_KEY || null;
      result = await getMuapiSchema(decodedModelId, muapiKey);
    } else if (provider === "wavespeed") {
      // WaveSpeed uses dynamic schemas from API, with static fallback
      const apiKey = request.headers.get("X-WaveSpeed-Key") || process.env.WAVESPEED_API_KEY || null;
      result = await fetchWaveSpeedSchema(decodedModelId, apiKey);
    } else {
      // User-provided key takes precedence over env variable
      const apiKey = request.headers.get("X-Fal-Key") || process.env.FAL_API_KEY || null;
      if (!apiKey) {
        return NextResponse.json<SchemaErrorResponse>(
          {
            success: false,
            error: "fal.ai API key not configured. Add FAL_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      }
      result = await fetchFalSchema(decodedModelId, apiKey);
    }

    // Cache the result
    schemaCache.set(cacheKey, { ...result, timestamp: Date.now() });

    return NextResponse.json<SchemaSuccessResponse>({
      success: true,
      parameters: result.parameters,
      inputs: result.inputs,
      cached: false,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[ModelSchema] Error fetching ${decodedModelId}: ${errorMessage}`);
    return NextResponse.json<SchemaErrorResponse>(
      {
        success: false,
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}
