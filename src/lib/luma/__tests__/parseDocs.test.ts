/**
 * Parsing Luma's API-reference markdown into a parameter tree.
 *
 * The fixture below is copied verbatim from
 * https://docs.agents.lumalabs.ai/api/resources/generations/methods/create/index.md
 * (trimmed to the shapes that matter). It is the real grammar, not an
 * idealisation of it — including the awkward parts: a named type whose members
 * are listed as child bullets, an inline union written only in the typespec,
 * and two levels of nesting.
 */

import { describe, it, expect } from "vitest";
import { parseParamTree, findParam, parseEnum, parseModels, parseTypes } from "../parseDocs";

const DOC = `## Create a generation

POST /generations

Submit an image or video generation job.

### Body Parameters

- \`prompt: string\`

  Text prompt

- \`model: optional Model\`

  Model identifier. \`uni-1\` is the default image tier.

  - \`"uni-1"\`

  - \`"uni-1-max"\`

  - \`"ray-3.2"\`

- \`output_format: optional "png" or "jpeg"\`

  Output image format

- \`style: optional "auto" or "manga"\`

  Style preset (auto, manga)

  - \`"auto"\`

  - \`"manga"\`

- \`type: optional "image" or "image_edit" or "video" or 3 more\`

  The kind of generation to perform

  - \`"image"\`

  - \`"image_edit"\`

  - \`"video"\`

  - \`"video_edit"\`

  - \`"video_reframe"\`

  - \`"layering"\`

- \`layering: optional object { resolution }\`

  Layer-extraction options for type=layering (model uni-1).

  - \`resolution: optional "1k" or "2k"\`

    Output resolution for every extracted layer.

- \`video: optional VideoOptions\`

  Ray 3.2 video request options.

  - \`resolution: optional VideoResolution\`

    Ray 3.2 video output resolution.

    - \`"360p"\`

    - \`"540p"\`

    - \`"720p"\`

    - \`"1080p"\`

  - \`edit: optional VideoEditOptions\`

    Ray 3.2 video-to-video edit controls.

    - \`strength: optional VideoEditStrength\`

      How much a video edit preserves or reimagines the source

      - \`"adhere_1"\`

      - \`"flex_1"\`

### Returns

- \`id: string\`

  Generation identifier
`;

describe("parseParamTree", () => {
  const tree = parseParamTree(DOC)!;

  it("reads the top-level fields in document order", () => {
    expect(tree).not.toBeNull();
    expect(tree.map((n) => n.name)).toEqual([
      "prompt", "model", "output_format", "style", "type", "layering", "video",
    ]);
  });

  it("stops at the next section so Returns is not mistaken for a parameter", () => {
    // `id` lives under ### Returns. If the walk ran on, it would surface as a
    // request field and the schema would offer a pin for the response's id.
    expect(findParam(tree, "id")).toBeNull();
  });

  it("marks required vs optional", () => {
    expect(findParam(tree, "prompt")!.optional).toBe(false);
    expect(findParam(tree, "model")!.optional).toBe(true);
  });

  it("captures the description prose", () => {
    expect(findParam(tree, "prompt")!.description).toBe("Text prompt");
  });

  it("nests one level", () => {
    expect(findParam(tree, "layering.resolution")).not.toBeNull();
    expect(findParam(tree, "video.resolution")).not.toBeNull();
  });

  it("nests two levels", () => {
    const s = findParam(tree, "video.edit.strength");
    expect(s).not.toBeNull();
    expect(s!.typeSpec).toBe("optional VideoEditStrength");
  });

  it("returns null for a missing section rather than an empty tree", () => {
    // A restructured docs page must read as failure. An empty array would be
    // indistinguishable from "this API takes no parameters", which would then
    // be cached and served as a real schema.
    expect(parseParamTree("# Some other page\n\nNo parameters here.")).toBeNull();
  });
});

describe("parseEnum", () => {
  const tree = parseParamTree(DOC)!;

  it("reads members from child bullets", () => {
    expect(parseEnum(tree, "style")).toEqual(["auto", "manga"]);
  });

  it("reads members from an inline union when there are no child bullets", () => {
    // `output_format` carries its members only in the typespec.
    expect(parseEnum(tree, "output_format")).toEqual(["png", "jpeg"]);
  });

  it("prefers child bullets over the truncated typespec", () => {
    // The typespec says `"image" or "image_edit" or "video" or 3 more` — the
    // generator elides the tail. The bullets carry all six.
    expect(parseEnum(tree, "type")).toEqual([
      "image", "image_edit", "video", "video_edit", "video_reframe", "layering",
    ]);
  });

  it("reads a nested enum", () => {
    expect(parseEnum(tree, "video.resolution")).toEqual(["360p", "540p", "720p", "1080p"]);
    expect(parseEnum(tree, "video.edit.strength")).toEqual(["adhere_1", "flex_1"]);
    expect(parseEnum(tree, "layering.resolution")).toEqual(["1k", "2k"]);
  });

  it("returns null for a field with no enum", () => {
    expect(parseEnum(tree, "prompt")).toBeNull();
  });

  it("returns null for a field that does not exist", () => {
    expect(parseEnum(tree, "nope.not.here")).toBeNull();
  });
});

describe("parseModels / parseTypes", () => {
  const tree = parseParamTree(DOC)!;

  it("discovers the model identifiers", () => {
    // The whole point: a model Luma adds to this list appears here with no
    // code change.
    expect(parseModels(tree)).toEqual(["uni-1", "uni-1-max", "ray-3.2"]);
  });

  it("discovers the generation types", () => {
    expect(parseTypes(tree)).toContain("layering");
  });

  it("does not invent models when the page cannot be parsed", () => {
    const empty = parseParamTree("garbage");
    expect(empty).toBeNull();
  });
});
