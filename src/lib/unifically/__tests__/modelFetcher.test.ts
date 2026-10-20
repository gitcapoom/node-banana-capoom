/**
 * The live Unifically catalogue and the docs-backed schema index.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toProviderModel, getUnificallyModels, getUnificallySchemaIndex, clearUnificallyCaches } from "../modelFetcher";

beforeEach(() => clearUnificallyCaches());
afterEach(() => {
  vi.unstubAllGlobals();
  clearUnificallyCaches();
});

describe("toProviderModel", () => {
  it("maps generation categories to capabilities and drops LLMs", () => {
    expect(toProviderModel({ id: "google/veo-3.1-fast", display_name: "Veo 3.1 Fast", provider_display: "Google", category: "video" })!.capabilities)
      .toEqual(["text-to-video", "image-to-video"]);
    expect(toProviderModel({ id: "x/y", category: "image" })!.capabilities).toEqual(["text-to-image", "image-to-image"]);
    expect(toProviderModel({ id: "x/y", category: "audio" })!.capabilities).toEqual(["text-to-audio"]);
    expect(toProviderModel({ id: "moonshotai/kimi-k3", category: "llm" })).toBeNull();
  });

  it("names the provider only when the display name does not already", () => {
    expect(toProviderModel({ id: "a/b", display_name: "Eleven v4", provider_display: "ElevenLabs", category: "audio" })!.name)
      .toBe("Eleven v4 (ElevenLabs)");
    expect(toProviderModel({ id: "a/b", display_name: "ElevenLabs Sound Effect", provider_display: "ElevenLabs", category: "audio" })!.name)
      .toBe("ElevenLabs Sound Effect");
  });
});

describe("getUnificallyModels", () => {
  it("lists the live catalogue, filtered to generation categories", async () => {
    const f = vi.fn(async (_url: string) => new Response(JSON.stringify({
      object: "list",
      data: [
        { id: "google/veo-3.1-fast", display_name: "Veo 3.1 Fast", category: "video" },
        { id: "moonshotai/kimi-k3", display_name: "Kimi K3", category: "llm" },
      ],
    })));
    vi.stubGlobal("fetch", f);
    const models = await getUnificallyModels("key");
    expect(models.map((m) => m.id)).toEqual(["google/veo-3.1-fast"]);
    expect(String(f.mock.calls[0][0])).toContain("category=video,image,audio");
  });

  it("keeps the previous catalogue when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "a/b", category: "image" }] }))));
    await getUnificallyModels("key");
    // Force the cache stale, then fail.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    expect((await getUnificallyModels("key")).map((m) => m.id)).toEqual(["a/b"]);
    vi.useRealTimers();
  });
});

describe("getUnificallySchemaIndex", () => {
  const DOC = `# Veo
Source: https://docs.unifically.com/models/video/google/veo-3.1

## Parameters

| Parameter | Type | Required | Description |
| - | - | - | - |
| \`prompt\` | string | Yes | Prompt |

\`\`\`bash
curl -d '{ "model": "google/veo-3.1-fast" }'
\`\`\`
`;

  it("indexes the docs when they arrive as plain text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(DOC, { headers: { "content-type": "text/plain; charset=utf-8" } })));
    const index = await getUnificallySchemaIndex();
    expect(index?.has("google/veo-3.1-fast")).toBe(true);
  });

  it("refuses an HTML page dressed as the docs", async () => {
    // Parses to zero models, which would otherwise be indistinguishable from a
    // real empty answer.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>404</html>", { headers: { "content-type": "text/html" } })));
    expect(await getUnificallySchemaIndex()).toBeNull();
  });
});
