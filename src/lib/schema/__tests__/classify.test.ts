import { describe, it, expect } from "vitest";
import type { NormalizedProperty } from "../types";
import { classifyInput } from "../classify";

function prop(partial: Partial<NormalizedProperty> & { name: string }): NormalizedProperty {
  return {
    type: "string",
    ...partial,
  } as NormalizedProperty;
}

describe("classifyInput", () => {
  it("treats enum string params as parameters, not image inputs", () => {
    expect(classifyInput(prop({
      name: "video_quality",
      enum: ["low", "medium", "high"],
    }))).toBeNull();
    expect(classifyInput(prop({
      name: "image_size",
      enum: ["square", "portrait"],
    }))).toBeNull();
  });

  it("excludes image_size even without enum (union preset pattern)", () => {
    // image_size is explicitly in IMAGE_PREFIX_EXCLUSIONS
    expect(classifyInput(prop({ name: "image_size" }))).toBeNull();
  });

  it("classifies image_url as image input", () => {
    const r = classifyInput(prop({ name: "image_url", format: "uri" }));
    expect(r?.kind).toBe("image");
  });

  it("classifies tail_image_url as image input", () => {
    const r = classifyInput(prop({ name: "tail_image_url", format: "uri" }));
    expect(r?.kind).toBe("image");
  });

  it("classifies end_image_url via name-pattern fallback", () => {
    const r = classifyInput(prop({ name: "end_image_url" }));
    expect(r?.kind).toBe("image");
  });

  it("classifies video_url as video input", () => {
    const r = classifyInput(prop({ name: "video_url" }));
    expect(r?.kind).toBe("video");
  });

  it("classifies audio_url as audio input", () => {
    const r = classifyInput(prop({ name: "audio_url" }));
    expect(r?.kind).toBe("audio");
  });

  it("classifies prompt and negative_prompt as text inputs", () => {
    expect(classifyInput(prop({ name: "prompt" }))?.kind).toBe("text");
    expect(classifyInput(prop({ name: "negative_prompt" }))?.kind).toBe("text");
  });

  it("excludes config-suffix names (image_count, video_format, audio_bitrate)", () => {
    expect(classifyInput(prop({ name: "image_count", type: "integer" }))).toBeNull();
    expect(classifyInput(prop({ name: "video_format" }))).toBeNull();
    expect(classifyInput(prop({ name: "audio_bitrate", type: "integer" }))).toBeNull();
  });

  it("does NOT classify boolean named 'enable_image' as image input", () => {
    expect(classifyInput(prop({ name: "enable_image", type: "boolean" }))).toBeNull();
  });

  it("classifies property with union variant of type string or array", () => {
    const unionProp: NormalizedProperty = {
      name: "image_url",
      type: "union",
      unionVariants: [{ name: "image_url", type: "string" }],
    };
    expect(classifyInput(unionProp)?.kind).toBe("image");
  });

  // ── Prefixed plural media URL lists (fal MiniMax H3 reference-to-video) ──
  //
  // These are array-of-string media lists whose names carry a prefix and a
  // PLURAL "_urls" suffix. `reference_image_urls` classified only by accident:
  // classifyImage has a `_image_` infix rule that classifyVideo/classifyAudio
  // never got. So video and audio silently fell through to the parameter panel
  // and rendered as text "+ Add" boxes instead of connectable pins.

  it("classifies reference_image_urls as an image input", () => {
    const r = classifyInput(prop({
      name: "reference_image_urls",
      type: "array",
      description: "URLs of subject/style reference images, referenced in the prompt as Image 1, Image 2, and so on. Reference images, videos, and audio clips must add up to at most 12 files.",
    }));
    expect(r?.kind).toBe("image");
  });

  it("classifies reference_video_urls as a video input", () => {
    const r = classifyInput(prop({
      name: "reference_video_urls",
      type: "array",
      description: "URLs of motion/reference video clips (2-15 seconds each, combined duration at most 15 seconds), referenced in the prompt as Video 1, Video 2, and so on. Reference images, videos, and audio clips must add up to at most 12 files.",
    }));
    expect(r?.kind).toBe("video");
  });

  it("classifies reference_audio_urls as an audio input", () => {
    const r = classifyInput(prop({
      name: "reference_audio_urls",
      type: "array",
      description: "URLs of reference audio clips (2-15 seconds each, combined duration at most 15 seconds), referenced in the prompt as Audio 1, Audio 2, and so on. Audio cannot be the only reference input; provide at least one reference image or video with it. Reference images, videos, and audio clips must add up to at most 12 files.",
    }));
    expect(r?.kind).toBe("audio");
  });

  it("keeps config fields with a media infix out of the pin list", () => {
    // The widened infix rules must not steal panel parameters. The type gate
    // (string/array only) plus CONFIG_SUFFIX_PATTERN carry most of this.
    expect(classifyInput(prop({ name: "output_video_format" }))).toBeNull();
    expect(classifyInput(prop({ name: "input_video_fps", type: "integer" }))).toBeNull();
    expect(classifyInput(prop({ name: "reference_audio_bitrate", type: "integer" }))).toBeNull();
    expect(classifyInput(prop({ name: "target_video_quality", enum: ["low", "high"] }))).toBeNull();
    expect(classifyInput(prop({ name: "num_video_frames", type: "integer" }))).toBeNull();
  });

  it("does not let one field's description steal another modality", () => {
    // Every MiniMax H3 reference field ends with the SAME sentence:
    // "Reference images, videos, and audio clips must add up to at most 12 files."
    // A description rule matching "audio clip" therefore typed the IMAGE field as
    // audio (classifyInput runs video -> audio -> image; first match wins). The
    // live /api/models response showed reference_image_urls as type=audio.
    const crossRef =
      "Reference images, videos, and audio clips must add up to at most 12 files.";
    expect(classifyInput(prop({
      name: "reference_image_urls",
      type: "array",
      description: "URLs of subject/style reference images. " + crossRef,
    }))?.kind).toBe("image");
    expect(classifyInput(prop({
      name: "reference_video_urls",
      type: "array",
      description: "URLs of motion/reference video clips. " + crossRef,
    }))?.kind).toBe("video");
    expect(classifyInput(prop({
      name: "reference_audio_urls",
      type: "array",
      description: "URLs of reference audio clips. " + crossRef,
    }))?.kind).toBe("audio");
  });

  it("does not treat an array of non-media objects as a media input", () => {
    // `loras` on the same model: array of {path, weight_name, scale}. It is a
    // real parameter and must stay in the panel.
    expect(classifyInput(prop({
      name: "loras",
      type: "array",
      description: "List of LoRA adapters to apply to the transformer.",
    }))).toBeNull();
  });

  // ── Plural media LISTS ─────────────────────────────────────────────
  //
  // Measured over the 3,336 schemas cached under .cache/schemas: 24 distinct
  // array-of-string field names were landing in `parameters` instead of `inputs`,
  // across ~136 models. The single biggest cause was not a missing pattern but
  // the `_images` counter exclusion firing on real image lists.

  function list(name: string, description?: string): NormalizedProperty {
    return prop({
      name,
      type: "array",
      items: { name: "item", type: "string" } as NormalizedProperty,
      description,
    });
  }

  it("classifies image lists whose plural name used to hit the counter exclusion", () => {
    // `name.includes("_images")` was added for num_images/max_images but fired
    // on every one of these first, before any other image signal could run.
    for (const name of [
      "reference_images",
      "input_images",
      "init_images",
      "keyframe_images",
      "clothes_images",
      "mask_images",
      "refer_images",
      "style_reference_images",
    ]) {
      expect(classifyInput(list(name)), name).toMatchObject({ kind: "image" });
    }
  });

  it("still excludes image COUNTERS, which is what the exclusion was for", () => {
    expect(classifyInput(prop({ name: "num_images", type: "integer" }))).toBeNull();
    expect(classifyInput(prop({ name: "max_images", type: "integer" }))).toBeNull();
    // A string-typed counter must stay excluded too: the gate is array-of-string,
    // not merely "is a string".
    expect(classifyInput(prop({ name: "num_images", type: "string" }))).toBeNull();
  });

  it("classifies *_list media names (muapi ships these with no description)", () => {
    expect(classifyInput(list("images_list"))?.kind).toBe("image");
    expect(classifyInput(list("videos_list"))?.kind).toBe("video");
    expect(classifyInput(list("audios_list"))?.kind).toBe("audio");
    // wavespeed
    expect(classifyInput(list("element_video_list"))?.kind).toBe("video");
  });

  it("classifies bare reference/references as image lists", () => {
    expect(classifyInput(list("reference", "Optional reference images used to guide generation."))?.kind).toBe("image");
    expect(classifyInput(list("references", "Optional reference images (PNG, JPEG, or WebP) to guide generation."))?.kind).toBe("image");
  });

  it("classifies plural video and audio lists", () => {
    expect(classifyInput(list("reference_videos", "Reference videos (up to 3, total duration max 15s)."))?.kind).toBe("video");
    expect(classifyInput(list("reference_audios", "Reference audio files (up to 3)."))?.kind).toBe("audio");
  });

  it("classifies mask URL lists as image inputs", () => {
    expect(classifyInput(list("mask_urls"))?.kind).toBe("image");
    expect(classifyInput(list("reference_mask_urls"))?.kind).toBe("image");
  });

  it("leaves non-media URL lists as parameters", () => {
    // These are real arrays of URLs, but there is no pin type for them. Any rule
    // keyed on "looks like a list of URLs" rather than on a media token would
    // wrongly capture them.
    expect(classifyInput(list("font_urls", "Optional HTTPS font URLs for RF2.5 font control. Up to 2."))).toBeNull();
    expect(classifyInput(list("lora_weights", "LoRA weights as an array of URLs. Supports .safetensors URLs."))).toBeNull();
    expect(classifyInput(list("style_codes"))).toBeNull();
    expect(classifyInput(list("character_ids"))).toBeNull();
    expect(classifyInput(list("voice_ids"))).toBeNull();
    expect(classifyInput(list("keyframe_positions"))).toBeNull();
    expect(classifyInput(list("prompts"))).toBeNull();
  });

  it("leaves genuinely mixed-modality lists as parameters", () => {
    // One pin has one type. Guessing image-or-video here would silently pick
    // wrong for half the models, so these stay in the panel by design.
    expect(classifyInput(list("reference_files", "Array of URLs to reference images or videos. Images: 0-5, Videos: 0-3."))).toBeNull();
    expect(classifyInput(list("file_urls", "URLs of files to include as assets in the video (images, videos, audio, PDFs)."))).toBeNull();
  });
});
