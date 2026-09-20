/**
 * Turn Luma's documented body parameters into node-banana's schema shape.
 *
 * This emits an `ExtractedResult` directly rather than going through
 * `normalizeOpenApiSchema` → `extractFromNormalized`, because the generic
 * classifier would get Luma wrong in two specific ways:
 *
 *  - `VIDEO_INPUT_PATTERNS` (src/lib/schema/constants.ts) contains the bare
 *    string `"video"`, and Luma's `video` is an OPTIONS OBJECT holding
 *    resolution, duration, hdr and the rest. The classifier would turn it into
 *    a video input pin and the real settings would vanish.
 *  - `IMAGE_INPUT_PATTERNS` contains neither `source` nor `image_ref`, so
 *    Luma's two actual image inputs would not become pins at all.
 *
 * Which fields apply depends on the generation TYPE, not just the model. Two
 * layers do that: a top-level options object named after a type family
 * (`video`, `layering`) belongs only to that family, and typeScope.ts carries
 * the per-field constraints Luma states in prose, each quoting its source.
 * Without the second layer an image node offers a `source` pin its own
 * validation rules forbid, and a reframe offers `loop` and `start_frame`,
 * which it rejects.
 */

import type { ExtractedResult } from "@/lib/schema/types";
import type { ModelInput, ModelParameter } from "@/lib/providers/types";
import { parseParamTree, type LumaParamNode } from "./parseDocs";
import { fieldAppliesToType } from "./typeScope";

/** Fields that carry media and should become connectable pins. */
const IMAGE_PIN_LEAVES = new Set([
  "source",
  "image_ref",
  "start_frame",
  "end_frame",
  "guide_frame",
  "keyframes",
]);

/** Leaves that hold a list. */
const ARRAY_LEAVES = new Set(["image_ref", "keyframes", "keyframe_indexes"]);

/** Options objects that belong to one type family only. */
const TYPE_SCOPED_OBJECTS: Record<string, (type: string) => boolean> = {
  video: (t) => t.startsWith("video"),
  layering: (t) => t === "layering",
};

function prettyLabel(name: string): string {
  return name
    .replace(/_urls?$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function paramType(node: LumaParamNode): ModelParameter["type"] {
  const spec = node.typeSpec;
  if (node.enumValues?.length || /"/.test(spec)) return "string";
  if (/\bboolean\b/.test(spec)) return "boolean";
  if (/\bnumber\b/.test(spec)) return "number";
  if (/\binteger\b/.test(spec)) return "integer";
  if (/\barray\b/.test(spec) || node.name.endsWith("_indexes")) return "array";
  if (node.children?.length || /\bobject\b/.test(spec)) return "object";
  return "string";
}

/** Enum members, preferring child bullets over the sometimes-truncated typespec. */
function enumOf(node: LumaParamNode): string[] | undefined {
  if (node.enumValues?.length) return node.enumValues;
  const inline = [...node.typeSpec.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return inline.length ? inline : undefined;
}

/**
 * Walk the tree, collecting pins and settings for one generation type.
 *
 * Nested fields keep their dotted path (`video.resolution`) because the
 * provider deep-sets them with setAtPath, so the name IS the wire location.
 */
function walk(
  nodes: LumaParamNode[],
  type: string,
  prefix: string,
  inputs: ModelInput[],
  parameters: ModelParameter[]
): void {
  for (const node of nodes) {
    const path = prefix ? `${prefix}.${node.name}` : node.name;

    // A type-scoped options object is skipped wholesale for other types, so an
    // image node never shows Ray 3.2's resolution and duration.
    if (!prefix) {
      const scope = TYPE_SCOPED_OBJECTS[node.name];
      if (scope && !scope(type)) continue;
    }

    // Per-field scoping, from the constraints Luma states in prose. Without
    // this an image node offers a `source` pin that its own validation rules
    // forbid, and a reframe offers loop and start_frame which it rejects.
    if (!fieldAppliesToType(path, type)) continue;

    // `model` and `type` are the address, not settings — the node already knows
    // them from its selected model id.
    if (!prefix && (node.name === "model" || node.name === "type")) continue;

    if (IMAGE_PIN_LEAVES.has(node.name)) {
      // `source` on a video edit or reframe carries the VIDEO being changed.
      const isVideoSource =
        node.name === "source" && (type === "video_edit" || type === "video_reframe");
      inputs.push({
        name: path,
        type: isVideoSource ? "video" : "image",
        required: !node.optional,
        label: prettyLabel(node.name),
        description: node.description,
        isArray: ARRAY_LEAVES.has(node.name),
      });
      continue;
    }

    if (node.name === "prompt" && !prefix) {
      inputs.push({
        name: "prompt",
        type: "text",
        required: !node.optional,
        label: "Prompt",
        description: node.description,
        isArray: false,
      });
      continue;
    }

    if (node.children?.length) {
      walk(node.children, type, path, inputs, parameters);
      continue;
    }

    parameters.push({
      name: path,
      type: paramType(node),
      description: node.description,
      required: !node.optional,
      ...(enumOf(node) ? { enum: enumOf(node) } : {}),
      ...(ARRAY_LEAVES.has(node.name) ? { type: "array" as const } : {}),
    });
  }
}

/**
 * Build the schema for one `"<model>/<type>"` id.
 *
 * `apiRefMd` is the API-reference markdown; pass null and this returns null
 * rather than an empty schema, so a docs outage reads as "unknown" instead of
 * "this model takes no inputs".
 */
export function buildLumaSchema(apiRefMd: string | null, modelId: string): ExtractedResult | null {
  if (!apiRefMd) return null;
  const tree = parseParamTree(apiRefMd);
  if (!tree) return null;

  const idx = modelId.lastIndexOf("/");
  const type = idx > 0 ? modelId.slice(idx + 1) : "image";

  const inputs: ModelInput[] = [];
  const parameters: ModelParameter[] = [];
  walk(tree, type, "", inputs, parameters);

  const warnings: string[] = [];
  // No warning for image_edit + aspect_ratio: the field is scoped out entirely
  // (see typeScope.ts), so there is nothing to warn about. Hiding a field the
  // model ignores beats offering it with a caveat nobody reads.
  if (type === "layering") {
    warnings.push("For layering the prompt steers how the image is split (max 500 characters); an empty prompt lets the planner decide.");
  }

  return {
    parameters,
    inputs,
    health: {
      status: "clean",
      warnings,
      extractedAt: Date.now(),
    },
  };
}
