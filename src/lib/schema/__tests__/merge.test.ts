import { describe, it, expect } from "vitest";
import { mergePlaygroundFields } from "../merge";
import type { ExtractedResult } from "../types";

function emptyExtracted(): ExtractedResult {
  return {
    parameters: [
      { name: "seed", type: "integer" },
    ],
    inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    health: {
      status: "clean",
      warnings: [],
      extractedAt: 1000,
    },
  };
}

describe("mergePlaygroundFields", () => {
  it("adds playground-only fields as string parameters and flips health to playground-augmented", () => {
    const merged = mergePlaygroundFields(emptyExtracted(), {
      fields: ["seed", "image_size", "new_param"],
      url: "https://fal.ai/models/x/api",
      scrapedAt: 2000,
      status: "ok",
    });

    const names = merged.parameters.map((p) => p.name);
    expect(names).toContain("seed"); // preserved
    expect(names).toContain("image_size");
    expect(names).toContain("new_param");
    expect(merged.health.status).toBe("playground-augmented");
    expect(merged.health.warnings.some((w) => w.includes("image_size"))).toBe(true);
  });

  it("does not duplicate fields that are already present under a different case", () => {
    const ext = emptyExtracted();
    ext.parameters.push({ name: "image_size", type: "string" });
    const merged = mergePlaygroundFields(ext, {
      fields: ["imageSize", "image_size"],
      url: "",
      scrapedAt: 0,
      status: "ok",
    });
    const occurrences = merged.parameters.filter((p) => p.name === "image_size").length;
    expect(occurrences).toBe(1);
  });

  it("leaves extracted untouched on empty scrape", () => {
    const merged = mergePlaygroundFields(emptyExtracted(), {
      fields: [],
      url: "",
      scrapedAt: 0,
      status: "empty",
    });
    expect(merged.parameters).toEqual(emptyExtracted().parameters);
    expect(merged.health.status).toBe("clean");
  });

  it("appends an error warning on scrape failure without adding fields", () => {
    const merged = mergePlaygroundFields(emptyExtracted(), {
      fields: [],
      url: "",
      scrapedAt: 0,
      status: "error",
      error: "ETIMEDOUT",
    });
    expect(merged.parameters).toEqual(emptyExtracted().parameters);
    expect(merged.health.warnings.some((w) => w.includes("ETIMEDOUT"))).toBe(true);
  });
});
