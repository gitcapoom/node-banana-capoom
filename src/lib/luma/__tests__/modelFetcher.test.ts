/**
 * Building the Luma catalogue from Luma's docs.
 *
 * The fixtures are the real shapes. Two of them encode problems found in the
 * live pages rather than imagined ones:
 *
 *  - the models guide's table does NOT mention layering at all, so a catalogue
 *    built from it alone silently loses a whole generation type;
 *  - layering is uni-1 only, and that constraint exists only as prose on the
 *    `layering` options field ("(model uni-1)"). A "layering belongs to image
 *    models" shortcut produces uni-1-max/layering, which the API rejects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildLumaModels, parseModelTypeMatrix, getLumaModels, clearLumaModelCache } from "../modelFetcher";

const API_REF = `## Create a generation

### Body Parameters

- \`prompt: string\`

  Text prompt

- \`layering: optional object { resolution }\`

  Layer-extraction options for type=layering (model uni-1). The image to decompose rides body.source.

  - \`resolution: optional "1k" or "2k"\`

    Output resolution.

- \`model: optional Model\`

  Model identifier.

  - \`"uni-1"\`

  - \`"uni-1-max"\`

  - \`"ray-3.2"\`

- \`type: optional "image" or 5 more\`

  The kind of generation to perform

  - \`"image"\`

  - \`"image_edit"\`

  - \`"video"\`

  - \`"video_edit"\`

  - \`"video_reframe"\`

  - \`"layering"\`

- \`video: optional VideoOptions\`

  Ray 3.2 video request options.

### Returns
`;

const MODEL_GUIDE = `## At a glance

| Model       | Supports                               | Use for            |
| ----------- | -------------------------------------- | ------------------ |
| \`uni-1\`     | \`image\`, \`image_edit\`                  | Default generation |
| \`uni-1-max\` | \`image\`, \`image_edit\`                  | Higher quality     |
| \`ray-3.2\`   | \`video\`, \`video_edit\`, \`video_reframe\` | Video              |
`;

describe("parseModelTypeMatrix", () => {
  it("reads the table", () => {
    expect(parseModelTypeMatrix(MODEL_GUIDE)).toEqual({
      "uni-1": ["image", "image_edit"],
      "uni-1-max": ["image", "image_edit"],
      "ray-3.2": ["video", "video_edit", "video_reframe"],
    });
  });

  it("survives the columns being reordered", () => {
    // Column indexes come from the header row, not from a fixed position, so
    // Luma can add or move a column without this going quietly wrong.
    const reordered = `| Use for | Supports | Model |
| --- | --- | --- |
| Default | \`image\`, \`layering\` | \`uni-1\` |
`;
    expect(parseModelTypeMatrix(reordered)).toEqual({ "uni-1": ["image", "layering"] });
  });

  it("returns null when there is no such table", () => {
    expect(parseModelTypeMatrix("# No table here")).toBeNull();
  });
});

describe("buildLumaModels", () => {
  it("crosses models with the types each supports", () => {
    const ids = buildLumaModels(API_REF, MODEL_GUIDE)!.map((m) => m.id);
    expect(ids).toEqual([
      "uni-1/image",
      "uni-1/image_edit",
      "uni-1/layering",
      "uni-1-max/image",
      "uni-1-max/image_edit",
      "ray-3.2/video",
      "ray-3.2/video_edit",
      "ray-3.2/video_reframe",
    ]);
  });

  it("recovers layering, which the guide's table omits entirely", () => {
    const ids = buildLumaModels(API_REF, MODEL_GUIDE)!.map((m) => m.id);
    expect(ids).toContain("uni-1/layering");
  });

  it("gives layering ONLY to the model the docs name for it", () => {
    // The constraint lives in prose on the layering field. Without reading it,
    // uni-1-max and ray-3.2 acquire a type the API refuses.
    const ids = buildLumaModels(API_REF, MODEL_GUIDE)!.map((m) => m.id);
    expect(ids).not.toContain("uni-1-max/layering");
    expect(ids).not.toContain("ray-3.2/layering");
  });

  it("offers every type for a model the table does not mention", () => {
    // A brand-new Luma model must be reachable. Hiding it behind a stale table
    // is the failure this whole module exists to avoid — better to offer a
    // combination the API may refuse than to pretend the model is not there.
    const withNewModel = API_REF.replace('- `"ray-3.2"`', '- `"ray-3.2"`\n\n  - `"uni-2"`');
    const ids = buildLumaModels(withNewModel, MODEL_GUIDE)!.map((m) => m.id);
    expect(ids).toContain("uni-2/image");
    expect(ids).toContain("uni-2/video");
    expect(ids).toContain("uni-2/video_reframe");
  });

  it("maps each type to a capability", () => {
    const models = buildLumaModels(API_REF, MODEL_GUIDE)!;
    expect(models.find((m) => m.id === "uni-1/image")!.capabilities).toEqual(["text-to-image"]);
    expect(models.find((m) => m.id === "ray-3.2/video")!.capabilities).toEqual(["text-to-video"]);
    expect(models.find((m) => m.id === "ray-3.2/video_edit")!.capabilities).toEqual(["video-to-video"]);
  });

  it("returns null when the API reference cannot be parsed", () => {
    expect(buildLumaModels("not the right page", MODEL_GUIDE)).toBeNull();
    expect(buildLumaModels(null, MODEL_GUIDE)).toBeNull();
  });

  it("still works with no models guide at all", () => {
    const ids = buildLumaModels(API_REF, null)!.map((m) => m.id);
    expect(ids).toContain("uni-1/image");
    expect(ids.length).toBeGreaterThan(0);
  });
});

describe("getLumaModels", () => {
  beforeEach(() => clearLumaModelCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    clearLumaModelCache();
  });

  it("builds from the fetched docs", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      new Response(String(url).includes("guides/model") ? MODEL_GUIDE : API_REF, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    ));
    const models = await getLumaModels();
    expect(models.map((m) => m.id)).toContain("uni-1/layering");
  });

  it("falls back to the snapshot when the docs cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const models = await getLumaModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).toContain("uni-1/image");
  });

  it("refuses an HTML error page dressed as a doc", async () => {
    // A bad path on this host answers 200-shaped HTML. Parsing it yields zero
    // models, which is indistinguishable from a real empty answer — so it is
    // rejected on content-type and the snapshot is used instead.
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("<!DOCTYPE html><html>404</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));
    const models = await getLumaModels();
    expect(models.map((m) => m.id)).toContain("uni-1/image");
  });

  it("serves the cached catalogue without refetching", async () => {
    const f = vi.fn(async (url: string) =>
      new Response(String(url).includes("guides/model") ? MODEL_GUIDE : API_REF, {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    );
    vi.stubGlobal("fetch", f);
    await getLumaModels();
    const callsAfterFirst = f.mock.calls.length;
    await getLumaModels();
    expect(f.mock.calls.length).toBe(callsAfterFirst);
  });
});
