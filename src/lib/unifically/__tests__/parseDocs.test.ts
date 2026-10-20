/**
 * Reading Unifically's llms-full.txt as per-model schemas.
 *
 * The fixture reproduces the shapes found in the real file, including the ones
 * that broke earlier versions of this parser:
 *  - a family page (Veo 3.1) whose variants are named only in a Model ID
 *    table, with mode-specific tables (Extend, Upscale) further down;
 *  - another page that CROSS-REFERENCES the Veo upscaler inside a parameter
 *    description link — counting that as a declaration made the upscaler
 *    inherit that page's parameters and that page lose its own;
 *  - a nested-object table ("Elements") that must not become top-level.
 */

import { describe, it, expect } from "vitest";
import { buildSchemaIndex, splitModelPages, modelIdsOnPage, parsePageSchemas, describedValues } from "../parseDocs";

const VEO = `# Veo 3.1
Source: https://docs.unifically.com/models/video/google/veo-3.1

## Models

| Mode | Model ID | Notes |
| - | - | - |
| Lite | \`google/veo-3.1-lite\` | Balanced default |
| Fast | \`google/veo-3.1-fast\` | Faster |

## Parameters

| Parameter | Type | Required | Default | Description |
| - | - | - | - | - |
| \`prompt\` | string | Yes | - | Main video prompt. |
| \`aspect_ratio\` | string | No | \`"16:9"\` | Output orientation. Allowed: \`"16:9"\`, \`"9:16"\`. |
| \`duration\` | integer | No | \`4\` | Seconds. |
| \`start_image_url\` | string | No | - | First frame. |
| \`reference_image_urls\` | string\\[] | No | - | Image references. |
| \`reference_characters\` | array | No | - | Character references, each with its own image URLs. |
| \`allow_audio_filtered\` | boolean | No | \`false\` | Run without audio instead of failing. |

## Text-to-Video

\`\`\`bash
curl -d '{ "model": "google/veo-3.1-fast", "input": { "prompt": "a cat" } }'
\`\`\`

## Extend

Extend a previously generated video using \`google/veo-3.1-extend\`.

| Parameter | Type | Required | Description |
| - | - | - | - |
| \`prompt\` | string | Yes | Text prompt for the extended content |
| \`task_id\` | string | Yes | Task ID of a completed generation |

## Upscale

Upscale a completed video using \`google/veo-3.1-upscale\`.

| Parameter | Type | Required | Description |
| - | - | - | - |
| \`task_id\` | string | Yes | Task ID |
| \`resolution\` | string | Yes | Target resolution |
`;

const OMNI = `# Gemini Omni Flash 1.1
Source: https://docs.unifically.com/models/video/google/gemini-omni-flash-1.1

## Parameters

| Parameter | Type | Required | Default | Description |
| - | - | - | - | - |
| \`prompt\` | string | Yes | - | Prompt. |
| \`resolution\` | string | No | \`"720p"\` | Allowed: \`"360p"\`, \`"720p"\`. Can be upscaled later with [\`google/veo-3.1-upscale\`](/models/video/google/veo-3.1#upscale). |

The 360p tier costs half the 720p price. Completed videos are upscaled with [\`google/veo-3.1-upscale\`](/models/video/google/veo-3.1#upscale) — pass this task's \`task_id\`.

## Text-to-Video

\`\`\`bash
curl -d '{ "model": "google/gemini-omni-flash-1.1-video", "input": {} }'
\`\`\`
`;

const KLING = `# Kling 3.0
Source: https://docs.unifically.com/models/video/kling/kling-3.0

## Parameters

| Parameter | Type | Required | Description |
| - | - | - | - |
| \`prompt\` | string | Yes | Prompt |
| \`elements\` | ElementInput\\[] | No | Elements |

### Elements

| Parameter | Type | Required | Description |
| - | - | - | - |
| \`frontal_image_url\` | string | Yes | Front view |

\`\`\`bash
curl -d '{ "model": "kuaishou/kling-3.0-video", "input": {} }'
\`\`\`
`;

