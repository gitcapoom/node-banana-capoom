/**
 * Server-side resolution of `nbfile:` references.
 *
 * The id arrives from the browser, so it is hostile input that gets turned into
 * a filesystem path. These cover both halves: that a legitimate reference is
 * found and uploaded once, and that a crafted one cannot escape the project.
 *
 * Uses REAL files in a temp directory rather than a mocked fs — the logic under
 * test is precisely "which path does this id produce, and is it inside the
 * project", so stubbing the filesystem would mostly test the stub.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const mockUpload = vi.fn();
vi.mock("../../providers/fal", () => ({
  uploadFileToFal: (...args: unknown[]) => mockUpload(...args),
}));

// The real validator only accepts an allow-list of roots, which a temp dir is
// not. Path SAFETY is still exercised below, via the id checks.
vi.mock("@/utils/pathValidation", () => ({
  validateWorkflowPath: (p: string) =>
    p.includes("..")
      ? { valid: false, resolved: "", error: "traversal" }
      : { valid: true, resolved: path.resolve(p) },
}));

import { resolveMediaRefs, hasMediaRefs, findMediaFile } from "../resolveMediaRefs";

let DIR = "";

beforeEach(async () => {
  vi.clearAllMocks();
  mockUpload.mockResolvedValue("https://cdn.fal.ai/uploaded.mov");
  if (!DIR) {
    DIR = await fs.mkdtemp(path.join(os.tmpdir(), "nb-mediaref-"));
    await fs.mkdir(path.join(DIR, "inputs"), { recursive: true });
    await fs.writeFile(path.join(DIR, "inputs", "img-abc.mov"), "fake movie bytes");
  }
});

afterAll(async () => {
  if (DIR) await fs.rm(DIR, { recursive: true, force: true });
});

describe("hasMediaRefs", () => {
  it("finds a reference nested in dynamicInputs", () => {
    expect(hasMediaRefs({ video_urls: ["nbfile:img-abc"] })).toBe(true);
  });

  it("is false for ordinary payloads", () => {
    expect(hasMediaRefs({ prompt: "hello", images: ["data:image/png;base64,AA"] })).toBe(false);
  });
});

describe("findMediaFile", () => {
  it("locates a saved clip by id", async () => {
    const found = await findMediaFile(DIR, "img-abc");
    expect(found?.filePath.endsWith("img-abc.mov")).toBe(true);
    expect(found?.contentType).toBe("video/quicktime");
  });

  it("returns null for an id with no file", async () => {
    expect(await findMediaFile(DIR, "img-missing")).toBeNull();
  });

  it("refuses an id that contains a path", async () => {
    // An id is a FILENAME. Anything path-shaped is an escape attempt, and is
    // rejected rather than normalised — normalising invites the next bypass.
    expect(await findMediaFile(DIR, "../../../etc/passwd")).toBeNull();
    expect(await findMediaFile(DIR, "sub/dir/img-abc")).toBeNull();
    expect(await findMediaFile(DIR, "..\\..\\secrets")).toBeNull();
  });

  it("refuses a project directory that fails validation", async () => {
    expect(await findMediaFile(`${DIR}/../../windows`, "img-abc")).toBeNull();
  });
});

describe("resolveMediaRefs", () => {
  it("swaps a reference for the uploaded URL", async () => {
    const out = await resolveMediaRefs({ video_urls: ["nbfile:img-abc"] }, DIR, "key");
    expect(out).toEqual({ video_urls: ["https://cdn.fal.ai/uploaded.mov"] });
    expect(mockUpload).toHaveBeenCalledTimes(1);
    // Uploaded straight from disk, with a content type the provider can use.
    expect(String(mockUpload.mock.calls[0][0]).endsWith("img-abc.mov")).toBe(true);
    expect(mockUpload.mock.calls[0][1]).toBe("video/quicktime");
  });

  it("uploads one clip once even when wired to several pins", async () => {
    const out = (await resolveMediaRefs(
      { video_urls: ["nbfile:img-abc"], reference_video_urls: ["nbfile:img-abc"] },
      DIR,
      "key",
    )) as Record<string, string[]>;
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(out.reference_video_urls[0]).toBe("https://cdn.fal.ai/uploaded.mov");
  });

  it("leaves ordinary values alone and uploads nothing", async () => {
    const payload = { prompt: "x", images: ["data:image/png;base64,AA"] };
    expect(await resolveMediaRefs(payload, DIR, "key")).toEqual(payload);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("explains a reference whose file is gone", async () => {
    await expect(
      resolveMediaRefs({ video_urls: ["nbfile:img-missing"] }, DIR, "key"),
    ).rejects.toThrow(/img-missing/);
  });

  it("explains a reference sent without a project directory", async () => {
    await expect(
      resolveMediaRefs({ video_urls: ["nbfile:img-abc"] }, null, "key"),
    ).rejects.toThrow(/project directory/i);
  });
});
