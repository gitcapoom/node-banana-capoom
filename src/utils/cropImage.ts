/**
 * Client-side image cropping utility.
 *
 * Takes a data URL (or http(s) URL) image and a relative crop region (0-1 range),
 * and returns a PNG data URL of the cropped image at source resolution.
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
 * Clamp a relative region to the [0,1] box so we never sample outside the image.
 */
function clampRelativeRegion(region: RelativeCropRegion): RelativeCropRegion {
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
 * Returns a PNG data URL at the cropped pixel resolution.
 */
export async function cropImageToDataUrl(
  imageSrc: string,
  region: RelativeCropRegion
): Promise<string> {
  const clamped = clampRelativeRegion(region);

  // Trivial case: no crop needed (full image)
  if (clamped.width >= 1 && clamped.height >= 1 && clamped.x === 0 && clamped.y === 0) {
    return imageSrc;
  }

  return new Promise<string>((resolve, reject) => {
    const img = new Image();
    // crossOrigin is only meaningful for http(s) URLs; harmless for data: URLs
    if (!imageSrc.startsWith("data:") && !imageSrc.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => {
      const srcW = img.naturalWidth;
      const srcH = img.naturalHeight;

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
        resolve(canvas.toDataURL("image/png"));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => reject(new Error("cropImageToDataUrl: failed to load image"));
    img.src = imageSrc;
  });
}
