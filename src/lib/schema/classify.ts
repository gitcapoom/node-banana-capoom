/**
 * Classify NormalizedProperty as image / video / audio / text input, or parameter.
 *
 * Signals in priority order:
 *   1. Enum-check gate: properties with enums are dropdowns, never media inputs
 *   2. Format + name: `format: "binary"|"uri"|"data-uri"` AND name matches media hint
 *   3. Exact name match in INPUT_PATTERNS
 *   4. Description keywords ("url of the image", "video file", etc.)
 *   5. Name pattern fallback (starts with `video_`, ends with `_video_urls`,
 *      contains `_video_`, etc.), excluding config suffixes
 *
 * Do NOT widen the DESCRIPTION rules to catch plural list phrasing ("video
 * clips", "audio clips"). Providers routinely cross-reference every modality in
 * one field's description — all three MiniMax H3 reference fields end with
 * "Reference images, videos, and audio clips must add up to at most 12 files" —
 * so a `desc.includes("audio clip")` rule types the IMAGE field as audio, since
 * classifyInput runs video -> audio -> image and the first match wins. Name
 * rules are the safe place to generalize; descriptions are not.
 *
 * Deliberately NOT classified, because they are genuinely mixed-modality and
 * picking one pin type would be wrong: `reference_files` ("URLs to reference
 * images or videos"), `file_urls` ("images, videos, audio, PDFs"), `inputs`.
 * They stay parameters until there is a multi-type pin to put them on.
 *
 * The three media classifiers must stay SYMMETRIC. They drifted once: image had
 * an `_image_` infix rule that video and audio lacked, so a fal model exposing
 * reference_image_urls / reference_video_urls / reference_audio_urls surfaced
 * only the image list as a connectable pin and demoted the other two to text
 * boxes in the parameter panel. Add a rule to one, add it to all three.
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

/**
 * An array whose elements are strings — i.e. a LIST of URLs.
 *
 * This is the signal that separates a media list from a counter: `reference_images`
 * is an array of strings, `num_images` is an integer. Plural name rules are gated
 * on it so that widening them cannot resurrect the counter false-positives the
 * `_images` exclusion was originally added to prevent.
 *
 * `items` is treated as permissive when absent — a few provider schemas declare an
 * array without describing its element type.
 */
function isStringArray(prop: NormalizedProperty): boolean {
  if (prop.type !== "array") return false;
  return !prop.items || prop.items.type === "string";
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

  // Exclude names that LOOK like images but aren't.
  //
  // `_images` targets COUNTERS (max_images, num_images). It used to fire on any
  // name, which silently killed every real image LIST — reference_images,
  // input_images, init_images, keyframe_images, clothes_images, mask_images,
  // style_reference_images — 58 field-occurrences across the cached catalogue,
  // each demoted to a text box in the settings panel instead of a pin. Gating on
  // isStringArray keeps counters excluded (they are integers, and a string-typed
  // counter is still caught here) while letting URL lists through.
  const stringArray = isStringArray(prop);
  if (
    (name.includes("_images") && !stringArray) || // max_images, num_images
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
    // Explicit for symmetry with video/audio. Already covered by the `_image_`
    // infix below, but stating it keeps the three classifiers readable as one
    // rule set — the missing counterpart of this line is what broke video.
    name.endsWith("_image_urls") ||
    (name.startsWith("image_") && !name.includes("_size") && !name.includes("_count") && !name.includes("_scale")) ||
    name.includes("_image_") ||
    // Plural LISTS, array-gated (see isStringArray). `_mask_urls` covers fal's
    // reference_mask_urls; a mask is an image input like any other.
    (stringArray && (
      name.endsWith("_images") ||
      name.endsWith("_images_list") ||
      name.endsWith("_mask_urls")
    ))
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
    // Plural media LISTS: reference_video_urls, subject_video_urls. Without
    // this, an array-of-URL field is silently demoted to a panel parameter and
    // renders as a text box instead of a connectable pin.
    name.endsWith("_video_urls") ||
    // Infix, mirroring the `_image_` rule classifyImage has always had. That
    // asymmetry is the whole bug: reference_image_urls classified and
    // reference_video_urls did not, purely because video never got this rule.
    // Safe because the caller has already rejected non-string/array types,
    // enums, and CONFIG_SUFFIX_PATTERN names above.
    name.includes("_video_") ||
    (name.startsWith("video_") && !CONFIG_SUFFIX_PATTERN.test(name)) ||
    (isStringArray(prop) && (name.endsWith("_videos") || name.endsWith("_videos_list")))
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
    name.endsWith("_audio_urls") ||
    name.includes("_audio_") ||
    (name.startsWith("audio_") && !CONFIG_SUFFIX_PATTERN.test(name)) ||
    (isStringArray(prop) && (name.endsWith("_audios") || name.endsWith("_audios_list")))
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
