/**
 * Integration test: real fal.ai OpenAPI for `openai/gpt-image-2/edit`.
 *
 * The concrete bug this covers: fal's Input schema has `image_size` as an
 * `anyOf` union of {$ref: ImageSize} + {enum: string}. The pipeline must
 * expose that as a parameter with BOTH `enum` and `properties`.
 */

import { describe, it, expect } from "vitest";
import { normalizeOpenApiSchema } from "../normalize/openapi";
import { extractFromNormalized } from "../extract";

// Real components.schemas slice from `api.fal.ai/v1/models?endpoint_id=openai/gpt-image-2/edit&expand=openapi-3.0`
const FAL_GPT_IMAGE_2_EDIT_INPUT = {
  required: ["prompt", "image_urls"],
  properties: {
    prompt: { type: "string", description: "The prompt for image generation", minLength: 2, maxLength: 32000 },
    sync_mode: { type: "boolean", default: false, description: "Sync mode toggle" },
    image_size: {
      anyOf: [
        { $ref: "#/components/schemas/ImageSize" },
        {
          enum: ["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9", "auto"],
          type: "string",
        },
      ],
      default: "auto",
      description: "The size of the generated image. Use 'auto' to infer from input images.",
    },
    quality: {
      type: "string",
      enum: ["low", "medium", "high"],
      default: "high",
      description: "Quality for the generated image",
    },
    num_images: { type: "integer", minimum: 1, maximum: 4, default: 1, description: "Number of images" },
    mask_url: { anyOf: [{ type: "string" }, { type: "null" }], description: "Mask image URL" },
    image_urls: { type: "array", items: { type: "string" }, description: "Source image URLs" },
    output_format: { type: "string", enum: ["jpeg", "png", "webp"], default: "png" },
  },
  type: "object",
};

const COMPONENTS = {
  ImageSize: {
    type: "object",
    properties: {
      height: { type: "integer", exclusiveMinimum: 0, maximum: 14142, default: 512 },
      width: { type: "integer", exclusiveMinimum: 0, maximum: 14142, default: 512 },
    },
  },
};

describe("fal openai/gpt-image-2/edit — end-to-end", () => {
  const normalized = normalizeOpenApiSchema(FAL_GPT_IMAGE_2_EDIT_INPUT, COMPONENTS);
  const result = extractFromNormalized(normalized);

  it("surfaces image_size as a parameter (not an input pin)", () => {
    const names = result.parameters.map((p) => p.name);
    expect(names).toContain("image_size");
    const inputNames = result.inputs.map((i) => i.name);
    expect(inputNames).not.toContain("image_size");
  });

  it("image_size parameter has BOTH enum (presets) AND properties (custom width/height)", () => {
    const p = result.parameters.find((x) => x.name === "image_size");
    expect(p).toBeDefined();
    expect(p?.enum).toEqual(
      expect.arrayContaining(["square_hd", "auto", "landscape_16_9"])
    );
    expect(p?.properties?.map((x) => x.name).sort()).toEqual(["height", "width"]);
  });

  it("image_urls surfaces as an image input with isArray=true", () => {
    const i = result.inputs.find((x) => x.name === "image_urls");
    expect(i).toBeDefined();
    expect(i?.type).toBe("image");
    expect(i?.isArray).toBe(true);
    expect(i?.required).toBe(true);
  });

  it("mask_url (nullable anyOf) classifies as an image input", () => {
    const i = result.inputs.find((x) => x.name === "mask_url");
    expect(i).toBeDefined();
    expect(i?.type).toBe("image");
    expect(i?.required).toBe(false);
  });

  it("quality enum and num_images bounds are preserved", () => {
    const q = result.parameters.find((p) => p.name === "quality");
    expect(q?.enum).toEqual(["low", "medium", "high"]);
    const n = result.parameters.find((p) => p.name === "num_images");
    expect(n?.minimum).toBe(1);
    expect(n?.maximum).toBe(4);
  });

  it("pipeline reports clean health (no missing fields, no noise from warnings)", () => {
    expect(result.health.status).toBe("clean");
    expect(result.health.warnings).toEqual([]);
  });
});
