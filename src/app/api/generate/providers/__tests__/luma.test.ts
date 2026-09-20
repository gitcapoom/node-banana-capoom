/**
 * The Luma Agents provider: request shaping, polling, and output handling.
 *
 * Every response below is the real shape from
 * docs.agents.lumalabs.ai/api/resources/generations — including the two error
 * forms, which differ: a FastAPI validation failure returns `detail` as a LIST
 * of {loc,msg}, while a custom check (unknown model, missing source) returns it
 * as a plain STRING. Rendering only one of them leaves the other as
 * "[object Object]" in the node's error box.
 *
 * No real generation is performed — everything is a mocked fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateWithLuma, splitLumaModelId, toLumaImageRef } from "../luma";
import type { GenerationInput } from "@/lib/providers/types";

let submittedBody: Record<string, unknown> | null = null;

/** Every case polls at 1ms; the production default is seconds. */
const runLuma = (input: GenerationInput) =>
  generateWithLuma("req", "key", input, { pollIntervalMs: 1 });

function makeInput(over: Partial<GenerationInput> & { modelId?: string } = {}): GenerationInput {
  const { modelId, ...rest } = over;
  return {
    model: {
      id: modelId ?? "uni-1/image",
      name: "Uni-1",
      description: null,
      provider: "luma",
      capabilities: ["text-to-image"],
    },
    prompt: "a tabby cat on a mossy log",
    images: [],
    parameters: {},
    ...rest,
  } as GenerationInput;
}

interface MockOpts {
  /** Terminal generation payload returned by the poll. */
  poll?: Record<string, unknown>;
  /** Submit failure: [status, body]. */
  submitFail?: [number, unknown];
}

