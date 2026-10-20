/**
 * Compressing images that were sent by reference, for a size retry.
 *
 * Media over the browser's inline threshold reaches the server as a reference
 * to a file on disk and is uploaded to the CDN before any provider is called.
 * If the provider then refuses it as too large, the request holds only a URL —
 * the inline-compression retry had nothing to work on, so the job just failed.
 * These cover going back to the file, compressing it, and swapping the URL.
 *
 * Uses a REAL image (generated with sharp) so the compression step is the real
 * one, not a stub that always "succeeds".
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { randomBytes } from "node:crypto";

const mockImageUpload = vi.fn();
vi.mock("../../providers/fal", () => ({
  uploadFileToFal: vi.fn(),
  uploadImageToFal: (...args: unknown[]) => mockImageUpload(...args),
}));

import { recompressRefImages, hasRefImages, type RefOrigins } from "../resolveMediaRefs";

let DIR = "";
let PNG = "";
const BIG_URL = "https://v3b.fal.media/files/big.png";
const VIDEO_URL = "https://v3b.fal.media/files/clip.mp4";

beforeEach(async () => {
  vi.clearAllMocks();
  mockImageUpload.mockResolvedValue("https://v3b.fal.media/files/smaller.jpg");
  if (!DIR) {
    DIR = await fs.mkdtemp(path.join(os.tmpdir(), "nb-recompress-"));
    PNG = path.join(DIR, "big.png");
    // Noise does not compress, so the PNG is genuinely large.
    const w = 1600, h = 1200;
    const raw = randomBytes(w * h * 3);
    await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toFile(PNG);
  }
});

afterAll(async () => {
  if (DIR) await fs.rm(DIR, { recursive: true, force: true });
});

const origins = (): RefOrigins =>
  new Map([
    [BIG_URL, { filePath: PNG, contentType: "image/png" }],
    [VIDEO_URL, { filePath: path.join(DIR, "clip.mp4"), contentType: "video/mp4" }],
  ]);

describe("hasRefImages", () => {
  it("finds an image that came from disk, wherever it sits in the payload", () => {
    expect(hasRefImages({ image_urls: ["x", BIG_URL] }, origins())).toBe(true);
    expect(hasRefImages([BIG_URL], origins())).toBe(true);
  });

  it("ignores a ref'd video — compressing it as an image would destroy it", () => {
    expect(hasRefImages({ video_url: VIDEO_URL }, origins())).toBe(false);
  });

  it("is false with no origins at all", () => {
    expect(hasRefImages([BIG_URL], new Map())).toBe(false);
  });
});

describe("recompressRefImages", () => {
  it("compresses the file on disk and swaps in the re-uploaded URL", async () => {
    const out = await recompressRefImages({ image_urls: [BIG_URL], prompt: "p" }, origins(), "key");

    expect(out).toEqual({ image_urls: ["https://v3b.fal.media/files/smaller.jpg"], prompt: "p" });
    expect(mockImageUpload).toHaveBeenCalledTimes(1);
    // What was uploaded is the COMPRESSED image, read from the file — a JPEG
    // data URL smaller than the original PNG on disk.
    const sent = mockImageUpload.mock.calls[0][0] as string;
    expect(sent.startsWith("data:image/jpeg;base64,")).toBe(true);
    const original = (await fs.stat(PNG)).size;
    expect(Buffer.from(sent.split(",")[1], "base64").length).toBeLessThan(original);
  });

  it("leaves videos and ordinary URLs alone", async () => {
    const payload = { video_url: VIDEO_URL, other: "https://elsewhere.example/x.png" };
    expect(await recompressRefImages(payload, origins(), "key")).toEqual(payload);
    expect(mockImageUpload).not.toHaveBeenCalled();
  });

  it("compresses one file once even when it is wired to several pins", async () => {
    const memo = new Map<string, string>();
    await recompressRefImages({ a: BIG_URL }, origins(), "key", memo);
    await recompressRefImages([BIG_URL], origins(), "key", memo);
    expect(mockImageUpload).toHaveBeenCalledTimes(1);
  });
});
