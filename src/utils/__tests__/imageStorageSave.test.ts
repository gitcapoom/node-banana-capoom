import { describe, it, expect, vi, beforeEach } from "vitest";

// Thumbnail generation needs a real canvas; jsdom has none. The production code
// tolerates a throw here, but mocking keeps the assertions about fetch traffic
// clean — otherwise every case also logs a caught canvas error.
vi.mock("../createImageThumbnail", () => ({
  createImageThumbnail: vi.fn(async () => "data:image/jpeg;base64,dGh1bWI="),
  createImageThumbnailWithMeta: vi.fn(async () => ({
    thumb: "data:image/jpeg;base64,dGh1bWI=",
    width: 64,
    height: 64,
  })),
  thumbMaxDim: () => 64,
}));

import { externalizeWorkflowImages } from "../imageStorage";
import type { WorkflowFile } from "@/store/workflowStore";

const PAYLOAD = "x".repeat(4096);
const B64 = Buffer.from(PAYLOAD).toString("base64");
const DATA_URL = `data:image/png;base64,${B64}`;
const EXPECTED_BYTES = PAYLOAD.length;

function workflowWithLooseImage(): WorkflowFile {
  return {
    nodes: [
      {
        id: "n1",
        type: "imageInput",
        position: { x: 0, y: 0 },
        // No imageRef: this is the state a node lands in after it recomputes,
        // and the one that made saves slow.
        data: { image: DATA_URL },
      },
    ],
    edges: [],
  } as unknown as WorkflowFile;
}

/** Installs a fetch stub; returns the POST bodies it received. */
function stubFetch(check: { exists: boolean; size: number }) {
  const posts: Array<Record<string, unknown>> = [];
  const checks: string[] = [];
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if ((init?.method ?? "GET").toUpperCase() === "POST") {
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    checks.push(u);
    return new Response(JSON.stringify({ success: true, ...check }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { posts, checks };
}

describe("externalizeWorkflowImages — redundant upload skipping", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("skips the upload when the content-addressed file is already on disk at the right size", async () => {
    const { posts, checks } = stubFetch({ exists: true, size: EXPECTED_BYTES });

    const out = await externalizeWorkflowImages(workflowWithLooseImage(), "/proj");

    expect(posts).toHaveLength(0);
    expect(checks.length).toBeGreaterThan(0);

    // Skipping must still produce the ref and drop the inline data — a skip that
    // forgot to do this would silently lose the image on the next open.
    const d = out.nodes[0].data as Record<string, unknown>;
    expect(d.imageRef).toMatch(/^img-[0-9a-f]{32}$/);
    expect(d.image).toBeNull();
  });

  it("uploads when the file on disk is the wrong size (interrupted earlier save)", async () => {
    const { posts } = stubFetch({ exists: true, size: EXPECTED_BYTES - 1 });

    await externalizeWorkflowImages(workflowWithLooseImage(), "/proj");

    expect(posts).toHaveLength(1);
    expect(posts[0].imageData).toBe(DATA_URL);
  });

  it("uploads when the file is absent", async () => {
    const { posts } = stubFetch({ exists: false, size: -1 });

    await externalizeWorkflowImages(workflowWithLooseImage(), "/proj");

    expect(posts).toHaveLength(1);
  });

  it("uploads when the existence check gives no size (older server)", async () => {
    const { posts } = stubFetch({ exists: true, size: undefined as unknown as number });

    await externalizeWorkflowImages(workflowWithLooseImage(), "/proj");

    expect(posts).toHaveLength(1);
  });

  it("names the file by content, so identical bytes reuse one ref", async () => {
    stubFetch({ exists: true, size: EXPECTED_BYTES });

    const a = await externalizeWorkflowImages(workflowWithLooseImage(), "/proj");
    const b = await externalizeWorkflowImages(workflowWithLooseImage(), "/proj");

    const refA = (a.nodes[0].data as Record<string, unknown>).imageRef;
    const refB = (b.nodes[0].data as Record<string, unknown>).imageRef;
    expect(refA).toBe(refB);
  });
});
