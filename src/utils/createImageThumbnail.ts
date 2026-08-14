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

import { getThumbnailMaxDim } from "@/lib/thumbnailSize";

/**
 * Max thumbnail edge, in px. Re-exported from the user setting so every
 * thumb-writing path shares one number — see src/lib/thumbnailSize.ts for why
 * it matters and what the options cost.
 */
export function thumbMaxDim(): number {
  return getThumbnailMaxDim();
}

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
  maxDim = thumbMaxDim(),
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

/**
 * Repair a stored "thumbnail" that isn't actually thumbnail-sized.
 *
 * Video posters generated before mediaCapture.ts grew a size cap were written
 * at source resolution — a 4K clip produced a 7680x4312 PNG. Real examples
 * still on disk in a live project: 55.6MB, 16.7MB and 7MB files, each loaded
 * into the store and the DOM on every open to fill a ~90px preview. New
 * captures are capped, but nothing ever went back and fixed the old ones.
 *
 * Returns a downscaled copy, or null when the thumb is already within budget
 * (or cannot be decoded) — so callers can treat null as "nothing to do".
 */
export async function downscaleIfOversized(
  dataUrl: string,
  maxDim = thumbMaxDim(),
): Promise<string | null> {
  try {
    const meta = await new Promise<{ w: number; h: number }>((resolve, reject) => {
      const img = new Image();
      if (!dataUrl.startsWith("data:") && !dataUrl.startsWith("blob:")) img.crossOrigin = "anonymous";
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error("decode failed"));
      img.src = dataUrl;
    });
    // A little slack so we don't rewrite thumbs that are merely a few px over.
    if (Math.max(meta.w, meta.h) <= maxDim * 1.5) return null;
    return await createImageThumbnail(dataUrl, maxDim, 0.72, "png");
  } catch {
    return null;
  }
}

/** Thumbnail only — see createImageThumbnailWithMeta when the source size matters. */
export async function createImageThumbnail(
  srcDataUrl: string,
  maxDim = thumbMaxDim(),
  quality = 0.72,
  format: "jpeg" | "png" = "jpeg",
): Promise<string> {
  return (await createImageThumbnailWithMeta(srcDataUrl, maxDim, quality, format)).thumb;
}
