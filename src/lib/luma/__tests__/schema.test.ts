/**
 * The per-(model, type) schema that draws a Luma node's pins and settings.
 *
 * Luma shares one request envelope across six generation types, so most of the
 * work is deciding what NOT to offer. Each case below pins a constraint Luma
 * states in prose; offering the field anyway produces a 422 or a setting that
 * silently does nothing.
 *
 * The fixture is trimmed from the real API-reference page.
 */

import { describe, it, expect } from "vitest";
import { buildLumaSchema } from "../schema";
import { fieldAppliesToType, ruleFor } from "../typeScope";

const DOC = `### Body Parameters

- \`prompt: string\`

  Text prompt

- \`aspect_ratio: optional "16:9" or "1:1"\`

  Output aspect ratio.

- \`image_ref: optional array of ImageRef\`

  Reference images for style/content guidance.

- \`layering: optional object { resolution }\`

  Layer-extraction options for type=layering (model uni-1).

  - \`resolution: optional "1k" or "2k"\`

    Output resolution for every extracted layer.

- \`output_format: optional "png" or "jpeg"\`

  Output image format

- \`source: optional ImageRef\`

  Media reference for guided generation.

- \`style: optional "auto" or "manga"\`

  Style preset

- \`web_search: optional boolean\`

  Enable web search grounding.

- \`video: optional VideoOptions\`

  Ray 3.2 video request options.

  - \`duration: optional "5s" or "10s"\`

    Video duration

  - \`loop: optional boolean\`

    Generate a seamlessly looping video.

  - \`resolution: optional "720p" or "1080p"\`

    Output resolution.

  - \`start_frame: optional ImageRef\`

    Anchor frame.

  - \`source_position: optional SourcePosition\`

    Normalized source rectangle for video_reframe.

    - \`x_norm: number\`

      Left edge.

  - \`edit: optional VideoEditOptions\`

    Ray 3.2 video-to-video edit controls.

    - \`strength: optional "flex_1" or "adhere_1"\`

      How much an edit preserves the source.

### Returns
`;

const pins = (id: string) => buildLumaSchema(DOC, id)!.inputs.map((i) => i.name);
const params = (id: string) => buildLumaSchema(DOC, id)!.parameters.map((p) => p.name);

describe("buildLumaSchema — pins", () => {
  it("gives a plain image node a prompt and reference images", () => {
    expect(pins("uni-1/image")).toEqual(["prompt", "image_ref"]);
  });

  it("does NOT give type=image a source pin", () => {
    // "source: Must be `null` or omitted for `type: \"image\"`". Wiring one
    // produces a 422, so the pin must not exist.
    expect(pins("uni-1/image")).not.toContain("source");
  });

  it("gives image_edit a source pin", () => {
    expect(pins("uni-1/image_edit")).toContain("source");
  });

  it("types the source as VIDEO for video edits and reframes", () => {
    // Same field name, different medium: here `source` carries the clip being
    // changed, so the pin must accept a video edge, not an image one.
    const edit = buildLumaSchema(DOC, "ray-3.2/video_edit")!;
    expect(edit.inputs.find((i) => i.name === "source")!.type).toBe("video");
    const reframe = buildLumaSchema(DOC, "ray-3.2/video_reframe")!;
    expect(reframe.inputs.find((i) => i.name === "source")!.type).toBe("video");
  });

  it("marks image_ref as an array so the pin can take several", () => {
    const s = buildLumaSchema(DOC, "uni-1/image")!;
    expect(s.inputs.find((i) => i.name === "image_ref")!.isArray).toBe(true);
  });

  it("offers anchor frames on create, not on reframe", () => {
    expect(pins("ray-3.2/video")).toContain("video.start_frame");
    expect(pins("ray-3.2/video_reframe")).not.toContain("video.start_frame");
  });
});

describe("buildLumaSchema — settings", () => {
  it("keeps the video options object off image nodes", () => {
    // The generic classifier would read the bare name "video" as a video INPUT
    // pin; it is the options object. Neither should appear on an image node.
    expect(params("uni-1/image").filter((p) => p.startsWith("video."))).toEqual([]);
    expect(pins("uni-1/image").filter((p) => p.startsWith("video."))).toEqual([]);
  });

  it("keeps layering options off everything but layering", () => {
    expect(params("uni-1/layering")).toContain("layering.resolution");
    expect(params("uni-1/image")).not.toContain("layering.resolution");
  });

  it("hides image-only settings from video types", () => {
    expect(params("ray-3.2/video")).not.toContain("style");
    expect(params("ray-3.2/video")).not.toContain("output_format");
    expect(params("ray-3.2/video")).not.toContain("web_search");
  });

  it("hides aspect_ratio where it is ignored, keeps it where it is required", () => {
    // Edits take their dimensions from the source; reframe exists to change them.
    expect(params("uni-1/image_edit")).not.toContain("aspect_ratio");
    expect(params("ray-3.2/video_edit")).not.toContain("aspect_ratio");
    expect(params("ray-3.2/video_reframe")).toContain("aspect_ratio");
    expect(params("uni-1/image")).toContain("aspect_ratio");
  });

  it("offers video.edit controls only on video_edit", () => {
    expect(params("ray-3.2/video_edit")).toContain("video.edit.strength");
    expect(params("ray-3.2/video")).not.toContain("video.edit.strength");
    expect(params("ray-3.2/video_reframe")).not.toContain("video.edit.strength");
  });

  it("offers loop only when creating a video", () => {
    expect(params("ray-3.2/video")).toContain("video.loop");
    expect(params("ray-3.2/video_reframe")).not.toContain("video.loop");
  });

  it("offers source_position only on reframe", () => {
    expect(params("ray-3.2/video_reframe")).toContain("video.source_position.x_norm");
    expect(params("ray-3.2/video")).not.toContain("video.source_position.x_norm");
  });

  it("carries enum members through for the UI to offer", () => {
    const ar = buildLumaSchema(DOC, "uni-1/image")!.parameters.find((p) => p.name === "aspect_ratio");
    expect(ar!.enum).toEqual(["16:9", "1:1"]);
  });

  it("does not offer model or type as settings", () => {
    // They are the address, already fixed by the selected model id.
    expect(params("uni-1/image")).not.toContain("model");
    expect(params("uni-1/image")).not.toContain("type");
  });

  it("tells the user what a layering prompt is for", () => {
    const s = buildLumaSchema(DOC, "uni-1/layering")!;
    expect(s.health.warnings.join(" ")).toMatch(/500 characters/);
  });

  it("returns null rather than an empty schema when the docs are unavailable", () => {
    expect(buildLumaSchema(null, "uni-1/image")).toBeNull();
    expect(buildLumaSchema("unparseable", "uni-1/image")).toBeNull();
  });
});

describe("fieldAppliesToType", () => {
  it("defaults an unknown field to visible", () => {
    // A field Luma adds that no rule mentions should surface rather than be
    // silently dropped — the same principle as an unknown model being offered.
    expect(fieldAppliesToType("some_new_field", "image")).toBe(true);
  });

  it("carries the documentation sentence behind each rule", () => {
    expect(ruleFor("source")!.because).toMatch(/omitted for/);
    expect(ruleFor("video.edit.strength")!.because).toMatch(/video_edit/);
  });
});
