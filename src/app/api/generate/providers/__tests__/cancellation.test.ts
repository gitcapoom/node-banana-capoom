/**
 * Cancel in the canvas must reach the provider.
 *
 * The real failure: Cancel aborted the browser's fetch, but /api/generate
 * never listened, so the poll loop ran on until the job finished and the job
 * was billed in full. Each case aborts mid-poll and checks the loop stops —
 * and, where the provider has a cancel endpoint, that it was called.
 *
 * No real generation is performed — everything is a mocked fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateWithReplicate } from "../replicate";
import { generateWithFalQueue, clearFalInputMappingCache } from "../fal";
import { pollKieTaskCompletion } from "../kie";
import { waitUnlessCancelled } from "../../utils/cancellation";
import type { GenerationInput } from "@/lib/providers/types";

const urlOf = (u: string | URL | Request) =>
  typeof u === "string" ? u : u instanceof URL ? u.toString() : u.url;

function makeInput(provider: "replicate" | "fal", id: string, signal: AbortSignal): GenerationInput {
  return {
    model: { id, name: "Test Model", description: null, provider, capabilities: ["text-to-video"] },
    prompt: "a cat",
    images: [],
    parameters: {},
    signal,
  };
}

/** Records every call; `poll` decides the in-progress answer and aborts after `abortAfter` polls. */
function recorder() {
  const calls: Array<{ url: string; method: string }> = [];
  return {
    calls,
    record(url: string, init?: RequestInit) {
      calls.push({ url, method: init?.method ?? "GET" });
    },
    count: (pred: (c: { url: string; method: string }) => boolean) => calls.filter(pred).length,
  };
}

describe("waitUnlessCancelled", () => {
  it("resolves false after the delay when not aborted", async () => {
    expect(await waitUnlessCancelled(1, new AbortController().signal)).toBe(false);
  });

  it("wakes at once when the signal aborts mid-wait", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = waitUnlessCancelled(60_000, ac.signal);
    ac.abort();
    expect(await p).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("returns true immediately for an already-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await waitUnlessCancelled(60_000, ac.signal)).toBe(true);
  });
});

describe("provider cancel", () => {
  const originalFetch = global.fetch;
  beforeEach(() => clearFalInputMappingCache());
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("Replicate: stops polling and cancels the prediction", async () => {
    const ac = new AbortController();
    const rec = recorder();
    global.fetch = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(u);
      rec.record(url, init);
      if (url.includes("/models/owner/vid") && !url.includes("/predictions")) {
        return new Response(JSON.stringify({ latest_version: { id: "v1", openapi_schema: {} } }), { status: 200 });
      }
      if (url.endsWith("/cancel")) return new Response("{}", { status: 200 });
      if (url.includes("/predictions") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "pred-1", status: "starting" }), { status: 201 });
      }
      if (url.includes("/predictions/pred-1")) {
        ac.abort(); // the user hits Cancel while the job is running
        return new Response(JSON.stringify({ id: "pred-1", status: "processing" }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    const result = await generateWithReplicate("req", "key", makeInput("replicate", "owner/vid", ac.signal));

    expect(result).toMatchObject({ success: false, error: "Cancelled" });
    expect(rec.count((c) => c.method === "POST" && c.url.endsWith("/predictions/pred-1/cancel"))).toBe(1);
    expect(rec.count((c) => c.method === "GET" && c.url.endsWith("/predictions/pred-1"))).toBe(1);
  });

  it("fal: stops polling and cancels the queue request", async () => {
    const ac = new AbortController();
    const rec = recorder();
    global.fetch = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(u);
      rec.record(url, init);
      if (url.includes("api.fal.ai/v1/models")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
      if (url.endsWith("/cancel")) return new Response("{}", { status: 202 });
      if (url.includes("queue.fal.run/fal-ai/vid") && init?.method === "POST") {
        return new Response(JSON.stringify({
          request_id: "r-1",
          status_url: "https://queue.fal.run/fal-ai/vid/requests/r-1/status",
          response_url: "https://queue.fal.run/fal-ai/vid/requests/r-1",
        }), { status: 200 });
      }
      if (url.endsWith("/requests/r-1/status")) {
        ac.abort();
        return new Response(JSON.stringify({ status: "IN_PROGRESS" }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    const result = await generateWithFalQueue("req", "key", makeInput("fal", "fal-ai/vid", ac.signal));

    expect(result).toMatchObject({ success: false, error: "Cancelled" });
    expect(rec.count((c) => c.method === "PUT" && c.url === "https://queue.fal.run/fal-ai/vid/requests/r-1/cancel")).toBe(1);
    expect(rec.count((c) => c.url.endsWith("/status"))).toBe(1);
  });

  it("Kie (no cancel API): stops polling without calling anything else", async () => {
    const ac = new AbortController();
    const rec = recorder();
    global.fetch = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
      rec.record(urlOf(u), init);
      ac.abort();
      return new Response(JSON.stringify({ code: 200, data: { state: "generating" } }), { status: 200 });
    }) as typeof fetch;

    const result = await pollKieTaskCompletion("req", "key", "task-1", ac.signal);

    expect(result).toMatchObject({ success: false, error: "Cancelled" });
    expect(rec.calls).toHaveLength(1);
  });
});
