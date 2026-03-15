/**
 * Shared media capture utilities.
 * Used by VideoInputNode, GenerateVideoNode, and other nodes that need
 * to extract frames from video content.
 */

/**
 * Seek a video element to a specific time and capture the frame as an ImageBitmap.
 * Returns null on failure.
 */
function seekAndCapture(
  video: HTMLVideoElement,
  time: number
): Promise<ImageBitmap | null> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      try {
        createImageBitmap(video).then(resolve).catch(() => resolve(null));
      } catch {
        resolve(null);
      }
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = time;
  });
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
              const canvas = document.createElement("canvas");
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              const ctx = canvas.getContext("2d");
              if (ctx) {
                ctx.drawImage(video, 0, 0);
                clearTimeout(timeout);
                resolve(canvas.toDataURL("image/png"));
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

        // Composite into a 2×2 grid
        const fw = video.videoWidth;
        const fh = video.videoHeight;
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

        clearTimeout(timeout);
        resolve(canvas.toDataURL("image/png"));
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
