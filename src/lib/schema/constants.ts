/**
 * Constants shared by extraction, classification, and merging.
 * Centralized here so they're not duplicated across provider-specific code.
 */

/** Parameters never shown to the user — purely internal API plumbing. */
export const EXCLUDED_PARAMS = new Set<string>([
  "webhook",
  "webhook_url",
  "webhook_events_filter",
  "request_id",
]);

/** Parameters surfaced at the top of the list (most-often-edited settings). */
export const PRIORITY_PARAMS = new Set<string>([
  "aspect_ratio",
  "aspectRatio",
  "image_size",
  "resolution",
  "num_images",
  "num_inference_steps",
  "guidance_scale",
  "seed",
  "strength",
  "duration",
  "fps",
  "num_frames",
  "output_format",
  "output_quality",
  "negative_prompt",
]);

/** Property names we recognize as image inputs (exact match). */
export const IMAGE_INPUT_PATTERNS = [
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

/** Property names we recognize as video inputs (exact match). */
export const VIDEO_INPUT_PATTERNS = [
  "video_url",
  "video_urls",
  "video",
  "videos",
  "video_input",
  "input_video",
  "source_video",
];

/** Property names we recognize as audio inputs (exact match). */
export const AUDIO_INPUT_PATTERNS = [
  "audio_url",
  "audio_urls",
  "audio",
  "audio_input",
  "input_audio",
  "source_audio",
  "voice_audio",
];

/** Property names that LOOK like images but are actually config/dimension params. */
export const IMAGE_PREFIX_EXCLUSIONS = [
  "image_size", // union type (enum preset OR {width, height} object)
];

/** Regex patterns that indicate a param name is a config/format field, not a media input. */
export const CONFIG_SUFFIX_PATTERN = /_(type|mode|quality|format|codec|preset|style|method|strategy|size|count|length|duration|width|height|bitrate|rate|channels)$/;

/** Text input names. Small, hardcoded — text inputs are rare and well-known. */
export const TEXT_INPUT_NAMES = new Set<string>(["prompt", "negative_prompt"]);
