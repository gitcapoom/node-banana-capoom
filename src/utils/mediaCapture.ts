/**
 * Shared media capture utilities.
 * Used by VideoInputNode, GenerateVideoNode, and other nodes that need
 * to extract frames from video content.
 *
 * WHY THIS IS FIDDLY — the frame grab used to work "sometimes". Four distinct
 * races, all of which present identically as a missing or black frame:
 *
 *  1. A no-op seek fires no event. `video.currentTime = t` when the video is
 *     ALREADY at t does not seek, so `seeked` never arrives and a promise that
 *     waits for it hangs until its timeout. The first thumbnail frame is taken
 *     at 0 and a freshly loaded video sits at 0, so this hit the common path.
 *  2. Listening after seeking. Assigning `onseeked` AFTER setting currentTime
 *     loses the event when the seek completes immediately (already buffered).
 *  3. `seeked` does not mean painted. The seek is done, but the frame may not
 *     be composited yet, so drawing then yields black or the previous frame.
 *     `requestVideoFrameCallback` is the only reliable "there is a frame now".
 *  4. Drawing before metadata. `videoWidth`/`videoHeight` are 0 until metadata
 *     loads; a 0x0 canvas silently yields a blank data URL rather than an error.
 *
 * Everything here funnels through `grabVideoFrame` so a fix lands once.
 */

/** HTMLMediaElement.readyState — a frame exists for the current position. */
const HAVE_CURRENT_DATA = 2;

/** Seeks closer than this are treated as "already there" (no event will fire). */
const SEEK_EPSILON = 0.01;

/** Can this element be drawn at all right now? */
export function videoCanBeDrawn(video: HTMLVideoElement): boolean {
  return (
    video.readyState >= HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  );
}

/**
 * Clamp a requested time into something actually seekable.
 *
 * Duration is NaN before metadata and Infinity for some streamed/blob sources,
 * and `currentTime = NaN` is a silent no-op that fires no event — one of the
 * ways this hung. Returns 0 when nothing better can be determined.
 */
export function resolveSeekTarget(requested: number, duration: number): number {
  if (!Number.isFinite(requested) || requested < 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return requested;
  // Never land exactly on the end: browsers clamp it back and may not fire.
  return Math.min(requested, Math.max(0, duration - 0.05));
}

/** Resolve once `evt` fires, or after `ms`. Never rejects. */
function raceEvent(video: HTMLVideoElement, evt: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener(evt, finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    video.addEventListener(evt, finish);
  });
}

/** Wait until the element holds a decoded frame (or give up). */
export async function ensureVideoReady(video: HTMLVideoElement, timeoutMs = 10_000): Promise<boolean> {
  if (videoCanBeDrawn(video)) return true;
  await raceEvent(video, "loadeddata", timeoutMs);
  return videoCanBeDrawn(video);
}

/**
 * Seek, tolerating the case where no seek is needed.
 *
 * The listener goes on BEFORE currentTime is written — an already-buffered seek
 * can complete before the next statement runs.
 */
export async function seekVideoTo(video: HTMLVideoElement, time: number, timeoutMs = 10_000): Promise<void> {
  const target = resolveSeekTarget(time, video.duration);
  if (Math.abs(video.currentTime - target) < SEEK_EPSILON && videoCanBeDrawn(video)) {
    return; // already there — setting currentTime would fire nothing
  }
  const seeked = raceEvent(video, "seeked", timeoutMs);
  video.currentTime = target;
  await seeked;
}

interface VideoFrameCallbackCapable {
  requestVideoFrameCallback?: (cb: () => void) => number;
}

/**
 * Wait for a frame to actually be presented.
 *
 * `seeked` only says the seek finished. Chrome exposes
 * `requestVideoFrameCallback`, which fires when a frame is available to draw;
 * without it, two animation frames is the usual approximation.
 */
export function waitForPaintedFrame(video: HTMLVideoElement, timeoutMs = 2_000): Promise<void> {
  const rvfc = (video as HTMLVideoElement & VideoFrameCallbackCapable).requestVideoFrameCallback;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof rvfc === "function") {
      try {
        rvfc.call(video, finish);
        return;
      } catch {
        /* fall through to rAF */
      }
    }
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(finish));
    } else {
      finish();
    }
  });
}

export interface GrabFrameOptions {
  /** Seek here first. Omit to capture wherever the element already is. */
  time?: number;
  /** Longest wait for load/seek. */
  timeoutMs?: number;
}

/**
 * Draw the current (or sought) frame to a canvas. Returns null rather than a
 * blank image when the element never became drawable — a 0x0 canvas produces a
 * data URL that looks like success and is not.
 */
export async function grabVideoFrame(
  video: HTMLVideoElement,
  opts: GrabFrameOptions = {},
): Promise<HTMLCanvasElement | null> {
  const { time, timeoutMs = 10_000 } = opts;
  if (!(await ensureVideoReady(video, timeoutMs))) return null;
  if (typeof time === "number") await seekVideoTo(video, time, timeoutMs);
  await waitForPaintedFrame(video);
  if (!videoCanBeDrawn(video)) return null;

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch {
    return null; // tainted canvas (cross-origin source)
  }
  return canvas;
}

