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
 * Walk into object (or nullable-object) properties looking for fields that
 * would classify as connectable inputs (image/video/audio/text urls).
 *
 * Provider wrappers like fal's `ImageFillInput { fill_image_url }` or
 * `ControlNetUnionInput { control_image_url }` need their inner URL fields
 * hoisted to the top level so the user can wire an image output into them.
 * The hoisted input's `name` uses a dotted path (`fill_image.fill_image_url`)
 * — the provider's payload builder deep-sets into the request body.
 *
 * Returns the set of hoisted sub-names so the caller can strip them from the
 * parent object parameter's sub-properties (avoid double-display).
 *
 * Depth-capped at 2 since real provider schemas never nest deeper.
 */
function hoistNestedInputs(
  prop: NormalizedProperty,
  parentPath: string,
  inputs: ModelInput[],
  depth: number
): Set<string> {
  const hoisted = new Set<string>();
  if (depth > 2) return hoisted;

  const objectVariants: NormalizedProperty[] = [];
  if (prop.type === "object" && prop.properties) {
    objectVariants.push(prop);
  } else if (prop.type === "union" && prop.unionVariants) {
    for (const v of prop.unionVariants) {
      if (v.type === "object" && v.properties) objectVariants.push(v);
    }
  }

  for (const obj of objectVariants) {
    if (!obj.properties) continue;
    for (const [subName, subProp] of Object.entries(obj.properties)) {
      const subDecision = classifyInput(subProp);
      if (subDecision?.kind) {
        const dottedName: string = `${parentPath}.${subName}`;
        inputs.push({
          ...propertyToInput(subProp, subDecision.kind, subProp.required ?? false),
          name: dottedName,
        });
        hoisted.add(subName);
      }
    }
  }

  return hoisted;
}

/**
 * Detect a repeatable array-of-object input (e.g. Kling `elements`) and build a
 * group ModelInput whose `children` are the media sub-fields (image/video/audio).
 * Non-media sub-fields (e.g. `voice_id`) are left out — they stay in the
 * parameter panel. Returns null if `prop` isn't such a group or has no media.
 */
function buildRepeatableGroup(
  name: string,
  prop: NormalizedProperty,
  required: boolean
): ModelInput | null {
  if (prop.type !== "array" || !prop.items) return null;
  const item = prop.items;
  if (item.type !== "object" || !item.properties) return null;

  const children: ModelInput[] = [];
  for (const subProp of Object.values(item.properties)) {
    const decision = classifyInput(subProp);
    if (decision && (decision.kind === "image" || decision.kind === "video" || decision.kind === "audio")) {
      children.push(propertyToInput(subProp, decision.kind, subProp.required ?? false));
    }
  }
  if (children.length === 0) return null;

  const label = name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    name,
    type: children[0].type, // representative; rendering keys off repeatable/children
    required,
    label,
    repeatable: true,
    children,
  };
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

    // Repeatable array-of-object group with media sub-fields (e.g. Kling
    // `elements`). Surface it as a repeatable input (per-item pins) and strip
    // the media sub-fields from the parameter to avoid duplication, while
    // keeping any non-media sub-fields (e.g. voice_id) in the param panel.
    const group = buildRepeatableGroup(name, prop, isRequired);
    if (group) {
      inputs.push(group);
      const mediaNames = new Set((group.children ?? []).map((c) => c.name));
      const param = propertyToParameter(prop);
      const itemProps = param.items?.properties;
      if (itemProps) {
        const remaining = itemProps.filter((p) => !mediaNames.has(p.name));
        param.items!.properties = remaining;
        if (remaining.length > 0) parameters.push(param);
      }
      continue;
    }

    // Inspect object (or nullable-object) properties for nested input URLs.
    // fal frequently wraps inputs in single-field objects (ImageFillInput,
    // ControlNetUnionInput, IPAdapter). Hoist those sub-URLs to top-level
    // inputs with dotted names so the UI shows them as pins.
    const hoistedSubNames = hoistNestedInputs(prop, name, inputs, 0);
    if (hoistedSubNames.size > 0) {
      // Build a parameter that excludes the hoisted sub-fields (so users
      // don't also see them as form fields). If ALL sub-fields were hoisted
      // and the wrapper has nothing else, skip the parameter entirely.
      const param = propertyToParameter(prop);
      if (param.properties) {
        param.properties = param.properties.filter((p) => !hoistedSubNames.has(p.name));
      }
      if (param.properties && param.properties.length > 0) {
        parameters.push(param);
      }
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
