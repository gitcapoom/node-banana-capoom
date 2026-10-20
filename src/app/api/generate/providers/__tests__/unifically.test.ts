/**
 * The Unifically provider: request shaping, polling and output collection.
 *
 * The request shapes asserted here were first validated against the live API
 * with `dry_run: true` (validates and prices without creating a task): Veo
 * text- and image-to-video, Nano Banana Pro with references, Seedance 2.5 with
 * a lone image wrapped into its image_urls list, and ElevenLabs TTS with the
 * prompt routed into `text`. These pin them offline.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  generateWithUnifically,
  promptField,
  genericImageField,
  collectOutputs,
} from "../unifically";
import type { GenerationInput } from "@/lib/providers/types";
import type { NormalizedSchema } from "@/lib/schema/types";

const schema = (props: Record<string, { type: NormalizedSchema["properties"][string]["type"] }>): NormalizedSchema => ({
  properties: Object.fromEntries(Object.entries(props).map(([n, p]) => [n, { name: n, ...p }])),
  required: [],
  source: "static",
});

const VEO = schema({ prompt: { type: "string" }, start_image_url: { type: "string" }, aspect_ratio: { type: "string" } });
const SEEDANCE = schema({ prompt: { type: "string" }, image_urls: { type: "array" } });
const TTS = schema({ text: { type: "string" }, voice: { type: "string" } });

let submitted: { model: string; input: Record<string, unknown> } | null = null;

function mockApi(opts: { poll?: unknown; submitStatus?: number; submitBody?: unknown } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/v1/tasks") && init?.method === "POST") {
      submitted = JSON.parse(init.body as string);
      if (opts.submitStatus) return new Response(JSON.stringify(opts.submitBody), { status: opts.submitStatus });
      return new Response(JSON.stringify({ success: true, code: 200, data: { task_id: "t1", status: "processing" } }));
    }
    if (u.includes("/v1/tasks/t1")) {
      return new Response(JSON.stringify(opts.poll ?? {
        success: true, code: 200,
        data: { task_id: "t1", status: "completed", output: { video_url: "https://cdn.unifically.com/outputs/a.mp4" } },
      }));
    }
    if (u.startsWith("https://cdn.unifically.com/")) {
      return new Response(Buffer.from([1, 2, 3]), {
        headers: { "content-type": u.endsWith(".mp4") ? "video/mp4" : u.endsWith(".mp3") ? "audio/mpeg" : "image/png" },
      });
    }
    return new Response("nf", { status: 404 });
  }));
}

const run = (over: Partial<GenerationInput>, s: NormalizedSchema | null) =>
  generateWithUnifically("req", "key", {
    model: { id: "google/veo-3.1-fast", name: "Veo", description: null, provider: "unifically", capabilities: [] },
    prompt: "a cat",
    images: [],
    parameters: {},
    ...over,
  } as GenerationInput, { pollIntervalMs: 1, schema: s, falApiKey: null });

afterEach(() => {
  vi.unstubAllGlobals();
  submitted = null;
});

describe("request shaping", () => {
  it("sends model and an input object with the prompt and settings", async () => {
    mockApi();
    await run({ parameters: { aspect_ratio: "16:9" } }, VEO);
    expect(submitted).toEqual({ model: "google/veo-3.1-fast", input: { aspect_ratio: "16:9", prompt: "a cat" } });
  });

  it("puts the prompt in the model's own text field when it has no `prompt`", async () => {
    // ElevenLabs TTS calls it `text`; sending `prompt` would be ignored.
    mockApi();
    await run({ prompt: "Hello" }, TTS);
    expect(submitted!.input).toEqual({ text: "Hello" });
  });

  it("wraps a lone value into a list when the schema declares one", async () => {
    mockApi();
    await run({ dynamicInputs: { image_urls: "https://a.example/1.png" } }, SEEDANCE);
    expect(submitted!.input.image_urls).toEqual(["https://a.example/1.png"]);
  });

  it("never unwraps a list", async () => {
    mockApi();
    await run({ dynamicInputs: { start_image_url: ["https://a/1.png", "https://a/2.png"] } }, VEO);
    expect(submitted!.input.start_image_url).toEqual(["https://a/1.png", "https://a/2.png"]);
  });

  it("routes un-pinned images to the model's image list", async () => {
    mockApi();
    await run({ images: ["https://a/ref.png"] }, SEEDANCE);
    expect(submitted!.input.image_urls).toEqual(["https://a/ref.png"]);
  });

  it("does not overwrite a pinned image with the generic ones", async () => {
    mockApi();
    await run({ images: ["https://a/generic.png"], dynamicInputs: { image_urls: ["https://a/pinned.png"] } }, SEEDANCE);
    expect(submitted!.input.image_urls).toEqual(["https://a/pinned.png"]);
  });
});

describe("results", () => {
  it("downloads the output", async () => {
    mockApi();
    const out = await run({}, VEO);
    expect(out.success).toBe(true);
    expect(out.outputs![0].type).toBe("video");
    expect(out.outputs![0].data.startsWith("data:video/mp4;base64,")).toBe(true);
  });

  it("surfaces a failed task's error_message", async () => {
    mockApi({ poll: { success: true, code: 200, data: { task_id: "t1", status: "failed", error_message: "content filtered" } } });
    const out = await run({}, VEO);
    expect(out.success).toBe(false);
    expect(out.error).toContain("content filtered");
  });

  it("surfaces a rejected submit's message", async () => {
    // The real response to a TTS request without a voice.
    mockApi({ submitStatus: 422, submitBody: { success: false, code: 422, data: { message: "voice: Field required" } } });
    const out = await run({ prompt: "Hi" }, TTS);
    expect(out.success).toBe(false);
    expect(out.error).toContain("voice: Field required");
  });

  it("reports an empty output instead of claiming success", async () => {
    mockApi({ poll: { success: true, data: { status: "completed", output: {} } } });
    const out = await run({}, VEO);
    expect(out.success).toBe(false);
  });
});

describe("helpers", () => {
  it("collectOutputs finds URLs under any key and types them", () => {
    expect(collectOutputs({
      video_url: "https://x/a.mp4",
      image_urls: ["https://x/b.png", "https://x/c.png"],
      audio_url: "https://x/d.mp3",
      cover_image_url: "https://x/cover.png",
      duration: 5,
    })).toEqual([
      { url: "https://x/a.mp4", kind: "video" },
      { url: "https://x/b.png", kind: "image" },
      { url: "https://x/c.png", kind: "image" },
      { url: "https://x/d.mp3", kind: "audio" },
    ]);
  });

  it("promptField and genericImageField fall back sensibly without a schema", () => {
    expect(promptField(null)).toBe("prompt");
    expect(genericImageField(null)).toEqual({ name: "image_urls", isArray: true });
    expect(genericImageField(VEO)).toEqual({ name: "start_image_url", isArray: false });
  });
});
