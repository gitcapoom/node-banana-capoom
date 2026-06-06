/**
 * Reformat (resize) an image into a target H×V resolution.
 *
 *  - "fill" : scale uniformly to COVER the output (max scale), centered;
 *             overflow is cropped.
 *  - "fitH" : scale so the WIDTH matches the output (scale = W/srcW), centered.
 *  - "fitV" : scale so the HEIGHT matches the output (scale = H/srcH), centered.
 *
 * The source is always scaled uniformly (no distortion) and centered in the
 * W×H canvas; uncovered area stays transparent. Pure function — shared by the
 * node's live preview and the headless executor.
 */

export type ReformatMode = "fill" | "fitH" | "fitV";

export function reformatImage(src: string, width: number, height: number, mode: ReformatMode): Promise<string> {
  const W = Math.max(1, Math.round(width));
  const H = Math.max(1, Math.round(height));
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) img.crossOrigin = "anonymous";
    img.onload = () => {
      const sw = img.naturalWidth, sh = img.naturalHeight;
      if (!sw || !sh) { resolve(src); return; }
      const sx = W / sw, sy = H / sh;
      const scale = mode === "fill" ? Math.max(sx, sy) : mode === "fitH" ? sx : sy;
      const dw = sw * scale, dh = sh * scale;
      const dx = (W - dw) / 2, dy = (H - dh) / 2;
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(src); return; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, dx, dy, dw, dh);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("reformatImage: failed to load image"));
    img.src = src;
  });
}
