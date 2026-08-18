import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import * as path from "path";

const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();
const mockMkdir = vi.fn();
const mockRename = vi.fn();
const mockCopyFile = vi.fn();
const mockUnlink = vi.fn();

vi.mock("fs/promises", () => ({
  readdir: (...a: unknown[]) => mockReaddir(...a),
  readFile: (...a: unknown[]) => mockReadFile(...a),
  stat: (...a: unknown[]) => mockStat(...a),
  mkdir: (...a: unknown[]) => mockMkdir(...a),
  rename: (...a: unknown[]) => mockRename(...a),
  copyFile: (...a: unknown[]) => mockCopyFile(...a),
  unlink: (...a: unknown[]) => mockUnlink(...a),
}));

vi.mock("@/utils/pathValidation", () => ({
  validateWorkflowPath: () => ({ valid: true }),
}));

vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { GET, POST } = await import("../route");

const DIR = path.join("C:", "proj", "AI_Gen");
const file = (name: string) => ({ name, isFile: () => true, isDirectory: () => false });

/**
 * `live` is the current manifest, `bak` the rolling backup. The whole point of the
 * .bak case is that a ref present ONLY there must still count as referenced.
 */
function wire({ live, bak, inputs, generations }: {
  live: string; bak?: string; inputs: string[]; generations?: string[];
}) {
  mockReaddir.mockImplementation((p: string) => {
    if (p === DIR) {
      const m = [file("AI_Gen.json")];
      if (bak !== undefined) m.push(file("AI_Gen.json.bak"));
      return Promise.resolve(m);
    }
    if (p === path.join(DIR, "inputs")) return Promise.resolve(inputs.map(file));
    if (p === path.join(DIR, "generations")) return Promise.resolve((generations ?? []).map(file));
    return Promise.reject(new Error("ENOENT"));
  });
  mockReadFile.mockImplementation((p: string) =>
    Promise.resolve(String(p).endsWith(".bak") ? (bak ?? "") : live),
  );
  mockStat.mockResolvedValue({ size: 1000 });
  mockMkdir.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
}

const getReq = () =>
  new NextRequest(`http://localhost/api/workflow-media-gc?workflowPath=${encodeURIComponent(DIR)}`);
const postReq = () =>
  new NextRequest("http://localhost/api/workflow-media-gc", {
    method: "POST",
    body: JSON.stringify({ workflowPath: DIR }),
    headers: { "Content-Type": "application/json" },
  });

describe("/api/workflow-media-gc", () => {
  beforeEach(() => vi.clearAllMocks());

  it("classifies a file referenced by the live manifest as referenced", async () => {
    wire({ live: '{"imageRef":"img-aaa"}', inputs: ["img-aaa.png"] });
    const data = await (await GET(getReq())).json();
    expect(data.orphans).toHaveLength(0);
    expect(data.referencedCount).toBe(1);
  });

  it("counts a ref that exists ONLY in the .bak as referenced", async () => {
    // The load-bearing case: collecting against the live file alone would move the
    // one image the rolling backup still needs.
    wire({ live: '{"nodes":[]}', bak: '{"imageRef":"img-only-in-bak"}', inputs: ["img-only-in-bak.png"] });
    const data = await (await GET(getReq())).json();
    expect(data.scannedManifests).toContain("AI_Gen.json.bak");
    expect(data.orphans).toHaveLength(0);
  });

  it("reports a file referenced by neither manifest as an orphan", async () => {
    wire({ live: '{"imageRef":"img-keep"}', bak: '{"imageRef":"img-keep"}', inputs: ["img-keep.png", "img-dead.png"] });
    const data = await (await GET(getReq())).json();
    expect(data.orphans.map((o: { file: string }) => o.file)).toEqual(["img-dead.png"]);
    expect(data.orphanBytes).toBe(1000);
  });

  it("matches on stem, so the ref need not carry the extension", async () => {
    wire({ live: '{"outputImageRef":"generation_abc"}', inputs: [], generations: ["generation_abc.png"] });
    const data = await (await GET(getReq())).json();
    expect(data.orphans).toHaveLength(0);
  });

  it("GET moves nothing", async () => {
    wire({ live: "{}", inputs: ["img-dead.png"] });
    await GET(getReq());
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it("POST moves orphans into _trash and leaves referenced files alone", async () => {
    wire({ live: '{"imageRef":"img-keep"}', inputs: ["img-keep.png", "img-dead.png"] });
    const data = await (await POST(postReq())).json();
    expect(data.moved).toBe(1);
    expect(mockRename).toHaveBeenCalledTimes(1);
    const [from, to] = mockRename.mock.calls[0];
    expect(String(from)).toContain("img-dead.png");
    expect(String(to)).toContain("_trash");
    expect(String(to)).toContain("img-dead.png");
  });

  it("never unlinks when the rename succeeds", async () => {
    wire({ live: "{}", inputs: ["img-dead.png"] });
    await POST(postReq());
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it("is idempotent — a second run finds nothing left to move", async () => {
    wire({ live: '{"imageRef":"img-keep"}', inputs: ["img-keep.png"] });
    const data = await (await POST(postReq())).json();
    expect(data.moved).toBe(0);
    expect(mockRename).not.toHaveBeenCalled();
  });

  it("refuses to scan when a manifest is unreadable, rather than over-collecting", async () => {
    wire({ live: '{"imageRef":"img-keep"}', bak: "x", inputs: ["img-keep.png"] });
    mockReadFile.mockRejectedValueOnce(new Error("EBUSY"));
    const res = await GET(getReq());
    expect(res.status).toBe(500);
    expect(mockRename).not.toHaveBeenCalled();
  });
});
