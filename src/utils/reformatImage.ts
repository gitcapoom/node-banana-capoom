/**
 * Reformat (resize) an image into a target H×V resolution with a selectable
 * interpolation filter.
 *
 *  - "fill" : DISTORT — stretch the source non-uniformly to fill the whole
 *             W×H output exactly (aspect ratio is not preserved).
 *  - "fitH" : scale uniformly so the WIDTH matches the output (W/srcW), centered.
 *  - "fitV" : scale uniformly so the HEIGHT matches the output (H/srcH), centered.
 *
 * Impulse / bilinear use the (GPU-accelerated) Canvas path; the higher-quality
 * filters (cubic / keys / mitchell / lanczos / gaussian) use a CPU separable
 * resampler (resampleImage.ts). Pure function — shared by the node's live
 * preview and the headless executor.
 */

import { resampleImageData } from "./resampleImage";
import type { ResampleFilter } from "./resampleFilters";

export type ReformatMode = "fill" | "fitH" | "fitV";

export function reformatImage(
  src: string,
  width: number,
  height: number,
  mode: ReformatMode,
  filter: ResampleFilter = "cubic",
): Promise<string> {
  const W = Math.max(1, Math.round(width));
  const H = Math.max(1, Math.round(height));
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) img.crossOrigin = "anonymous";
    img.onload = () => {
      const sw = img.naturalWidth, sh = img.naturalHeight;
      if (!sw || !sh) { resolve(src); return; }

      // Target draw rectangle in the W×H output.
      let dw: number, dh: number, dx: number, dy: number;
      if (mode === "fill") {
        dw = W; dh = H; dx = 0; dy = 0;
      } else {
        const scale = mode === "fitH" ? W / sw : H / sh;
        dw = sw * scale; dh = sh * scale;
        dx = (W - dw) / 2; dy = (H - dh) / 2;
      }

      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(src); return; }

      try {
        if (filter === "impulse" || filter === "bilinear") {
          // Fast path — let the browser scale.
          ctx.imageSmoothingEnabled = filter === "bilinear";
          if (filter === "bilinear") ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, dx, dy, dw, dh);
        } else {
          // Quality path — CPU separable resample to the draw size, then place.
          const dwR = Math.max(1, Math.round(dw));
          const dhR = Math.max(1, Math.round(dh));
          const sc = document.createElement("canvas");
          sc.width = sw; sc.height = sh;
          const sctx = sc.getContext("2d", { willReadFrequently: true });
          if (!sctx) { resolve(src); return; }
          sctx.drawImage(img, 0, 0);
          const srcData = sctx.getImageData(0, 0, sw, sh);
          const outData = resampleImageData(srcData, dwR, dhR, filter);
          const tc = document.createElement("canvas");
          tc.width = dwR; tc.height = dhR;
          tc.getContext("2d")!.putImageData(outData, 0, 0);
          ctx.drawImage(tc, Math.round(dx), Math.round(dy));
        }
        resolve(canvas.toDataURL("image/png"));
      } catch (err) {
        // e.g. getImageData on a tainted canvas — fall back to the source.
        console.warn("reformatImage: resample failed, passing through", err);
        resolve(src);
      }
    };
    img.onerror = () => reject(new Error("reformatImage: failed to load image"));
    img.src = src;
  });
}