const LLM = `# Some LLM
Source: https://docs.unifically.com/models/llm/openai/gpt-5.4

## Parameters

| Parameter | Type | Required | Description |
| - | - | - | - |
| \`messages\` | array | Yes | Chat |

\`\`\`bash
curl -d '{ "model": "openai/gpt-5.4" }'
\`\`\`
`;

// OMNI before VEO on purpose: page order in the real file varies, and with the
// cross-reference counted, whichever page comes first claims the upscaler.
const FULL = ["# Intro\nSource: https://docs.unifically.com/introduction\n\nhello", OMNI, VEO, KLING, LLM].join("\n\n");
const index = buildSchemaIndex(FULL);
const props = (id: string) => Object.keys(index.get(id)?.properties ?? {});

describe("splitModelPages", () => {
  it("keeps generation model pages and drops LLM and non-model pages", () => {
    const urls = splitModelPages(FULL).map((p) => p.url);
    expect(urls).toEqual([
      "https://docs.unifically.com/models/video/google/gemini-omni-flash-1.1",
      "https://docs.unifically.com/models/video/google/veo-3.1",
      "https://docs.unifically.com/models/video/kling/kling-3.0",
    ]);
  });
});

describe("modelIdsOnPage", () => {
  it("finds ids from curl examples, Model ID tables and scoped section prose", () => {
    expect(new Set(modelIdsOnPage(VEO))).toEqual(
      new Set(["google/veo-3.1-fast", "google/veo-3.1-lite", "google/veo-3.1-extend", "google/veo-3.1-upscale"])
    );
  });
});

describe("schema scoping", () => {
  it("gives family variants the general Parameters table", () => {
    expect(props("google/veo-3.1-lite")).toContain("start_image_url");
    expect(props("google/veo-3.1-fast")).toContain("aspect_ratio");
  });

  it("keeps mode-specific fields out of the general schema", () => {
    expect(props("google/veo-3.1-fast")).not.toContain("task_id");
  });

  it("gives a scoped mode only its own table", () => {
    expect(props("google/veo-3.1-extend").sort()).toEqual(["prompt", "task_id"]);
    expect(props("google/veo-3.1-upscale").sort()).toEqual(["resolution", "task_id"]);
  });

  it("does not let a cross-reference link claim another page's table", () => {
    // OMNI mentions the Veo upscaler inside a link in a description. It must
    // keep its own schema, and must not hand it to the upscaler.
    expect(props("google/gemini-omni-flash-1.1-video")).toEqual(["prompt", "resolution"]);
    expect(index.get("google/veo-3.1-upscale")!.properties.resolution.enum).toBeUndefined();
  });

  it("does not promote a nested-object table to top-level fields", () => {
    expect(props("kuaishou/kling-3.0-video")).toEqual(["prompt", "elements"]);
  });
});

describe("property details", () => {
  const veo = () => index.get("google/veo-3.1-fast")!.properties;

  it("reads Allowed: values as an enum and quoted defaults as values", () => {
    expect(veo().aspect_ratio.enum).toEqual(["16:9", "9:16"]);
    expect(veo().aspect_ratio.default).toBe("16:9");
  });

  it("types numbers and booleans, with typed defaults", () => {
    expect(veo().duration.type).toBe("integer");
    expect(veo().duration.default).toBe(4);
    expect(veo().allow_audio_filtered.type).toBe("boolean");
    expect(veo().allow_audio_filtered.default).toBe(false);
  });

  it("marks required fields", () => {
    expect(index.get("google/veo-3.1-fast")!.required).toEqual(["prompt"]);
  });

  it("reads string[] as a list of strings", () => {
    expect(veo().reference_image_urls.type).toBe("array");
    expect(veo().reference_image_urls.items?.type).toBe("string");
  });

  it("reads a bare array as objects unless the name says it holds URLs", () => {
    // reference_characters is a list of character objects; typing it as a URL
    // list made it an image pin that sent bare URLs where objects belong.
    expect(veo().reference_characters.items?.type).toBe("object");
  });
});

