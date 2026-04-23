/**
 * Integration test: fal-ai/flux-general.
 *
 * Concrete bug covered: the model wraps its image-fill feature in a tiny
 * `ImageFillInput` object — `fill_image: { fill_image_url: string|array }`.
 * The previous extractor left `fill_image_url` buried inside the wrapper, so
 * users got a text URL field instead of a connectable image input pin.
 *
 * The pipeline should now:
 *   - Hoist `fill_image_url` to the top-level inputs as `fill_image.fill_image_url`
 *   - Classify it as an image input (with `isArray: true` because the anyOf
 *     accepts string-or-array)
 *   - Drop the now-empty `fill_image` parameter (wrapper had no other fields)
 *   - Classify `reference_image_url` (plain string at top level) as an image input too
 */

import { describe, it, expect } from "vitest";
import { normalizeOpenApiSchema } from "../normalize/openapi";
import { extractFromNormalized } from "../extract";

const FLUX_GENERAL_INPUT = {
  required: ["prompt"],
  properties: {
    prompt: { type: "string", description: "Text prompt" },
    fill_image: {
      anyOf: [{ $ref: "#/components/schemas/ImageFillInput" }, { type: "null" }],
      description: "Use an image input to influence the generation. Can be used to fill images in masked areas.",
    },
    reference_image_url: {
      type: "string",
      title: "Reference Image Url",
      description: "URL of Image for Reference-Only",
    },
    image_size: {
      anyOf: [
        { $ref: "#/components/schemas/ImageSize" },
        { enum: ["square_hd", "landscape_16_9"], type: "string" },
      ],
    },
    num_images: { type: "integer", minimum: 1, default: 1 },
  },
  type: "object",
};

const COMPONENTS = {
  ImageFillInput: {
    type: "object",
    properties: {
      fill_image_url: {
        default: [],
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        title: "Fill Image Url",
        description: "URLs of images to be filled for redux prompting",
      },
    },
  },
  ImageSize: {
    type: "object",
    properties: {
      width: { type: "integer", default: 512 },
      height: { type: "integer", default: 512 },
    },
  },
};

describe("fal fal-ai/flux-general — end-to-end", () => {
  const normalized = normalizeOpenApiSchema(FLUX_GENERAL_INPUT, COMPONENTS);
  const result = extractFromNormalized(normalized);

  it("hoists fill_image_url to a top-level image input pin with a dotted name", () => {
    const input = result.inputs.find((i) => i.name === "fill_image.fill_image_url");
    expect(input).toBeDefined();
    expect(input?.type).toBe("image");
  });

  it("marks the hoisted fill_image_url as isArray (anyOf accepts array)", () => {
    const input = result.inputs.find((i) => i.name === "fill_image.fill_image_url");
    expect(input?.isArray).toBe(true);
  });

  it("drops the now-empty fill_image parameter (wrapper had no other fields)", () => {
    const names = result.parameters.map((p) => p.name);
    expect(names).not.toContain("fill_image");
  });

  it("classifies reference_image_url as a top-level image input", () => {
    const input = result.inputs.find((i) => i.name === "reference_image_url");
    expect(input).toBeDefined();
    expect(input?.type).toBe("image");
  });

  it("still exposes image_size as a preset+custom union parameter", () => {
    const p = result.parameters.find((x) => x.name === "image_size");
    expect(p?.enum).toBeDefined();
    expect(p?.properties?.map((x) => x.name).sort()).toEqual(["height", "width"]);
  });
});
