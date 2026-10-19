/**
 * Which schema property a generic image gets mapped onto.
 *
 * When no property is named exactly like a known pattern, the matcher falls
 * back to a substring test — and substrings are indiscriminate. With the
 * pattern "image", the property `num_images` matches, so a wired image URL was
 * written into a counter and fal answered:
 *
 *   422 {"type":"int_parsing","loc":["body","num_images"],
 *        "msg":"Input should be a valid integer, unable to parse string as an
 *        integer","input":"https://v3b.fal.media/files/b/..."}
 *
 * `image_size` matches the same way and would have taken the URL just as
 * happily. The guard is a type test rather than a blocklist of names.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { generateWithFalQueue, clearFalInputMappingCache } from "../fal";
import { canHoldMediaUrl } from "../../schemaUtils";
import type { GenerationInput } from "@/lib/providers/types";

const MODEL = "fal-ai/test-model";
let body: Record<string, unknown> | null = null;

function mockFetch(props: Record<string, unknown>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes("api.fal.ai/v1/models")) {
      return new Response(
        JSON.stringify({
          models: [{ endpoint_id: MODEL, openapi: {
            paths: { "/": { post: { requestBody: { content: { "application/json": { schema: { properties: props } } } } } } },
          } }],
        }),
        { status: 200 }
      );
    }
    if (u.includes(`queue.fal.run/${MODEL}`) && init?.method === "POST") {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        request_id: "r1",
        status_url: `https://queue.fal.run/${MODEL}/requests/r1/status`,
        response_url: `https://queue.fal.run/${MODEL}/requests/r1`,
      }), { status: 200 });
    }
    if (u.includes("/requests/r1/status")) return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
    if (u.includes("/requests/r1")) return new Response(JSON.stringify({ images: [{ url: "https://cdn.fal.ai/o.png" }] }), { status: 200 });
    if (u.includes("cdn.fal.ai")) return new Response(Buffer.from([1]), { status: 200, headers: { "content-type": "image/png" } });
    return new Response("nf", { status: 404 });
  });
}

const IMG = "https://v3b.fal.media/files/b/abc/ref.jpeg";

async function send(props: Record<string, unknown>) {
  clearFalInputMappingCache();
  body = null;
  vi.stubGlobal("fetch", mockFetch(props));
  await generateWithFalQueue("req", "key", {
    model: { id: MODEL, name: "T", description: null, provider: "fal", capabilities: ["text-to-image"] },
    prompt: "a cat",
    images: [IMG],
    parameters: {},
  } as GenerationInput);
  return body!;
}

afterEach(() => vi.unstubAllGlobals());

describe("canHoldMediaUrl", () => {
  it("accepts a plain string", () => {
    expect(canHoldMediaUrl("image_url", { type: "string" })).toBe(true);
  });

  it("accepts a list of strings, including a nullable one", () => {
    expect(canHoldMediaUrl("image_urls", { type: "array", items: { type: "string" } })).toBe(true);
    expect(
      canHoldMediaUrl("image_urls", { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] })
    ).toBe(true);
  });

  it("rejects a counter", () => {
    // The reported bug: `num_images` contains "image" and is an integer.
    expect(canHoldMediaUrl("num_images", { type: "integer" })).toBe(false);
  });

  it("rejects an enum, even though it is a string", () => {
    // `image_size` is a string, but one of a closed set. A URL never is.
    expect(canHoldMediaUrl("image_size", { type: "string", enum: ["square", "landscape_4_3"] })).toBe(false);
  });

  it("rejects an object and junk", () => {
    expect(canHoldMediaUrl("x", { type: "object" })).toBe(false);
    expect(canHoldMediaUrl("x", undefined)).toBe(false);
  });
});

describe("fal generic-image mapping", () => {
  it("never writes an image URL into num_images", async () => {
    const sent = await send({
      prompt: { type: "string" },
      num_images: { type: "integer", default: 1 },
      image_size: { type: "string", enum: ["square", "landscape_4_3"] },
    });
    expect(sent.num_images).not.toBe(IMG);
    expect(sent.num_images === undefined || typeof sent.num_images === "number").toBe(true);
  });

  it("never writes an image URL into image_size", async () => {
    const sent = await send({
      prompt: { type: "string" },
      image_size: { type: "string", enum: ["square", "landscape_4_3"] },
    });
    expect(sent.image_size).not.toBe(IMG);
  });

  it("still maps onto a real image field", async () => {
    const sent = await send({
      prompt: { type: "string" },
      num_images: { type: "integer" },
      image_url: { type: "string" },
    });
    expect(sent.image_url).toBe(IMG);
  });

  it("still maps onto a nullable array image field, wrapped as a list", async () => {
    const sent = await send({
      prompt: { type: "string" },
      num_images: { type: "integer" },
      reference_image_urls: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
    });
    expect(sent.reference_image_urls).toEqual([IMG]);
  });

  it("prefers the real image field over the counter when both match", async () => {
    // Declaration order puts the counter first; the type gate is what decides,
    // not which property happens to be listed earlier.
    const sent = await send({
      num_images: { type: "integer" },
      prompt: { type: "string" },
      input_image: { type: "string" },
    });
    expect(sent.input_image).toBe(IMG);
    expect(sent.num_images).not.toBe(IMG);
  });
});
