/**
 * The reshape fal applies to dynamicInputs on the way out.
 *
 * Reproduces the reported failure end to end: generating with
 * fal-ai/kling-video/o3/4k/video-to-video/edit returned
 *   422 {"type":"list_type","loc":["body","image_urls"],
 *        "msg":"Input should be a valid list","input":"https://v3b.fal.media/..."}
 *
 * The schema fixtures here are the live fal shapes for that model: an optional
 * array is a nullable union (`anyOf:[{type:"array"},{type:"null"}]`) with no
 * top-level `type`, and `elements` is the same but with $ref'd items.
 *
 * Both halves of the reshape are covered, because the destructive half is the
 * one that caused the bug: failing to WRAP is recoverable, but UNWRAPPING an
 * array the client deliberately built throws data away.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateWithFalQueue, clearFalInputMappingCache } from "../fal";
import type { GenerationInput } from "@/lib/providers/types";

const MODEL = "fal-ai/kling-video/o3/4k/video-to-video/edit";

let capturedQueueBody: Record<string, unknown> | null = null;

function makeInput(dynamicInputs: Record<string, unknown>): GenerationInput {
  return {
    model: {
      id: MODEL,
      name: "Kling o3 4K V2V Edit",
      description: null,
      provider: "fal",
      capabilities: ["image-to-video"],
    },
    prompt: "keep the shot locked off",
    images: [],
    parameters: {},
    dynamicInputs,
  } as GenerationInput;
}

/** Live property shapes from the model's OpenAPI spec. */
const LIVE_PROPERTIES = {
  prompt: { type: "string", title: "Prompt" },
  video_url: { type: "string", title: "Video Url" },
  image_urls: {
    anyOf: [{ items: { type: "string" }, type: "array" }, { type: "null" }],
    title: "Image Urls",
  },
  elements: {
    anyOf: [
      { items: { $ref: "#/components/schemas/KlingV3ImageElementInput" }, type: "array" },
      { type: "null" },
    ],
    title: "Elements",
  },
  // From kling v2.5-turbo: a nullable SCALAR sharing the union shape.
  tail_image_url: { anyOf: [{ type: "string" }, { type: "null" }], title: "Tail Image Url" },
};

function createMockFetch(opts: { schemaStatus?: number } = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

    if (urlStr.includes("api.fal.ai/v1/models")) {
      if (opts.schemaStatus && opts.schemaStatus !== 200) {
        return new Response("upstream is having a bad day", { status: opts.schemaStatus });
      }
      return new Response(
        JSON.stringify({
          models: [
            {
              endpoint_id: MODEL,
              openapi: {
                components: {
                  schemas: {
                    KlingV3ImageElementInput: {
                      type: "object",
                      properties: { frontal_image_url: { type: "string" } },
                    },
                  },
                },
                paths: {
                  "/": {
                    post: {
                      requestBody: {
                        content: { "application/json": { schema: { properties: LIVE_PROPERTIES } } },
                      },
                    },
                  },
                },
              },
            },
          ],
        }),
        { status: 200 }
      );
    }

    if (urlStr.includes(`queue.fal.run/${MODEL}`) && init?.method === "POST") {
      capturedQueueBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          request_id: "req-1",
          status_url: `https://queue.fal.run/${MODEL}/requests/req-1/status`,
          response_url: `https://queue.fal.run/${MODEL}/requests/req-1`,
        }),
        { status: 200 }
      );
    }
    if (urlStr.includes("/requests/req-1/status")) {
      return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
    }
    if (urlStr.includes("/requests/req-1")) {
      return new Response(JSON.stringify({ video: { url: "https://cdn.fal.ai/out.mp4" } }), { status: 200 });
    }
    if (urlStr.includes("cdn.fal.ai")) {
      return new Response(Buffer.from([0x00, 0x01]), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }
    return new Response("Not Found", { status: 404 });
  });
}

describe("fal reshape — nullable array inputs", () => {
  beforeEach(() => {
    capturedQueueBody = null;
    clearFalInputMappingCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps a lone image_urls value into a list (the reported 422)", async () => {
    vi.stubGlobal("fetch", createMockFetch());
    await generateWithFalQueue("req", "key", makeInput({
      video_url: "https://cdn.example.com/clip.mp4",
      image_urls: "https://v3b.fal.media/files/b/ref.jpeg",
    }));

    expect(capturedQueueBody!.image_urls).toEqual(["https://v3b.fal.media/files/b/ref.jpeg"]);
  });

  it("leaves an already-correct list alone", async () => {
    vi.stubGlobal("fetch", createMockFetch());
    await generateWithFalQueue("req", "key", makeInput({
      video_url: "https://cdn.example.com/clip.mp4",
      image_urls: ["https://a.example/1.png", "https://a.example/2.png"],
    }));

    expect(capturedQueueBody!.image_urls).toEqual([
      "https://a.example/1.png",
      "https://a.example/2.png",
    ]);
  });

  it("does not wrap a nullable scalar — the mirror failure", async () => {
    vi.stubGlobal("fetch", createMockFetch());
    await generateWithFalQueue("req", "key", makeInput({
      video_url: "https://cdn.example.com/clip.mp4",
      tail_image_url: "https://a.example/tail.png",
    }));

    expect(capturedQueueBody!.tail_image_url).toBe("https://a.example/tail.png");
  });

  it("keeps the client's list when the schema could not be fetched", async () => {
    // Every failure path in getFalInputMapping returns EMPTY sets, which reads
    // identically to "the schema says this is a scalar". Before this was gated,
    // one flaky schema request silently unwrapped every array on every model —
    // an outage in fal's metadata API corrupted requests to its own queue.
    vi.stubGlobal("fetch", createMockFetch({ schemaStatus: 500 }));
    await generateWithFalQueue("req", "key", makeInput({
      video_url: "https://cdn.example.com/clip.mp4",
      image_urls: ["https://a.example/1.png", "https://a.example/2.png"],
    }));

    expect(capturedQueueBody!.image_urls).toEqual([
      "https://a.example/1.png",
      "https://a.example/2.png",
    ]);
  });
});
