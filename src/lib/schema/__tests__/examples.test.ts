/**
 * Schema `examples` must survive extraction.
 *
 * fal declares `prompt_expansion_mode` with examples fast/balanced/quality and
 * `ui: { field: "presets" }`, but NO enum. The normalizer read only `enum`, so
 * the parameter arrived as a bare string and the panel rendered a free-text box
 * — a preset field with nothing to pick from.
 *
 * `examples` is deliberately not folded into `enum`: an enum is a closed set the
 * UI may enforce, examples are suggestions and other values stay legal.
 */

import { describe, it, expect } from "vitest";
import { normalizeOpenApiSchema } from "../normalize/openapi";

function extractProp(raw: Record<string, unknown>) {
  const schema = { type: "object", properties: { field: raw } };
  const normalized = normalizeOpenApiSchema(schema as never, undefined);
  return normalized.properties.field;
}

describe("normalizeOpenApiSchema — examples", () => {
  it("keeps string examples when there is no enum", () => {
    const p = extractProp({
      title: "Prompt Expansion Mode",
      anyOf: [{ type: "string" }, { type: "null" }],
      default: "balanced",
      examples: ["fast", "balanced", "quality"],
      ui: { field: "presets", important: true },
    });
    expect(p.examples).toEqual(["fast", "balanced", "quality"]);
    expect(p.enum).toBeUndefined();
  });

  it("does not turn examples into an enum", () => {
    // An enum is closed and the UI may restrict to it; examples are hints.
    // Conflating them would silently forbid a legal value.
    const p = extractProp({ type: "string", examples: ["fast", "quality"] });
    expect(p.enum).toBeUndefined();
  });

  it("drops non-scalar examples", () => {
    // camera_trajectory ships a whole sample array as its example; offering
    // that in a picker renders "[object Object]".
    const p = extractProp({
      type: "array",
      examples: [[{ time: 0, azimuth: 0 }]],
    });
    expect(p.examples).toBeUndefined();
  });

  it("keeps only the scalars from a mixed examples list", () => {
    const p = extractProp({ type: "string", examples: ["fast", { a: 1 }, "quality"] });
    expect(p.examples).toEqual(["fast", "quality"]);
  });

  it("leaves a property without examples untouched", () => {
    const p = extractProp({ type: "string", description: "plain" });
    expect(p.examples).toBeUndefined();
  });

  it("keeps an enum alongside examples, with the enum still present", () => {
    // Both may appear. The UI treats enum as authoritative and renders a closed
    // select; examples only matter when there is no enum.
    const p = extractProp({
      type: "string",
      enum: ["480P", "768P"],
      examples: ["768P"],
    });
    expect(p.enum).toEqual(["480P", "768P"]);
    expect(p.examples).toEqual(["768P"]);
  });
});
