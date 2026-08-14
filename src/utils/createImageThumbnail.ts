/**
 * Downscale an image data URL to a small thumbnail data URL.
 *
 * Used by the workflow save path to persist a tiny preview alongside the
 * full-res file ref, so opening a workflow shows previews without loading the
 * (20-26MB) full-res images. Opaque images → JPEG (small); images with alpha
 * (mattes, comp output) → PNG so transparency isn't flattened to black.
 *
 * Never upscales. Rejects on a decode failure so callers can keep the original
 * image/ref intact rather than poisoning the field with a bad thumb.
 */

/**
 * Max thumbnail edge, in px. Node previews render at ~200-300 CSS px, so this
 * is display-accurate at 1x and still readable at 2x DPR. Every thumb-writing
 * path shares it — raising it inflates the workflow JSON quadratically (a 384px
 * thumb carries 2.6x the pixels of a 236px one) and slows canvas paint in large
 * setups, where dozens of thumbs decode at once.
 */
export const THUMB_MAX_DIM = 236;

export async function createImageThumbnail(
  srcDataUrl: string,
  maxDim = THUMB_MAX_DIM,
  quality = 0.72,
  format: "jpeg" | "png" = "jpeg",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!srcDataUrl.startsWith("data:") && !srcDataUrl.startsWith("blob:")) img.crossOrigin = "anonymous";
    img.onload = () => {
      const sw = img.naturalWidth, sh = img.naturalHeight;
      if (!sw || !sh) { reject(new Error("createImageThumbnail: zero-size image")); return; }
      const scale = Math.min(1, maxDim / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * scale));
      const h = Math.max(1, Math.round(sh * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("createImageThumbnail: no 2d context")); return; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      resolve(format === "png" ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("createImageThumbnail: failed to load image"));
    img.src = srcDataUrl;
  });
}
