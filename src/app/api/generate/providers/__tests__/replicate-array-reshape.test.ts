/**
 * Replicate's array<->scalar reshape of dynamicInputs.
 *
 * The provider wraps a lone value when the schema says the field is a list and
 * unwraps a list to its first element when the schema says it is scalar. The
 * unwrap is the destructive half, and it used to fire on a NEGATIVE test:
 * "this field is not in schemaArrayParams". That set is empty whenever no
 * schema could be read — and `openapi_schema` is optional on a Replicate
 * version — so a model that simply publishes no schema had every list it was
 * sent quietly reduced to one element.
 *
 * Unknown is not the same as scalar. These pin both readings.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateWithReplicate } from "../replicate";
import type { GenerationInput } from "@/lib/providers/types";

let capturedPredictionBody: Record<string, unknown> | null = null;

function makeInput(dynamicInputs: Record<string, unknown>): GenerationInput {
  return {
    model: {
      id: "owner/test-model",
      name: "Test Model",
      description: null,
      provider: "replicate",
      capabilities: ["text-to-image"],
    },
    prompt: "a photo of a cat",
    images: [],
    parameters: {},
    dynamicInputs,
  } as GenerationInput;
}

/** @param schema pass null to publish a version with NO openapi_schema. */
function createMockFetch(schema: Record<string, unknown> | null) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

    if (urlStr.includes("/models/owner/test-model") && !urlStr.includes("/predictions")) {
      return new Response(
        JSON.stringify({
          latest_version: { id: "abc123", ...(schema ? { openapi_schema: schema } : {}) },
        }),
        { status: 200 }
      );
    }

    if (urlStr.includes("/predictions") && init?.method === "POST") {
      capturedPredictionBody = JSON.parse(init.body as string).input;
      return new Response(
        JSON.stringify({
          id: "pred-123",
          status: "succeeded",
          output: ["https://replicate.delivery/test/image.png"],
        }),
        { status: 200 }
      );
    }

    if (urlStr.includes("replicate.delivery")) {
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    return new Response("Not Found", { status: 404 });
  });
}

const SCHEMA_WITH_ARRAY = {
  components: {
    schemas: {
      Input: {
        properties: {
          prompt: { type: "string" },
          image_urls: { type: "array", items: { type: "string" } },
          image_url: { type: "string" },
        },
      },
    },
  },
};

describe("replicate reshape of dynamicInputs", () => {
  beforeEach(() => {
    capturedPredictionBody = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps a lone value when the schema declares a list", async () => {
    vi.stubGlobal("fetch", createMockFetch(SCHEMA_WITH_ARRAY));
    await generateWithReplicate("req", "key", makeInput({ image_urls: "https://a.example/1.png" }));

    expect(capturedPredictionBody!.image_urls).toEqual(["https://a.example/1.png"]);
  });

  it("unwraps a list when the schema positively declares a scalar", async () => {
    vi.stubGlobal("fetch", createMockFetch(SCHEMA_WITH_ARRAY));
    await generateWithReplicate("req", "key", makeInput({
      image_url: ["https://a.example/1.png", "https://a.example/2.png"],
    }));

    expect(capturedPredictionBody!.image_url).toBe("https://a.example/1.png");
  });

  it("keeps the list intact when the version publishes no schema", async () => {
    // The regression: no openapi_schema means no knowledge, not "scalar".
    vi.stubGlobal("fetch", createMockFetch(null));
    await generateWithReplicate("req", "key", makeInput({
      image_urls: ["https://a.example/1.png", "https://a.example/2.png"],
    }));

    expect(capturedPredictionBody!.image_urls).toEqual([
      "https://a.example/1.png",
      "https://a.example/2.png",
    ]);
  });

  it("keeps the list intact when the schema is unparseable", async () => {
    vi.stubGlobal("fetch", createMockFetch({ components: { schemas: {} } }));
    await generateWithReplicate("req", "key", makeInput({
      image_urls: ["https://a.example/1.png", "https://a.example/2.png"],
    }));

    expect(capturedPredictionBody!.image_urls).toEqual([
      "https://a.example/1.png",
      "https://a.example/2.png",
    ]);
  });
});
