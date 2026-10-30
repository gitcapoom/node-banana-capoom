import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseModels, listModelsFromSpec } from "../muapiModelFetcher";

/**
 * A fragment cut from the real muapi.ai/playground page on 2026-08-21.
 *
 * Real, not invented: the whole bug was that the page's shape did not match
 * what the parser assumed, and a hand-written fixture would only have encoded
 * the same wrong assumption.
 */
const fixture = readFileSync(join(__dirname, "muapi.fixture.html"), "utf8");

describe("muapi model parsing", () => {
  it("finds a model that exists ONLY in the JSON payload", () => {
    // This model has ZERO href occurrences on the page, so the anchor scrape
    // could never see it — and every recent seedance-2.5 variant was in the
    // same position. 502 of 616 models were invisible for this reason.
    const hit = parseModels(fixture).find(
      (m) => m.id === "seedance-2.5-intl-first-last-frame-1080p",
    );
    expect(hit).toBeDefined();
  });

  it("takes the category from the record, not from a sibling element", () => {
    const hit = parseModels(fixture).find(
      (m) => m.id === "seedance-2.5-intl-first-last-frame-1080p",
    );
    expect(hit?.capabilities).toEqual(["image-to-video"]);
  });

  it("attributes them to muapi", () => {
    const models = parseModels(fixture);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "muapi")).toBe(true);
  });

  it("emits no duplicates", () => {
    const ids = parseModels(fixture).map((m) => m.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("returns an empty list rather than throwing on junk", () => {
    expect(() => parseModels("<html>nothing here</html>")).not.toThrow();
    expect(parseModels("<html>nothing here</html>")).toEqual([]);
  });

  it("never emits an unmapped capability", () => {
    // "Text to Text", "Training", "Lora Support" and "other" all appear in the
    // real payload and must not become generation nodes.
    const allowed = new Set([
      "text-to-image", "image-to-image", "text-to-video", "image-to-video",
      "video-to-video", "text-to-audio", "image-to-3d", "text-to-3d",
    ]);
    for (const m of parseModels(fixture)) {
      for (const c of m.capabilities) expect(allowed.has(c)).toBe(true);
    }
  });
});

/**
 * Paths cut from the real https://api.muapi.ai/openapi.json (2026-10-30), with
 * descriptions and responses trimmed. The playground scrape had dropped to 21
 * models, so the app served a March list whose Seedance ids muapi had renamed.
 */
const spec = JSON.parse(readFileSync(join(__dirname, "muapi.spec.fixture.json"), "utf8"));

describe("muapi catalogue from the OpenAPI spec", () => {
  const models = listModelsFromSpec(spec);
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));

  it("lists generation endpoints under their real ids, typed by tag", () => {
    expect(byId["seedance-2.0-omni-reference"].capabilities).toEqual(["image-to-video"]);
    expect(byId["seedance-2.5-text-to-video-4k"].capabilities).toEqual(["text-to-video"]);
    expect(byId["flux-dev-image"].capabilities).toEqual(["text-to-image"]);
    expect(byId["tripo3d-p1-text-to-3d"].capabilities).toEqual(["text-to-3d"]);
  });

  it("skips non-generation endpoints", () => {
    // An LLM call, a GET with a path parameter, and an auth route.
    expect(Object.keys(byId).sort()).toEqual([
      "flux-dev-image",
      "seedance-2.0-omni-reference",
      "seedance-2.5-text-to-video-4k",
      "tripo3d-p1-text-to-3d",
    ]);
  });
});
