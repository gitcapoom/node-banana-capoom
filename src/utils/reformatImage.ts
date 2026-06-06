/**
 * Reformat (resize) an image into a target H×V resolution.
 *
 *  - "fill" : DISTORT — stretch the source non-uniformly to fill the whole
 *             W×H output exactly (aspect ratio is not preserved).
 *  - "fitH" : scale uniformly so the WIDTH matches the output (W/srcW), centered.
 *  - "fitV" : scale uniformly so the HEIGHT matches the output (H/srcH), centered.
 *
 * The fit modes preserve aspect ratio and center the result (uncovered area
 * stays transparent). Pure function — shared by the node's live preview and
 * the headless executor.
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
      let dw: number, dh: number, dx: number, dy: number;
      if (mode === "fill") {
        // Distort: stretch to fill the whole output exactly.
        dw = W; dh = H; dx = 0; dy = 0;
      } else {
        // Fit width / height uniformly, centered.
        const scale = mode === "fitH" ? W / sw : H / sh;
        dw = sw * scale; dh = sh * scale;
        dx = (W - dw) / 2; dy = (H - dh) / 2;
      }
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
