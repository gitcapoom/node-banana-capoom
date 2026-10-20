/**
 * Uploading media to the fal CDN.
 *
 * This used to refuse any data URL over 20 MB. fal's CDN takes one signed PUT
 * up to 100 MiB — measured live: 100 MB succeeded, 101 MB returned
 * `413 File too large, use multipart solution` — and takes larger files as a
 * multipart upload. The uploader now follows fal's own client: a single PUT up
 * to 90 MiB, 10 MiB parts above it, then a POST of the ordered etags to
 * `{upload_url}/complete`. Verified live with a 200 MiB file before these tests
 * were written; these pin the request shape offline.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { uploadBytesToFal, uploadImageToFal, FAL_MULTIPART_THRESHOLD, FAL_MULTIPART_CHUNK_SIZE } from "../fal";

const UPLOAD = "https://v3b.fal.media/upload/abc?sig=xyz";
const FILE = "https://v3b.fal.media/files/abc/out.mp4";

type Call = { url: string; method: string; bytes: number; body?: string };

function mockCdn(opts: { omitEtag?: boolean } = {}) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body;
    // ArrayBuffer.isView, not instanceof Uint8Array: the Buffer comes from Node's
    // realm and the test environment's Uint8Array is a different constructor.
    const bytes = ArrayBuffer.isView(body) ? body.byteLength : typeof body === "string" ? body.length : 0;
    calls.push({ url: u, method: init?.method ?? "GET", bytes, body: typeof body === "string" ? body : undefined });

    if (u.includes("/storage/upload/initiate")) {
      return new Response(JSON.stringify({ upload_url: UPLOAD, file_url: FILE }), { status: 200 });
    }
    if (u.includes("/complete")) return new Response("{}", { status: 200 });
    // part or single PUT
    const part = u.match(/\/upload\/abc\/(\d+)\?/)?.[1];
    if (part && !opts.omitEtag) {
      return new Response(JSON.stringify({ etag: `etag-${part}` }), { status: 200 });
    }
    return new Response(part ? "{}" : "", { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("uploadBytesToFal", () => {
  it("uses a single PUT at or below the multipart threshold", async () => {
    const calls = mockCdn();
    const url = await uploadBytesToFal(Buffer.alloc(FAL_MULTIPART_THRESHOLD), "video/mp4", "mp4", "key");

    expect(url).toBe(FILE);
    expect(calls[0].url).toContain("/storage/upload/initiate?");
    expect(calls[0].url).not.toContain("multipart");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(calls[1].bytes).toBe(FAL_MULTIPART_THRESHOLD);
  });

  it("switches to multipart above the threshold", async () => {
    // 200 MiB: the size that was refused, and the one confirmed against fal live.
    const size = 200 * 1024 * 1024;
    const calls = mockCdn();
    const url = await uploadBytesToFal(Buffer.alloc(size), "video/mp4", "mp4", "key");

    expect(url).toBe(FILE);
    expect(calls[0].url).toContain("/storage/upload/initiate-multipart?");

    const parts = calls.filter((c) => c.method === "PUT");
    expect(parts).toHaveLength(Math.ceil(size / FAL_MULTIPART_CHUNK_SIZE));
    // Part n goes to {upload_url}/{n}, keeping the signed query string.
    expect(parts[0].url).toBe("https://v3b.fal.media/upload/abc/1?sig=xyz");
    expect(parts[parts.length - 1].url).toBe(`https://v3b.fal.media/upload/abc/${parts.length}?sig=xyz`);
    // Every byte is sent exactly once.
    expect(parts.reduce((n, p) => n + p.bytes, 0)).toBe(size);
  });

  it("completes with the ordered part etags", async () => {
    const calls = mockCdn();
    await uploadBytesToFal(Buffer.alloc(FAL_MULTIPART_THRESHOLD + 25 * 1024 * 1024), "video/mp4", "mp4", "key");

    const complete = calls.find((c) => c.url.includes("/complete"))!;
    expect(complete.url).toBe("https://v3b.fal.media/upload/abc/complete?sig=xyz");
    const { parts } = JSON.parse(complete.body!);
    expect(parts.map((p: { partNumber: number }) => p.partNumber)).toEqual(
      Array.from({ length: parts.length }, (_, i) => i + 1)
    );
    expect(parts[0].etag).toBe("etag-1");
  });

  it("fails loudly when a part comes back without an etag", async () => {
    // Completing without one would leave fal assembling a file with a hole in it.
    mockCdn({ omitEtag: true });
    await expect(
      uploadBytesToFal(Buffer.alloc(FAL_MULTIPART_THRESHOLD + 1), "video/mp4", "mp4", "key")
    ).rejects.toThrow(/etag/);
  });
});

describe("uploadImageToFal", () => {
  it("no longer refuses a data URL over 20 MB", async () => {
    const calls = mockCdn();
    const dataUrl = "data:image/png;base64," + Buffer.alloc(30 * 1024 * 1024).toString("base64");
    const url = await uploadImageToFal(dataUrl, "key");

    expect(url).toBe(FILE);
    expect(calls.filter((c) => c.method === "PUT")[0].bytes).toBe(30 * 1024 * 1024);
  });

  it("passes a non-data URL through untouched", async () => {
    const calls = mockCdn();
    expect(await uploadImageToFal("https://a.example/x.png", "key")).toBe("https://a.example/x.png");
    expect(calls).toHaveLength(0);
  });
});