describe("parsePageSchemas", () => {
  it("returns nothing for a page with no Parameters table", () => {
    expect(parsePageSchemas("# X\nSource: https://docs.unifically.com/models/video/a/b\n\nno table").size).toBe(0);
  });
});

describe("describedValues", () => {
  // Every phrasing below is copied from the real docs. Reading only
  // "Allowed:" left Seedance's resolution and dozens more as free text.
  it("reads a bare backticked list as a closed set", () => {
    expect(describedValues("`720p`, `1080p`, `4k`").enum).toEqual(["720p", "1080p", "4k"]);
    expect(describedValues('`"none"`, `"word"`, or `"character"`').enum).toEqual(["none", "word", "character"]);
    expect(describedValues("`5` or `10` seconds (default: `5`)")).toEqual({ enum: ["5", "10"], default: "5" });
  });

  it("reads lead-ins, annotations and trailing asides", () => {
    expect(describedValues("Output frame rate. One of `24`, `25`, `30`. Does not change the price").enum).toEqual(["24", "25", "30"]);
    expect(describedValues("Output container: `mp3`, `wav`, `pcm`").enum).toEqual(["mp3", "wav", "pcm"]);
    expect(describedValues('`"std"` (720p) or `"pro"` (1080p); see [Pricing](#pricing). 4K is rejected').enum).toEqual(["std", "pro"]);
    expect(describedValues("`768p` (default) or `1080p`")).toEqual({ enum: ["768p", "1080p"], default: "768p" });
    expect(describedValues("`1K` only").enum).toEqual(["1K"]);
  });

  it("keeps a model id in the lead-in out of the values", () => {
    expect(describedValues("`suno-ai/mp3` only: `mp3` (default) or `m4a`").enum).toEqual(["mp3", "m4a"]);
  });

  it("treats e.g. lists as suggestions, not a closed set", () => {
    // "e.g." must not end the sentence, or the list after it looks bare.
    expect(describedValues('Output-dimension multiplier, e.g. `2`, `2.5`, `"4x"`. Omit to keep the source size'))
      .toEqual({ examples: ["2", "2.5", "4x"] });
  });

  it("does not take a list of sibling fields for values", () => {
    const fields = new Set(["input", "text", "dialog"]);
    expect(describedValues("Text to speak. \*Provide exactly one of `input`, `text`, or `dialog`", fields).enum).toBeUndefined();
    // …but a value that merely shares a field's name is still a value.
    expect(describedValues('Reference strategy: `"restyle"`, `"elements"`', new Set(["elements"])).enum).toEqual(["restyle", "elements"]);
  });

  it("ignores ranges and prose", () => {
    expect(describedValues("Clarity, `0`–`1`").enum).toBeUndefined();
    expect(describedValues("Mutually exclusive with `voice_id`").enum).toBeUndefined();
  });

  it("types values for number fields and drops placeholder defaults", () => {
    const page = `# M
Source: https://docs.unifically.com/models/video/x/m

## Parameters

| Parameter | Type | Required | Default | Description |
| - | - | - | - | - |
| \`duration\` | integer | No | - | \`6\` (default) or \`10\` seconds |
| \`ratio\` | string | No | \`null\` | Aspect ratio (T2V only): \`"16:9"\`, \`"9:16"\` |

\`\`\`bash
curl -d '{ "model": "x/m" }'
\`\`\`
`;
    const s = parsePageSchemas(page).get("x/m")!;
    expect(s.properties.duration).toMatchObject({ enum: [6, 10], default: 6 });
    expect(s.properties.ratio.enum).toEqual(["16:9", "9:16"]);
    expect(s.properties.ratio.default).toBeUndefined();
  });
});
