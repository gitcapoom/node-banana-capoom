/**
 * A large video wired to a muapi seedance model crashed the UI outright.
 *
 * The clip travels in `dynamicInputs` as a base64 data URL, and
 * generateVideoExecutor builds the request with `JSON.stringify` in the
 * BROWSER. That allocates a second copy of the whole payload; past V8's maximum
 * string length it throws `RangeError: Invalid string length`, and before that
 * the renderer just runs out of memory — an uncatchable tab crash.
 *
 * The muapi RESPONSE path already refuses to inline anything over 20 MB for
 * exactly this reason. These pin the same rule on the REQUEST side.
 */

import { describe, it, expect } from "vitest";
import {
  approxDataUrlBytes,
  findOversizedInlineMedia,
  oversizedMediaMessage,
  INLINE_MEDIA_MAX_BYTES,
} from "../inlineMediaLimits";

/** A data URL whose DECODED size is about `bytes`. */
function dataUrlOfBytes(bytes: number, mime = "video/quicktime"): string {
  const b64Chars = Math.ceil(bytes / 3) * 4;
  return `data:${mime};base64,${"A".repeat(b64Chars)}`;
}

describe("approxDataUrlBytes", () => {
  it("recovers the decoded size from base64 length", () => {
    const url = dataUrlOfBytes(3 * 1024 * 1024);
    const mb = approxDataUrlBytes(url) / 1024 / 1024;
    expect(mb).toBeGreaterThan(2.9);
    expect(mb).toBeLessThan(3.1);
  });

  it("returns 0 for a plain http URL", () => {
    // Already hosted — nothing inline to blow up.
    expect(approxDataUrlBytes("https://cdn.example.com/clip.mp4")).toBe(0);
  });

  it("returns 0 for a blob: URL", () => {
    expect(approxDataUrlBytes("blob:http://localhost:3001/abc")).toBe(0);
  });

  it("returns 0 for a malformed data URL with no comma", () => {
    expect(approxDataUrlBytes("data:video/mp4;base64")).toBe(0);
  });
});

describe("findOversizedInlineMedia", () => {
  const small = dataUrlOfBytes(1 * 1024 * 1024);
  const huge = dataUrlOfBytes(200 * 1024 * 1024);

  it("passes a payload that fits", () => {
    expect(findOversizedInlineMedia({ images: [small], video_urls: [small] })).toBeNull();
  });

  it("catches an oversized clip inside an array field", () => {
    // seedance-v2.0-video-edit takes video_urls[]; -extend takes video_files[].
    const hit = findOversizedInlineMedia({ prompt: "x", video_urls: [huge] });
    expect(hit?.field).toBe("video_urls");
    expect(hit!.bytes).toBeGreaterThan(INLINE_MEDIA_MAX_BYTES);
  });

  it("catches an oversized scalar field", () => {
    const hit = findOversizedInlineMedia({ video_url: huge });
    expect(hit?.field).toBe("video_url");
  });

  it("ignores non-media values", () => {
    expect(
      findOversizedInlineMedia({ prompt: "a long prompt", duration: 5, enable: true }),
    ).toBeNull();
  });

  it("ignores a hosted URL however long the clip is", () => {
    // Nothing is inlined, so nothing is copied — size is the provider's problem.
    expect(
      findOversizedInlineMedia({ video_urls: ["https://cdn.example.com/2gb.mov"] }),
    ).toBeNull();
  });

  it("reports the FIRST offender when several are too large", () => {
    const hit = findOversizedInlineMedia({ video_urls: [huge], images: [huge] });
    expect(hit?.field).toBe("video_urls");
  });

  it("lets a value exactly at the limit through", () => {
    const atLimit = dataUrlOfBytes(INLINE_MEDIA_MAX_BYTES - 1024);
    expect(findOversizedInlineMedia({ video_urls: [atLimit] })).toBeNull();
  });
});

describe("oversizedMediaMessage", () => {
  it("names the field and both sizes", () => {
    const msg = oversizedMediaMessage({ field: "video_urls", bytes: 200 * 1024 * 1024 });
    expect(msg).toContain("video_urls");
    expect(msg).toContain("200 MB");
    expect(msg).toContain("20 MB");
  });
});
