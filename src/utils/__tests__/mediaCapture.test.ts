/**
 * The frame grab worked "sometimes". Four races, all presenting as a missing or
 * black frame. These pin each one, because none of them is reproducible by
 * reading the code — they depend on whether a clip happened to be buffered.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveSeekTarget,
  seekVideoTo,
  videoCanBeDrawn,
  ensureVideoReady,
} from "../mediaCapture";

/**
 * Minimal stand-in for HTMLVideoElement. jsdom decodes nothing, so the parts
 * under test are the event plumbing and the seek decisions — which is exactly
 * where the bugs were.
 */
class FakeVideo extends EventTarget {
  videoWidth = 640;
  videoHeight = 360;
  readyState = 2; // HAVE_CURRENT_DATA
  duration = 10;
  seekCount = 0;
  private _currentTime = 0;

  /** Fire `seeked` asynchronously, like a real element. */
  seekDelayMs = 0;
  /** Dispatch `seeked` SYNCHRONOUSLY inside the setter — what an
   *  already-buffered clip effectively does. A listener attached after the
   *  write misses it entirely. */
  syncSeek = false;
  /** A browser fires nothing when the value does not actually change. */
  get currentTime() {
    return this._currentTime;
  }
  set currentTime(v: number) {
    if (!Number.isFinite(v)) return; // real elements ignore NaN, silently
    if (v === this._currentTime) return; // no-op seek: NO event
    this._currentTime = v;
    this.seekCount++;
    if (this.syncSeek) {
      this.dispatchEvent(new Event("seeked"));
      return;
    }
    setTimeout(() => this.dispatchEvent(new Event("seeked")), this.seekDelayMs);
  }
}

function asVideo(f: FakeVideo): HTMLVideoElement {
  return f as unknown as HTMLVideoElement;
}

beforeEach(() => {
  vi.useFakeTimers();
  // waitForPaintedFrame falls back to rAF; keep it synchronous-ish.
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    setTimeout(cb, 0);
    return 0;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("resolveSeekTarget", () => {
  it("keeps a normal time", () => {
    expect(resolveSeekTarget(3, 10)).toBe(3);
  });

  it("survives a NaN duration", () => {
    // Some blob sources report NaN until fully buffered. `duration - 0.1` was
    // then NaN, and `currentTime = NaN` is a silent no-op that fires nothing —
    // the extraction sat until its 30s timeout.
    expect(Number.isFinite(resolveSeekTarget(5, NaN))).toBe(true);
    expect(resolveSeekTarget(5, NaN)).toBe(5);
  });

  it("survives an Infinite duration (streamed sources)", () => {
    expect(resolveSeekTarget(2, Infinity)).toBe(2);
  });

  it("never lands exactly on the end", () => {
    // Browsers clamp a seek to duration back inside, and may fire nothing.
    expect(resolveSeekTarget(10, 10)).toBeLessThan(10);
  });

  it("floors a negative or NaN request at 0", () => {
    expect(resolveSeekTarget(-4, 10)).toBe(0);
    expect(resolveSeekTarget(NaN, 10)).toBe(0);
  });
});

describe("seekVideoTo", () => {
  it("returns when the video is ALREADY at the target", async () => {
    // The bug: thumbnailing asks for t=0 first and a freshly loaded video sits
    // at 0, so writing currentTime fired no `seeked` and the promise hung.
    const v = new FakeVideo();
    expect(v.currentTime).toBe(0);
    let settled = false;
    void seekVideoTo(asVideo(v), 0).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(v.seekCount).toBe(0); // nothing to seek
  });

  it("actually seeks when the target differs", async () => {
    const v = new FakeVideo();
    let settled = false;
    void seekVideoTo(asVideo(v), 4).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(v.seekCount).toBe(1);
    expect(v.currentTime).toBe(4);
  });

  it("catches a seek that completes immediately", async () => {
    // The listener must be attached BEFORE currentTime is written. Subscribing
    // afterwards loses the event for an already-buffered clip — which is how
    // VideoStitchNode fell through to "Seek timeout" at random.
    const v = new FakeVideo();
    v.syncSeek = true; // completes inside the currentTime write
    let settled = false;
    void seekVideoTo(asVideo(v), 7).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it("gives up rather than hanging when no event ever arrives", async () => {
    const v = new FakeVideo();
    // Simulate an element that accepts the seek but never reports it.
    Object.defineProperty(v, "currentTime", {
      get: () => 0,
      set: () => { /* swallowed, no event */ },
    });
    let settled = false;
    void seekVideoTo(asVideo(v), 5, 1000).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1001);
    expect(settled).toBe(true);
  });
});

describe("videoCanBeDrawn", () => {
  it("rejects a video with no decoded frame", () => {
    const v = new FakeVideo();
    v.readyState = 0;
    expect(videoCanBeDrawn(asVideo(v))).toBe(false);
  });

  it("rejects zero dimensions", () => {
    // Before metadata, videoWidth/Height are 0 — the overlay built a 0x0
    // canvas whose toDataURL is a valid-looking blank, so the grab reported
    // success and produced nothing.
    const v = new FakeVideo();
    v.videoWidth = 0;
    expect(videoCanBeDrawn(asVideo(v))).toBe(false);
  });

  it("accepts a loaded, sized video", () => {
    expect(videoCanBeDrawn(asVideo(new FakeVideo()))).toBe(true);
  });
});

describe("ensureVideoReady", () => {
  it("returns immediately when a frame already exists", async () => {
    const p = ensureVideoReady(asVideo(new FakeVideo()));
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe(true);
  });

  it("waits for loadeddata, then reports drawable", async () => {
    const v = new FakeVideo();
    v.readyState = 0;
    const p = ensureVideoReady(asVideo(v), 5000);
    v.readyState = 2;
    v.dispatchEvent(new Event("loadeddata"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe(true);
  });

  it("reports false instead of hanging when the video never loads", async () => {
    const v = new FakeVideo();
    v.readyState = 0;
    const p = ensureVideoReady(asVideo(v), 500);
    await vi.advanceTimersByTimeAsync(501);
    await expect(p).resolves.toBe(false);
  });
});
