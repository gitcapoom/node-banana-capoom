/**
 * Which raw OpenAPI properties hold a LIST.
 *
 * A generation against fal-ai/kling-video/o3/4k/video-to-video/edit failed with
 *   422 {"type":"list_type","loc":["body","image_urls"],
 *        "msg":"Input should be a valid list","input":"https://v3b.fal.media/..."}
 * because the server tested `property.type === "array"`, and fal writes an
 * OPTIONAL array as a nullable union with no top-level `type`. The field was
 * therefore judged scalar and the array the canvas built was unwrapped to its
 * first element on the way out.
 *
 * Every shape below is copied from a live fal schema, not invented — including
 * the near-miss (`anyOf:[string,null]`) that must NOT be read as a list, since
 * wrapping it produces the mirror failure "Input should be a valid string".
 */

import { describe, it, expect } from "vitest";
import { isArraySchemaProperty, getInputMappingFromSchema } from "../schemaUtils";

// fal-ai/kling-video/o3/4k/video-to-video/edit — the field that 422'd.
const NULLABLE_ARRAY = {
  anyOf: [{ items: { type: "string" }, type: "array" }, { type: "null" }],
  title: "Image Urls",
};

// Same model, `elements`: a nullable array whose items are a $ref.
const NULLABLE_ARRAY_OF_REF = {
  anyOf: [
    { items: { $ref: "#/components/schemas/KlingV3ImageElementInput" }, type: "array" },
    { type: "null" },
  ],
  title: "Elements",
};

// fal-ai/kling-video/v2.5-turbo/pro/image-to-video — a nullable SCALAR image
// pin. Shares the union shape but is emphatically not a list.
const NULLABLE_STRING = {
  anyOf: [{ type: "string" }, { type: "null" }],
  title: "Tail Image Url",
};

const COMPONENTS = {
  KlingV3ImageElementInput: {
    type: "object",
    properties: { frontal_image_url: { type: "string" } },
  },
  RefToArray: { type: "array", items: { type: "string" } },
};

describe("isArraySchemaProperty", () => {
  it("reads a plainly-typed array as a list", () => {
    expect(isArraySchemaProperty("image_urls", { type: "array", items: { type: "string" } })).toBe(true);
  });

  it("reads fal's nullable array as a list — the shape that caused the 422", () => {
    expect(isArraySchemaProperty("image_urls", NULLABLE_ARRAY)).toBe(true);
  });

  it("reads a nullable array of $ref items as a list", () => {
    expect(isArraySchemaProperty("elements", NULLABLE_ARRAY_OF_REF, COMPONENTS)).toBe(true);
  });

  it("does NOT read a nullable string as a list", () => {
    // The mirror failure. `tail_image_url` is an image input wearing the same
    // union shape; wrapping it would send ["url"] where fal wants "url".
    expect(isArraySchemaProperty("tail_image_url", NULLABLE_STRING)).toBe(false);
  });

  it("does NOT read a plain scalar as a list", () => {
    expect(isArraySchemaProperty("prompt", { type: "string" })).toBe(false);
    expect(isArraySchemaProperty("seed", { type: "integer" })).toBe(false);
  });

  it("follows a $ref to an array", () => {
    expect(isArraySchemaProperty("x", { $ref: "#/components/schemas/RefToArray" }, COMPONENTS)).toBe(true);
  });

  it("follows allOf to an array", () => {
    expect(
      isArraySchemaProperty("x", { allOf: [{ $ref: "#/components/schemas/RefToArray" }] }, COMPONENTS)
    ).toBe(true);
  });

  it("treats a true union containing an array as a list, exactly as the client does", () => {
    // src/lib/schema/extract.ts applies this same rule to decide isArray, which
    // is what shapes the value the canvas sends. Server and client must agree:
    // if they disagree the payload is reshaped in flight, which is this bug.
    expect(isArraySchemaProperty("x", { anyOf: [{ type: "string" }, { type: "array" }] })).toBe(true);
  });

  it("survives junk without throwing", () => {
    expect(isArraySchemaProperty("x", undefined)).toBe(false);
    expect(isArraySchemaProperty("x", null)).toBe(false);
    expect(isArraySchemaProperty("x", "nonsense")).toBe(false);
  });
});

describe("getInputMappingFromSchema — nullable arrays", () => {
  const schema = {
    components: {
      schemas: {
        Input: {
          properties: {
            prompt: { type: "string" },
            image_urls: NULLABLE_ARRAY,
            tail_image_url: NULLABLE_STRING,
          },
        },
      },
    },
  };

  it("puts a nullable array in schemaArrayParams", () => {
    const r = getInputMappingFromSchema(schema);
    expect(r.schemaArrayParams.has("image_urls")).toBe(true);
  });

  it("keeps a nullable scalar out of schemaArrayParams", () => {
    const r = getInputMappingFromSchema(schema);
    expect(r.schemaArrayParams.has("tail_image_url")).toBe(false);
  });
});
