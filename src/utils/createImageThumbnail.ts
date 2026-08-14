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
 * Max thumbnail edge, in px — one fixed size for every thumb-writing path, on
 * purpose. Node previews render at ~200-300 CSS px, so this is display-accurate
 * without the cost of the old 384px thumbs, which carried 2.3x the pixels: that
 * weight lands in the workflow JSON and in every canvas paint, and in large
 * setups dozens of them decode at once.
 */
export const THUMB_MAX_DIM = 256;

export interface ThumbnailWithMeta {
  thumb: string;
  /** Dimensions of the SOURCE image, not of the thumbnail. */
  width: number;
  height: number;
}

/**
 * Thumbnail + the source's true dimensions.
 *
 * The source is decoded here anyway, so its real size is free at this point —
 * and it's the only moment it's cheaply available: once a workflow reopens,
 * only the downscaled thumb is in memory, and nothing can recover "this was
 * 3840×2160" from a 236px copy. Callers persist it alongside the thumb so the
 * node's resolution readout survives a reload.
 */
export async function createImageThumbnailWithMeta(
  srcDataUrl: string,
  maxDim = THUMB_MAX_DIM,
  quality = 0.72,
  format: "jpeg" | "png" = "jpeg",
): Promise<ThumbnailWithMeta> {
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
      resolve({
        thumb: format === "png" ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", quality),
        width: sw,
        height: sh,
      });
    };
    img.onerror = () => reject(new Error("createImageThumbnail: failed to load image"));
    img.src = srcDataUrl;
  });
}

/** Thumbnail only — see createImageThumbnailWithMeta when the source size matters. */
export async function createImageThumbnail(
  srcDataUrl: string,
  maxDim = THUMB_MAX_DIM,
  quality = 0.72,
  format: "jpeg" | "png" = "jpeg",
): Promise<string> {
  return (await createImageThumbnailWithMeta(srcDataUrl, maxDim, quality, format)).thumb;
}