/** Convenience: a frame as a data URL, or null. */
export async function grabVideoFrameDataUrl(
  video: HTMLVideoElement,
  opts: GrabFrameOptions & { type?: string; quality?: number } = {},
): Promise<string | null> {
  const canvas = await grabVideoFrame(video, opts);
  if (!canvas) return null;
  try {
    return canvas.toDataURL(opts.type ?? "image/png", opts.quality);
  } catch {
    return null;
  }
}

/**
 * Seek a video element to a specific time and capture the frame as an ImageBitmap.
 * Returns null on failure.
 */
async function seekAndCapture(
  video: HTMLVideoElement,
  time: number
): Promise<ImageBitmap | null> {
  try {
    await seekVideoTo(video, time);
    await waitForPaintedFrame(video);
    if (!videoCanBeDrawn(video)) return null;
    return await createImageBitmap(video);
  } catch {
    return null;
  }
}

/**
 * Capture a 2×2 grid thumbnail from a video data URL.
 *
 * Layout:
 *   Top-left:     First frame (0%)
 *   Top-right:    Frame at 33% duration
 *   Bottom-left:  Frame at 66% duration
 *   Bottom-right: Last frame (100%)
 *
 * Returns a base64 PNG data URL, or null on failure.
 */
import { getThumbnailMaxDim } from "@/lib/thumbnailSize";

export function captureVideoThumbnail(videoDataUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;

    // Timeout fallback
    const timeout = setTimeout(() => resolve(null), 10000);

    video.onloadeddata = async () => {
      try {
        const duration = video.duration;
        if (!isFinite(duration) || duration <= 0) {
          // Fallback: capture single frame for very short/invalid videos
          video.currentTime = 0;
          video.onseeked = () => {
            try {
              const cap = getThumbnailMaxDim();
              const s1 = Math.min(1, cap / Math.max(video.videoWidth, video.videoHeight));
              const canvas = document.createElement("canvas");
              canvas.width = Math.max(1, Math.round(video.videoWidth * s1));
              canvas.height = Math.max(1, Math.round(video.videoHeight * s1));
              const ctx = canvas.getContext("2d");
              if (ctx) {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                clearTimeout(timeout);
                resolve(canvas.toDataURL("image/jpeg", 0.72));
              } else {
                clearTimeout(timeout);
                resolve(null);
              }
            } catch {
              clearTimeout(timeout);
              resolve(null);
            }
          };
          return;
        }

        // Small epsilon to avoid seeking past end
        const lastFrameTime = Math.max(0, duration - 0.05);
        const seekTimes = [
          0,                          // 0%   — top-left
          duration * 0.33,            // 33%  — top-right
          duration * 0.66,            // 66%  — bottom-left
          lastFrameTime,              // 100% — bottom-right
        ];

        // Capture all 4 frames sequentially
        const frames: (ImageBitmap | null)[] = [];
        for (const t of seekTimes) {
          const frame = await seekAndCapture(video, t);
          frames.push(frame);
        }

        // If all captures failed, return null
        if (frames.every((f) => f === null)) {
          clearTimeout(timeout);
          resolve(null);
          return;
        }

        // Composite into a 2×2 grid, scaled to the same budget as every other
        // node thumbnail. At source resolution this canvas is 2x the video on
        // each axis — a 4K clip produced a 7680x4312 PNG poster (~75MB of
        // base64) to fill a ~90px preview, and that got re-decoded on every
        // viewport remount.
        const cellCap = getThumbnailMaxDim() / 2;
        const scale = Math.min(1, cellCap / Math.max(video.videoWidth, video.videoHeight));
        const fw = Math.max(1, Math.round(video.videoWidth * scale));
        const fh = Math.max(1, Math.round(video.videoHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = fw * 2;
        canvas.height = fh * 2;
        const ctx = canvas.getContext("2d");

        if (!ctx) {
          clearTimeout(timeout);
          resolve(null);
          return;
        }

        // Fill background black (in case any frame failed)
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw each frame into its quadrant
        const positions = [
          [0, 0],        // top-left
          [fw, 0],       // top-right
          [0, fh],       // bottom-left
          [fw, fh],      // bottom-right
        ];

        for (let i = 0; i < 4; i++) {
          const frame = frames[i];
          if (frame) {
            ctx.drawImage(frame, positions[i][0], positions[i][1], fw, fh);
            frame.close();
          }
        }

        // Draw subtle grid lines to separate quadrants
        ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
        ctx.lineWidth = 2;
        // Vertical center line
        ctx.beginPath();
        ctx.moveTo(fw, 0);
        ctx.lineTo(fw, canvas.height);
        ctx.stroke();
        // Horizontal center line
        ctx.beginPath();
        ctx.moveTo(0, fh);
        ctx.lineTo(canvas.width, fh);
        ctx.stroke();
        // JPEG: these are photographic frames, and PNG kept them ~20x larger.

        clearTimeout(timeout);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      } catch {
        clearTimeout(timeout);
        resolve(null);
      }
    };

    video.onerror = () => {
      clearTimeout(timeout);
      resolve(null);
    };

    video.src = videoDataUrl;
  });
}
