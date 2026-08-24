/**
 * Client-side image cropping utility.
 *
 * Takes a data URL (or http(s) URL) image and a relative crop region (0-1 range),
 * and returns a PNG data URL of the cropped image at source resolution, together
 * with the geometry that produced it.
 *
 * Used by ImageCropNode (auto-apply when input changes) and ImageCropModal (preview).
 */

export interface RelativeCropRegion {
  x: number;      // 0..1
  y: number;      // 0..1
  width: number;  // 0..1
  height: number; // 0..1
}

/**
 * The crop plus the geometry it was cut with.
 *
 * `sx/sy/sw/sh` are the exact integers handed to `drawImage`, not a recomputation
 * from the relative region: each component is rounded independently below, so
 * `round(x*W) + round(w*W)` does not generally equal `round((x+w)*W)`. Anything
 * downstream that has to put the crop back where it came from (the Comp node's
 * auto-align) must use these numbers or it will drift by a pixel — and can even
 * run past `srcW`.
 */
export interface CropResult {
  dataUrl: string;
  srcW: number;
  srcH: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Clamp a relative region to the [0,1] box so we never sample outside the image.
 *
 * Exported because `buildCropMetadata` has to record the SAME region this
 * function produced: the integer rect in the metadata comes from the clamped
 * region, so recording the raw one would describe a rect that was never
 * sampled — and `parseCropMetadata` rejects an out-of-unit-box region outright,
 * taking the whole payload with it.
 */
export function clampRelativeRegion(region: RelativeCropRegion): RelativeCropRegion {
  const x = Math.max(0, Math.min(1, region.x));
  const y = Math.max(0, Math.min(1, region.y));
  const maxW = Math.max(0, 1 - x);
  const maxH = Math.max(0, 1 - y);
  const width = Math.max(0, Math.min(maxW, region.width));
  const height = Math.max(0, Math.min(maxH, region.height));
  return { x, y, width, height };
}

/**
 * Crop an image using a relative region (0-1 coordinates).
 * Returns a PNG data URL at the cropped pixel resolution, plus the source size
 * and the sample rect actually used.
 */
export async function cropImageToDataUrl(
  imageSrc: string,
  region: RelativeCropRegion
): Promise<CropResult> {
  const clamped = clampRelativeRegion(region);

  return new Promise<CropResult>((resolve, reject) => {
    const img = new Image();
    // crossOrigin is only meaningful for http(s) URLs; harmless for data: URLs
    if (!imageSrc.startsWith("data:") && !imageSrc.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => {
      const srcW = img.naturalWidth;
      const srcH = img.naturalHeight;

      // Full-frame case: hand back the ORIGINAL url, not a re-encode. Callers
      // compare `outputImage === src` to detect the passthrough (see
      // ImageCropNode's `passthrough:` branch), so that identity is load-bearing.
      // The decode above is no longer skipped, because the geometry has to be
      // real — one decode, but still no full-res PNG encode.
      if (clamped.width >= 1 && clamped.height >= 1 && clamped.x === 0 && clamped.y === 0) {
        resolve({ dataUrl: imageSrc, srcW, srcH, sx: 0, sy: 0, sw: srcW, sh: srcH });
        return;
      }

      const sx = Math.round(clamped.x * srcW);
      const sy = Math.round(clamped.y * srcH);
      const sw = Math.max(1, Math.round(clamped.width * srcW));
      const sh = Math.max(1, Math.round(clamped.height * srcH));

      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("cropImageToDataUrl: failed to get 2D context"));
        return;
      }
      try {
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve({ dataUrl: canvas.toDataURL("image/png"), srcW, srcH, sx, sy, sw, sh });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => reject(new Error("cropImageToDataUrl: failed to load image"));
    img.src = imageSrc;
  });
}
