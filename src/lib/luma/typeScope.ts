/**
 * Which Luma body fields apply to which generation type.
 *
 * Luma's request envelope is shared across all six types, but most fields are
 * valid for only some of them — and the constraints live in prose scattered
 * across the guides rather than in the schema. Offering a field the chosen type
 * rejects is not harmless: a wired `source` pin on a `type: "image"` node
 * produces a 422, and an offered `loop` on a reframe silently does nothing.
 *
 * Every rule below quotes the sentence it comes from, so it can be re-checked
 * when Luma changes the docs. Keyed on TYPE (six, structural) rather than on
 * model, which is discovered at runtime and never hardcoded.
 */

/** The six documented generation types. */
export const IMAGE_TYPES = ["image", "image_edit", "layering"] as const;
export const VIDEO_TYPES = ["video", "video_edit", "video_reframe"] as const;

type Rule = {
  /** Field path, or a prefix ending in "." to cover a whole subtree. */
  path: string;
  /** Types the field is valid for. */
  only: string[];
  /** The documentation sentence this encodes. */
  because: string;
};

const RULES: Rule[] = [
  {
    path: "source",
    only: ["image_edit", "layering", "video_edit", "video_reframe"],
    because:
      'Image generation, validation rules: source "Must be `null` or omitted for `type: \\"image\\"`".',
  },
  {
    path: "image_ref",
    only: ["image", "image_edit"],
    because:
      "Image generation: up to 9 references for type image, 8 for image_edit. Not a video input.",
  },
  {
    path: "style",
    only: ["image", "image_edit"],
    because: "Models guide: output formats and style presets apply to image models only.",
  },
  {
    path: "output_format",
    only: ["image", "image_edit"],
    because: 'Models guide, output formats: "Applies to image models only." Video is always MP4.',
  },
  {
    path: "web_search",
    only: ["image", "image_edit"],
    because: "Models guide lists web_search grounding under the image models' capabilities.",
  },
  {
    path: "aspect_ratio",
    only: ["image", "video", "video_reframe"],
    because:
      "Models guide: image_edit and video_edit derive output dimensions from the source, so the field is ignored there; reframe requires it.",
  },
  {
    path: "video.edit.",
    only: ["video_edit"],
    because:
      'Create-a-generation: video.edit is "Only valid under video.edit when type is video_edit."',
  },
  {
    path: "video.loop",
    only: ["video"],
    because:
      'Models guide: "loop is create-only (type: "video" only)"; reframe rejects it.',
  },
  {
    path: "video.start_frame",
    only: ["video"],
    because: "Models guide: video reframing rejects video.edit, loop, start_frame and end_frame.",
  },
  {
    path: "video.end_frame",
    only: ["video"],
    because: "Models guide: video reframing rejects video.edit, loop, start_frame and end_frame.",
  },
  {
    path: "video.guide_frame",
    only: ["video"],
    because: "Anchor frames are a create-time input; reframe and edit take their frames elsewhere.",
  },
  {
    path: "video.keyframes",
    only: ["video"],
    because:
      'Create-a-generation: video.keyframes is "(type=video only)"; video-to-video uses video.edit.keyframes.',
  },
  {
    path: "video.keyframe_indexes",
    only: ["video"],
    because: "Parallel to video.keyframes, so it shares its scope.",
  },
  {
    path: "video.source_position",
    only: ["video_reframe"],
    because:
      'Create-a-generation: source_position is the "Normalized source rectangle inside the output canvas for video_reframe."',
  },
  {
    path: "video.hdr",
    only: ["video", "video_edit"],
    because: 'Create-a-generation: hdr is "Not supported for video_reframe."',
  },
  {
    path: "video.exr_export",
    only: ["video", "video_edit"],
    because: "exr_export requires hdr, which reframe does not support.",
  },
];

/**
 * Is this field offered for this generation type?
 *
 * Unknown fields default to TRUE. A field Luma adds that nothing here mentions
 * should show up rather than be silently dropped — the same principle as an
 * unknown model being offered rather than hidden.
 */
export function fieldAppliesToType(path: string, type: string): boolean {
  for (const rule of RULES) {
    const matches = rule.path.endsWith(".") ? path.startsWith(rule.path) : path === rule.path;
    if (matches) return rule.only.includes(type);
  }
  return true;
}

/** The rule covering a path, for tests and for explaining a hidden field. */
export function ruleFor(path: string): Rule | undefined {
  return RULES.find((r) => (r.path.endsWith(".") ? path.startsWith(r.path) : path === r.path));
}
