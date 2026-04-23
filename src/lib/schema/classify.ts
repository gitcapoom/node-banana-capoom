/**
 * Classify NormalizedProperty as image / video / audio / text input, or parameter.
 *
 * Signals in priority order:
 *   1. Enum-check gate: properties with enums are dropdowns, never media inputs
 *   2. Format + name: `format: "binary"|"uri"|"data-uri"` AND name matches media hint
 *   3. Exact name match in INPUT_PATTERNS
 *   4. Description keywords ("url of the image", "video file", etc.)
 *   5. Name pattern fallback (starts with `video_`, etc.), excluding config suffixes
 *
 * Records which signal triggered the decision for observability.
 */

import type { NormalizedProperty } from "./types";
import {
  IMAGE_INPUT_PATTERNS,
  VIDEO_INPUT_PATTERNS,
  AUDIO_INPUT_PATTERNS,
  IMAGE_PREFIX_EXCLUSIONS,
  CONFIG_SUFFIX_PATTERN,
  TEXT_INPUT_NAMES,
} from "./constants";

export type InputKind = "image" | "video" | "audio" | "text" | null;

export interface ClassifyDecision {
  kind: InputKind;
  signal: string; // for debugging: "exact-name" | "format+name" | "description" | "name-pattern"
}

/** Does the property have an enum (making it a dropdown)? Enums are never media inputs. */
function hasEnum(prop: NormalizedProperty): boolean {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return true;
  if (prop.unionVariants) {
    for (const v of prop.unionVariants) {
      if (Array.isArray(v.enum) && v.enum.length > 0) return true;
    }
  }
  return false;
}

/** Is the property's type (or any union variant) string or array? Media inputs are always URL strings. */
function isStringLike(prop: NormalizedProperty): boolean {
  if (prop.type === "string" || prop.type === "array") return true;
  if (prop.type === "union" && prop.unionVariants) {
    return prop.unionVariants.some((v) => v.type === "string" || v.type === "array");
  }
  return false;
}

function isBinaryFormat(prop: NormalizedProperty): boolean {
  const fmt = prop.format;
  return fmt === "uri" || fmt === "data-uri" || fmt === "binary";
}

// ---------------- Image ----------------

export function classifyImage(prop: NormalizedProperty): ClassifyDecision | null {
  const name = prop.name;
  if (!isStringLike(prop)) return null;
  if (hasEnum(prop)) return null;
  if (IMAGE_PREFIX_EXCLUSIONS.includes(name)) return null;
  if (CONFIG_SUFFIX_PATTERN.test(name)) return null;

  // Exclude names that LOOK like images but aren't
  if (
    name.includes("_images") ||    // max_images, num_images
    name.includes("guidance") ||   // image_guidance_scale
    name.includes("generation") || // sequential_image_generation
    name.includes("_count") ||
    name.includes("_scale")
  ) return null;

  // (1) Exact name match
  if (IMAGE_INPUT_PATTERNS.includes(name)) {
    return { kind: "image", signal: "exact-name" };
  }

  // (2) Format + name hint
  if (isBinaryFormat(prop)) {
    if (
      IMAGE_INPUT_PATTERNS.includes(name) ||
      name.endsWith("_image") ||
      name.startsWith("image_") ||
      name.includes("_image_")
    ) {
      return { kind: "image", signal: "format+name" };
    }
  }

  // (3) Description keywords
  const desc = (prop.description || "").toLowerCase();
  if (
    desc.includes("image url") ||
    desc.includes("base64 image") ||
    desc.includes("data uri") ||
    desc.includes("image file") ||
    desc.includes("url of the image") ||
    desc.includes("path to image")
  ) {
    return { kind: "image", signal: "description" };
  }

  // (4) Name pattern fallback
  if (
    name.endsWith("_image") ||
    name.endsWith("_image_url") ||
    (name.startsWith("image_") && !name.includes("_size") && !name.includes("_count") && !name.includes("_scale")) ||
    name.includes("_image_")
  ) {
    return { kind: "image", signal: "name-pattern" };
  }

  return null;
}

// ---------------- Video ----------------

export function classifyVideo(prop: NormalizedProperty): ClassifyDecision | null {
  const name = prop.name;
  if (!isStringLike(prop)) return null;
  if (hasEnum(prop)) return null;
  if (CONFIG_SUFFIX_PATTERN.test(name)) return null;

  if (VIDEO_INPUT_PATTERNS.includes(name)) {
    return { kind: "video", signal: "exact-name" };
  }

  const desc = (prop.description || "").toLowerCase();
  if (desc.includes("video url") || desc.includes("video file") || desc.includes("url of the video")) {
    return { kind: "video", signal: "description" };
  }

  if (
    name.endsWith("_video") ||
    name.endsWith("_video_url") ||
    (name.startsWith("video_") && !CONFIG_SUFFIX_PATTERN.test(name))
  ) {
    return { kind: "video", signal: "name-pattern" };
  }

  return null;
}

// ---------------- Audio ----------------

export function classifyAudio(prop: NormalizedProperty): ClassifyDecision | null {
  const name = prop.name;
  if (!isStringLike(prop)) return null;
  if (hasEnum(prop)) return null;
  if (CONFIG_SUFFIX_PATTERN.test(name)) return null;

  if (AUDIO_INPUT_PATTERNS.includes(name)) {
    return { kind: "audio", signal: "exact-name" };
  }

  const desc = (prop.description || "").toLowerCase();
  if (desc.includes("audio url") || desc.includes("audio file") || desc.includes("url of the audio")) {
    return { kind: "audio", signal: "description" };
  }

  if (
    name.endsWith("_audio") ||
    name.endsWith("_audio_url") ||
    (name.startsWith("audio_") && !CONFIG_SUFFIX_PATTERN.test(name))
  ) {
    return { kind: "audio", signal: "name-pattern" };
  }

  return null;
}

// ---------------- Text ----------------

export function classifyText(prop: NormalizedProperty): ClassifyDecision | null {
  if (TEXT_INPUT_NAMES.has(prop.name)) {
    return { kind: "text", signal: "exact-name" };
  }
  return null;
}

/**
 * Top-level classifier. Checks in order: video → audio → image → text.
 * Returns null if this property is a regular parameter (not a connectable input).
 */
export function classifyInput(prop: NormalizedProperty): ClassifyDecision | null {
  return (
    classifyVideo(prop) ||
    classifyAudio(prop) ||
    classifyImage(prop) ||
    classifyText(prop)
  );
}
