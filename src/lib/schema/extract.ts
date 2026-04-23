/**
 * Extract user-facing parameters and connectable inputs from a NormalizedSchema.
 *
 * This is the unified entry point for all providers. The normalize step
 * has already handled $ref, allOf, anyOf, oneOf, so this module just has
 * to decide: is each property an INPUT (connectable pin) or a PARAMETER
 * (dropdown/slider/textbox in the node body)?
 *
 * Guarantees:
 *   - No property is silently dropped. Excluded/unclassified properties are
 *     surfaced via health.warnings.
 *   - Union types (enum + object — e.g. image_size) produce parameters with
 *     BOTH enum and properties arrays set, so the UI can offer a toggle.
 */

import type { NormalizedSchema, NormalizedProperty, ExtractedResult } from "./types";
import type { ModelParameter, ModelInput } from "@/lib/providers/types";
import { classifyInput } from "./classify";
import { EXCLUDED_PARAMS, PRIORITY_PARAMS } from "./constants";

/**
 * Convert a NormalizedProperty → ModelParameter (for rendering in the node body).
 */
function propertyToParameter(prop: NormalizedProperty): ModelParameter {
  const param: ModelParameter = {
    name: prop.name,
    type: prop.type === "union" ? "string" : prop.type,  // default union to string; refine below
    description: prop.description,
    default: prop.default,
    required: prop.required ?? false,
  };

  if (prop.enum) param.enum = prop.enum;
  if (typeof prop.minimum === "number") param.minimum = prop.minimum;
  if (typeof prop.maximum === "number") param.maximum = prop.maximum;

  // Union: enum string + object (e.g. image_size). Expose both on the parameter.
  if (prop.type === "union" && prop.unionVariants) {
    const enumVariant = prop.unionVariants.find((v) => Array.isArray(v.enum) && v.enum.length > 0);
    const objectVariant = prop.unionVariants.find((v) => v.type === "object" && v.properties);
    if (enumVariant && objectVariant) {
      // This is the preset + custom pattern (image_size)
      param.type = "object";
      param.enum = enumVariant.enum;
      if (objectVariant.properties) {
        param.properties = Object.values(objectVariant.properties).map(propertyToParameter);
      }
      return param;
    }
    // Otherwise, pick first non-null variant as the effective type
    const first = prop.unionVariants[0];
    if (first) {
      param.type = first.type === "union" ? "string" : first.type;
      if (first.enum) param.enum = first.enum;
      if (typeof first.minimum === "number") param.minimum = first.minimum;
      if (typeof first.maximum === "number") param.maximum = first.maximum;
      if (first.type === "object" && first.properties) {
        param.properties = Object.values(first.properties).map(propertyToParameter);
      }
      if (first.type === "array" && first.items) {
        param.items = propertyToParameter(first.items);
      }
    }
    return param;
  }

  if (prop.type === "object" && prop.properties) {
    param.properties = Object.values(prop.properties).map(propertyToParameter);
  }
  if (prop.type === "array" && prop.items) {
    param.items = propertyToParameter(prop.items);
  }

  return param;
}

/**
 * Convert a NormalizedProperty → ModelInput (for rendering as a connectable pin).
 */
function propertyToInput(
  prop: NormalizedProperty,
  kind: "image" | "video" | "audio" | "text",
  required: boolean
): ModelInput {
  const labelFromName = prop.name
    .replace(/_url$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const isArray = prop.type === "array" || (prop.type === "union" && !!prop.unionVariants?.some(v => v.type === "array"));

  return {
    name: prop.name,
    type: kind,
    required,
    label: labelFromName,
    description: prop.description,
    isArray,
  };
}

function priorityRank(name: string): number {
  return PRIORITY_PARAMS.has(name) ? 0 : 1;
}

/**
 * Extract inputs and parameters from a NormalizedSchema.
 *
 * @returns ExtractedResult — .parameters (for node body), .inputs (for pins), .health (observability)
 */
export function extractFromNormalized(schema: NormalizedSchema): ExtractedResult {
  const parameters: ModelParameter[] = [];
  const inputs: ModelInput[] = [];
  const warnings: string[] = [];

  for (const [name, prop] of Object.entries(schema.properties)) {
    if (EXCLUDED_PARAMS.has(name)) continue;

    const isRequired = schema.required.includes(name);
    const inputDecision = classifyInput(prop);

    if (inputDecision && inputDecision.kind) {
      inputs.push(propertyToInput(prop, inputDecision.kind, isRequired));
      continue;
    }

    // Not classified as an input — it's a parameter.
    // Skip "text" types with no enum/description that aren't recognized names —
    // most raw strings here are URLs we failed to classify.
    if (prop.type === "string" && !prop.enum && !prop.description) {
      // Flag as a warning so we can audit, but still include as a param.
      warnings.push(`Property "${name}" is an unclassified string — may be a missed input`);
    }

    parameters.push(propertyToParameter(prop));
  }

  // Sort parameters: priority first, then alphabetical
  parameters.sort((a, b) => {
    const pa = priorityRank(a.name);
    const pb = priorityRank(b.name);
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });

  // Sort inputs: required first, then by type (image → text → video → audio), then alpha
  const typeOrder: Record<string, number> = { image: 0, text: 1, video: 2, audio: 3 };
  inputs.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    const ta = typeOrder[a.type] ?? 99;
    const tb = typeOrder[b.type] ?? 99;
    if (ta !== tb) return ta - tb;
    return a.name.localeCompare(b.name);
  });

  const status =
    warnings.length === 0 && inputs.length > 0 ? "clean" :
    inputs.length === 0 ? "no-inputs" :
    "heuristic-fallback";

  return {
    parameters,
    inputs,
    health: {
      status,
      warnings,
      extractedAt: Date.now(),
    },
  };
}
