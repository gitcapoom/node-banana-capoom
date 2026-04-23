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
});
