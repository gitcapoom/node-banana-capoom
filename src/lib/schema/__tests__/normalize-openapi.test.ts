import { describe, it, expect } from "vitest";
import { normalizeOpenApiSchema, normalizeProperty } from "../normalize/openapi";

describe("normalizeOpenApiSchema", () => {
  it("handles a plain properties bag", () => {
    const out = normalizeOpenApiSchema({
      properties: {
        prompt: { type: "string", description: "The prompt" },
        seed: { type: "integer", minimum: 0 },
      },
      required: ["prompt"],
    });
    expect(out.properties.prompt.type).toBe("string");
    expect(out.properties.prompt.required).toBe(true);
    expect(out.properties.seed.type).toBe("integer");
    expect(out.properties.seed.minimum).toBe(0);
    expect(out.properties.seed.required).toBeUndefined();
  });

  it("flattens nullable anyOf [T, null] into a single T with nullable=true", () => {
    const prop = normalizeProperty("end_image_url", {
      anyOf: [{ type: "string", format: "uri" }, { type: "null" }],
      description: "Optional tail image",
    });
    expect(prop.type).toBe("string");
    expect(prop.nullable).toBe(true);
    expect(prop.description).toBe("Optional tail image");
  });

  it("preserves true unions (enum string OR object) in unionVariants", () => {
    const prop = normalizeProperty("image_size", {
      anyOf: [
        { type: "string", enum: ["square", "portrait"] },
        {
          type: "object",
          properties: {
            width: { type: "integer" },
            height: { type: "integer" },
          },
        },
      ],
    });
    expect(prop.type).toBe("union");
    expect(prop.unionVariants?.length).toBe(2);
    const enumVariant = prop.unionVariants?.find((v) => Array.isArray(v.enum));
    const objectVariant = prop.unionVariants?.find((v) => v.type === "object");
    expect(enumVariant?.enum).toEqual(["square", "portrait"]);
    expect(objectVariant?.properties).toBeDefined();
    expect(objectVariant?.properties?.width.type).toBe("integer");
  });

  it("merges allOf members without discarding enum/default", () => {
    const prop = normalizeProperty("quality", {
      allOf: [
        { type: "string", enum: ["low", "medium", "high"] },
        { default: "medium", description: "Output quality" },
      ],
    });
    expect(prop.type).toBe("string");
    expect(prop.enum).toEqual(["low", "medium", "high"]);
    expect(prop.default).toBe("medium");
    expect(prop.description).toBe("Output quality");
  });

  it("resolves $ref against provided components", () => {
    const components = {
      ImageUrl: { type: "string", format: "uri", description: "URL of an image" },
    };
    const prop = normalizeProperty(
      "image",
      { $ref: "#/components/schemas/ImageUrl" },
      components
    );
    expect(prop.type).toBe("string");
    expect(prop.format).toBe("uri");
    expect(prop.description).toBe("URL of an image");
  });

  it("converts pydantic ge/le into minimum/maximum", () => {
    const prop = normalizeProperty("guidance", { type: "number", ge: 0, le: 20 });
    expect(prop.minimum).toBe(0);
    expect(prop.maximum).toBe(20);
  });

  it("converts exclusiveMinimum/Maximum (OpenAPI 3.1) to inclusive bounds", () => {
    const prop = normalizeProperty("steps", {
      type: "integer",
      exclusiveMinimum: 0,
      exclusiveMaximum: 100,
    });
    expect(prop.minimum).toBe(1);
    expect(prop.maximum).toBe(99);
  });

  it("recurses into array items and object properties", () => {
    const schema = normalizeOpenApiSchema({
      properties: {
        images: {
          type: "array",
          items: { type: "string", format: "uri" },
        },
        config: {
          type: "object",
          properties: {
            aspect: { type: "string", enum: ["1:1", "16:9"] },
          },
        },
      },
      required: ["images"],
    });
    expect(schema.properties.images.type).toBe("array");
    expect(schema.properties.images.items?.type).toBe("string");
    expect(schema.properties.config.type).toBe("object");
    expect(schema.properties.config.properties?.aspect.enum).toEqual(["1:1", "16:9"]);
  });
});