function mockFetch(opts: MockOpts = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

    if (u.endsWith("/v1/generations") && init?.method === "POST") {
      if (opts.submitFail) {
        const [status, body] = opts.submitFail;
        return new Response(JSON.stringify(body), { status });
      }
      submittedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: "gen-1", state: "queued" }), { status: 200 });
    }

    if (u.includes("/v1/generations/gen-1")) {
      return new Response(
        JSON.stringify(
          opts.poll ?? {
            id: "gen-1",
            state: "completed",
            output: [{ type: "image", url: "https://cdn.luma.test/out.png" }],
          }
        ),
        { status: 200 }
      );
    }

    if (u.includes("cdn.luma.test")) {
      return new Response(Buffer.from([0x89, 0x50]), {
        status: 200,
        headers: { "content-type": u.endsWith(".mp4") ? "video/mp4" : "image/png" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("splitLumaModelId", () => {
  it("splits model and type", () => {
    expect(splitLumaModelId("uni-1/image")).toEqual({ model: "uni-1", type: "image" });
    expect(splitLumaModelId("ray-3.2/video_reframe")).toEqual({ model: "ray-3.2", type: "video_reframe" });
  });

  it("treats an unrecognised tail as part of the model name", () => {
    // A future model whose id contains a slash must still reach the API; Luma
    // is the authority on whether it exists, not this lookup table.
    expect(splitLumaModelId("luma/ray-4")).toEqual({ model: "luma/ray-4" });
  });

  it("handles a bare model id", () => {
    expect(splitLumaModelId("uni-1")).toEqual({ model: "uni-1" });
  });
});

describe("toLumaImageRef", () => {
  it("strips the data-URL prefix and splits out media_type", () => {
    // Luma wants raw base64 plus a separate media_type; handing it the whole
    // `data:` string is rejected.
    expect(toLumaImageRef("data:image/png;base64,AAAB")).toEqual({
      data: "AAAB",
      media_type: "image/png",
    });
  });

  it("passes an http URL through as url", () => {
    expect(toLumaImageRef("https://a.example/x.png")).toEqual({ url: "https://a.example/x.png" });
  });

  it("recognises a bare generation UUID for chaining", () => {
    const id = "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e";
    expect(toLumaImageRef(id)).toEqual({ generation_id: id });
  });

  it("returns null for something unusable", () => {
    expect(toLumaImageRef("not a reference")).toBeNull();
    expect(toLumaImageRef("")).toBeNull();
  });
});

describe("generateWithLuma", () => {
  beforeEach(() => {
    submittedBody = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends model and type split out of the node's model id", async () => {
    vi.stubGlobal("fetch", mockFetch());
    await runLuma(makeInput({ modelId: "ray-3.2/video" }));

    expect(submittedBody!.model).toBe("ray-3.2");
    expect(submittedBody!.type).toBe("video");
  });

  it("omits type entirely when the id carries none", async () => {
    // Sending type:undefined would serialise away, but an explicit wrong guess
    // would not — better to let Luma apply its own default.
    vi.stubGlobal("fetch", mockFetch());
    await runLuma(makeInput({ modelId: "uni-1" }));

    expect(submittedBody!.model).toBe("uni-1");
    expect("type" in submittedBody!).toBe(false);
  });

  it("always sends a prompt, even an empty one", async () => {
    // `prompt` is required on every request including layering, where empty is
    // the documented way to let the planner decide.
    vi.stubGlobal("fetch", mockFetch());
    await runLuma(makeInput({ prompt: "", modelId: "uni-1/layering" }));

    expect(submittedBody!.prompt).toBe("");
  });

  it("routes generic images to image_ref as ImageRef objects", async () => {
    vi.stubGlobal("fetch", mockFetch());
    await runLuma(makeInput({
      images: ["data:image/png;base64,AAAB", "https://a.example/b.jpg"],
    }));

    expect(submittedBody!.image_ref).toEqual([
      { data: "AAAB", media_type: "image/png" },
      { url: "https://a.example/b.jpg" },
    ]);
  });

  it("shapes a source pin into a single ImageRef, not an array", async () => {
    vi.stubGlobal("fetch", mockFetch());
    await runLuma(makeInput({
      modelId: "uni-1/image_edit",
      dynamicInputs: { source: "https://a.example/src.png" },
    }));

    expect(submittedBody!.source).toEqual({ url: "https://a.example/src.png" });
  });

  it("nests dotted dynamic inputs into the video options object", async () => {
    vi.stubGlobal("fetch", mockFetch());
    await runLuma(makeInput({
      modelId: "ray-3.2/video",
      dynamicInputs: { "video.start_frame": "https://a.example/first.png" },
      parameters: { "video.resolution": "1080p", "video.duration": "5s" },
    }));

    expect(submittedBody!.video).toEqual({
      resolution: "1080p",
      duration: "5s",
      start_frame: { url: "https://a.example/first.png" },
    });
  });

  it("lets a wired pin win over a settings-panel value", async () => {
    vi.stubGlobal("fetch", mockFetch());
    await runLuma(makeInput({
      parameters: { aspect_ratio: "1:1" },
      dynamicInputs: { aspect_ratio: "16:9" },
    }));

    expect(submittedBody!.aspect_ratio).toBe("16:9");
  });

  it("downloads the output and returns it as a data URL", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const out = await runLuma(makeInput());

    expect(out.success).toBe(true);
    expect(out.outputs).toHaveLength(1);
    expect(out.outputs![0].type).toBe("image");
    expect(out.outputs![0].data.startsWith("data:image/png;base64,")).toBe(true);
    // The URL is kept too, but it is presigned for one hour — the bytes above
    // are what actually survives.
    expect(out.outputs![0].url).toBe("https://cdn.luma.test/out.png");
  });

  it("returns every layer for a layering job, not just the first", async () => {
    vi.stubGlobal("fetch", mockFetch({
      poll: {
        id: "gen-1",
        state: "completed",
        type: "layering",
        output: [
          { type: "image", url: "https://cdn.luma.test/l0.png", layer: { index: 0, label: "figure" } },
          { type: "image", url: "https://cdn.luma.test/l1.png", layer: { index: 1, label: "props" } },
          { type: "image", url: "https://cdn.luma.test/l2.png", layer: { index: 2, label: "background" } },
        ],
      },
    }));
    const out = await runLuma(makeInput({ modelId: "uni-1/layering" }));

    expect(out.success).toBe(true);
    expect(out.outputs).toHaveLength(3);
  });

  it("marks video types as video output", async () => {
    vi.stubGlobal("fetch", mockFetch({
      poll: { id: "gen-1", state: "completed", output: [{ type: "video", url: "https://cdn.luma.test/out.mp4" }] },
    }));
    const out = await runLuma(makeInput({ modelId: "ray-3.2/video" }));

    expect(out.outputs![0].type).toBe("video");
  });

  it("surfaces a failed generation's reason", async () => {
    vi.stubGlobal("fetch", mockFetch({
      poll: {
        id: "gen-1",
        state: "failed",
        failure_code: "content_moderated",
        failure_reason: "The prompt was rejected by content moderation",
      },
    }));
    const out = await runLuma(makeInput());

    expect(out.success).toBe(false);
    expect(out.error).toContain("content moderation");
  });

  it("renders a string-form validation error", async () => {
    // Custom checks return detail as a plain string.
    vi.stubGlobal("fetch", mockFetch({ submitFail: [400, { detail: "Unknown model: zzz" }] }));
    const out = await runLuma(makeInput({ modelId: "zzz/image" }));

    expect(out.success).toBe(false);
    expect(out.error).toContain("Unknown model: zzz");
  });

  it("renders a list-form validation error with its field path", async () => {
    // FastAPI enum failures return detail as a list — the shape that would
    // otherwise print as [object Object].
    vi.stubGlobal("fetch", mockFetch({
      submitFail: [
        422,
        { detail: [{ type: "enum", loc: ["body", "video", "resolution"], msg: "Input should be '720p'" }] },
      ],
    }));
    const out = await runLuma(makeInput({ modelId: "ray-3.2/video" }));

    expect(out.success).toBe(false);
    expect(out.error).toContain("video.resolution");
    expect(out.error).toContain("Input should be '720p'");
    expect(out.error).not.toContain("[object Object]");
  });

  it("reports an empty output list rather than claiming success", async () => {
    vi.stubGlobal("fetch", mockFetch({ poll: { id: "gen-1", state: "completed", output: [] } }));
    const out = await runLuma(makeInput());

    expect(out.success).toBe(false);
    expect(out.error).toContain("No outputs");
  });
});
