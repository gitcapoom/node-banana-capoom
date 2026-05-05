/**
 * Horizontal wrap-around shift for an image — primarily intended for
 * re-aligning equirectangular panoramas around the cylinder seam, but the
 * operation works on any image.
 *
 * Positive `shiftX` moves content to the right; what falls off the right
 * edge re-appears on the left. Negative shifts the other way. Values are
 * normalised modulo the source width so any integer is valid.
 *
 * Implementation: two `drawImage` calls on a fresh canvas — one at
 * `(offset, 0)` for the bulk of the image, one at `(offset - width, 0)`
 * to draw the part that wrapped around.
 */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load source image"));
    img.src = src;
  });
}

export async function shiftImageX(src: string, shiftX: number): Promise<string> {
  if (!Number.isFinite(shiftX) || Math.round(shiftX) === 0) return src;

  const img = await loadImage(src);
  const w = img.width;
  const h = img.height;
  // Normalise into [0, W) so e.g. shifting by -50 on a 1024-wide image
  // becomes drawing at offset = 974.
  const off = ((Math.round(shiftX) % w) + w) % w;
  if (off === 0) return src;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D context");

  ctx.drawImage(img, off, 0);
  ctx.drawImage(img, off - w, 0);

  return canvas.toDataURL("image/png");
}
