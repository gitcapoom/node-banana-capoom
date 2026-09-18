/**
 * WaveSpeed's array<->scalar reshape of dynamicInputs.
 *
 * This provider used to hardcode one field name: "images" was wrapped, and
 * every OTHER array-valued field was unwrapped to its first element. WaveSpeed
 * publishes a JSON Schema per model, and across the 1048 models it lists, 275
 * declare at least one array input — 132 of those occurrences are called
 * "images" and 242 are not (`loras`, `reference_images`, `reference_audios`,
 * `reference_videos`, `multi_prompt`, `element_list`, …). Sending several
 * reference images to minimax-h3 therefore delivered exactly one.
 *
 * Fixtures are the real shapes: flat properties, plain `type: "array"`, no
 * $ref and no nullable unions (verified against the live models endpoint).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateWithWaveSpeed } from "../wavespeed";
import { clearWaveSpeedSchemaCache } from "@/lib/providers/cache";
import type { GenerationInput } from "@/lib/providers/types";

const MODEL = "wavespeed-ai/minimax-h3/reference-to-video";

let capturedPayload: Record<string, unknown> | null = null;

function makeInput(dynamicInputs: Record<string, unknown>): GenerationInput {
  return {
    model: {
      id: MODEL,
      name: "MiniMax H3 Reference to Video",
      description: null,
      provider: "wavespeed",
      capabilities: ["image-to-video"],
    },
    prompt: "a locked-off shot",
    images: [],
    parameters: {},
    dynamicInputs,
  } as GenerationInput;
}

const REQUEST_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    reference_images: { type: "array", items: { type: "string" }, maxItems: 16 },
    reference_audios: { type: "array", items: { type: "string" } },
    loras: { type: "array", items: { type: "object" } },
    image: { type: "string" },
  },
};

/** @param serveSchema false = models endpoint fails, so no schema is readable. */
function createMockFetch(serveSchema: boolean) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

    // Schema lookup goes through the models endpoint.
    if (urlStr.includes("/api/v3/models") && !urlStr.includes("/predictions")) {
      if (!serveSchema) return new Response("nope", { status: 500 });
      return new Response(
        JSON.stringify({
          models: [
            { model_id: MODEL, api_schema: { api_schemas: [{ request_schema: REQUEST_SCHEMA }] } },
          ],
        }),
        { status: 200 }
      );
    }

    // Task submission.
    if (init?.method === "POST" && urlStr.includes(MODEL)) {
      capturedPayload = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ code: 200, message: "success", data: { id: "task-1", status: "completed", outputs: ["https://cdn.wavespeed.ai/out.mp4"] } }),
        { status: 200 }
      );
    }

    if (urlStr.includes("/predictions/task-1") || urlStr.includes("/result")) {
      return new Response(
        JSON.stringify({ code: 200, data: { id: "task-1", status: "completed", outputs: ["https://cdn.wavespeed.ai/out.mp4"] } }),
        { status: 200 }
      );
    }

    if (urlStr.includes("cdn.wavespeed.ai")) {
      return new Response(Buffer.from([0x00, 0x01]), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }
    return new Response("Not Found", { status: 404 });
  });
}

describe("wavespeed reshape of dynamicInputs", () => {
  beforeEach(() => {
    capturedPayload = null;
    // Module-level cache: without this a schema stored by an earlier case is
    // served to a later one, and the tests about the NO-schema path silently
    // exercise the has-schema path instead.
    clearWaveSpeedSchemaCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps every reference image, not just the first", async () => {
    // The regression this fixes: `reference_images` is not called "images", so
    // the old code unwrapped it and the model saw a single reference.
    vi.stubGlobal("fetch", createMockFetch(true));
    await generateWithWaveSpeed("req", "key", makeInput({
      reference_images: ["https://a.example/1.png", "https://a.example/2.png"],
    }));

    expect(capturedPayload!.reference_images).toEqual([
      "https://a.example/1.png",
      "https://a.example/2.png",
    ]);
  });

  it("wraps a lone value for any array field the schema declares", async () => {
    vi.stubGlobal("fetch", createMockFetch(true));
    await generateWithWaveSpeed("req", "key", makeInput({
      reference_audios: "https://a.example/vo.mp3",
    }));

    expect(capturedPayload!.reference_audios).toEqual(["https://a.example/vo.mp3"]);
  });

  it("still unwraps a field the schema positively declares scalar", async () => {
    vi.stubGlobal("fetch", createMockFetch(true));
    await generateWithWaveSpeed("req", "key", makeInput({
      image: ["https://a.example/1.png", "https://a.example/2.png"],
    }));

    expect(capturedPayload!.image).toBe("https://a.example/1.png");
  });

  it("keeps wrapping images when the schema cannot be read", async () => {
    // "images" is the one array name this provider always knew; losing the
    // schema must not lose that.
    vi.stubGlobal("fetch", createMockFetch(false));
    await generateWithWaveSpeed("req", "key", makeInput({ images: "https://a.example/1.png" }));

    expect(capturedPayload!.images).toEqual(["https://a.example/1.png"]);
  });

  it("unwraps nothing when the schema cannot be read", async () => {
    vi.stubGlobal("fetch", createMockFetch(false));
    await generateWithWaveSpeed("req", "key", makeInput({
      reference_images: ["https://a.example/1.png", "https://a.example/2.png"],
    }));

    expect(capturedPayload!.reference_images).toEqual([
      "https://a.example/1.png",
      "https://a.example/2.png",
    ]);
  });
});
