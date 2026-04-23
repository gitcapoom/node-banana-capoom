import { describe, it, expect } from "vitest";
import { extractFromNormalized } from "../extract";
import { normalizeOpenApiSchema } from "../normalize/openapi";

describe("extractFromNormalized", () => {
  it("exposes image_size union as a parameter with BOTH enum + properties", () => {
    const normalized = normalizeOpenApiSchema({
      properties: {
        image_size: {
          anyOf: [
            { type: "string", enum: ["square", "portrait_hd"] },
            {
              type: "object",
              properties: {
                width: { type: "integer", minimum: 512, maximum: 2048 },
                height: { type: "integer", minimum: 512, maximum: 2048 },
              },
            },
          ],
          description: "Preset or custom {width,height}",
        },
        prompt: { type: "string" },
      },
      required: ["prompt"],
    });

    const result = extractFromNormalized(normalized);
    const param = result.parameters.find((p) => p.name === "image_size");
    expect(param).toBeDefined();
    expect(param?.enum).toEqual(["square", "portrait_hd"]);
    expect(param?.type).toBe("object");
    expect(param?.properties?.length).toBe(2);
    expect(param?.properties?.map((p) => p.name).sort()).toEqual(["height", "width"]);
  });

  it("detects end_image_url as an image input in a Kling-style schema", () => {
    const normalized = normalizeOpenApiSchema({
      properties: {
        prompt: { type: "string" },
        image_url: {
          anyOf: [{ type: "string", format: "uri" }, { type: "null" }],
        },
        end_image_url: {
          anyOf: [{ type: "string", format: "uri" }, { type: "null" }],
          description: "Tail / end image for transition",
        },
      },
      required: ["prompt", "image_url"],
    });

    const result = extractFromNormalized(normalized);
    const inputNames = result.inputs.map((i) => i.name);
    expect(inputNames).toContain("image_url");
    expect(inputNames).toContain("end_image_url");
    expect(inputNames).toContain("prompt");

    const endImage = result.inputs.find((i) => i.name === "end_image_url");
    expect(endImage?.type).toBe("image");
    expect(endImage?.required).toBe(false);
  });

  it("sorts required inputs first and image-type before text", () => {
    const normalized = normalizeOpenApiSchema({
      properties: {
        prompt: { type: "string" },
        image_url: { type: "string", format: "uri" },
      },
      required: ["prompt", "image_url"],
    });
    const result = extractFromNormalized(normalized);
    expect(result.inputs.map((i) => i.name)).toEqual(["image_url", "prompt"]);
  });

  it("places priority parameters (aspect_ratio, seed) before alphabetical ones", () => {
    const normalized = normalizeOpenApiSchema({
      properties: {
        zebra_option: { type: "string" },
        aspect_ratio: { type: "string", enum: ["1:1"] },
        apple_setting: { type: "string" },
        seed: { type: "integer" },
      },
    });
    const result = extractFromNormalized(normalized);
    const names = result.parameters.map((p) => p.name);
    // Priority (aspect_ratio, seed) come first alphabetically between themselves,
    // then non-priority alphabetically.
    expect(names.slice(0, 2)).toEqual(["aspect_ratio", "seed"]);
    expect(names.slice(2)).toEqual(["apple_setting", "zebra_option"]);
  });

  it("reports 'no-inputs' health when no connectable inputs were found", () => {
    const normalized = normalizeOpenApiSchema({
      properties: {
        seed: { type: "integer" },
      },
    });
    const result = extractFromNormalized(normalized);
    expect(result.health.status).toBe("no-inputs");
  });
});
