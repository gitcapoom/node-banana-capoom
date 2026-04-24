/**
 * Mirror (flip) an image horizontally, vertically, or both using a 2D canvas.
 * Returns a PNG data URL. If neither axis is selected, returns the source
 * unchanged.
 */
export async function mirrorImage(
  src: string,
  flipHorizontal: boolean,
  flipVertical: boolean
): Promise<string> {
  if (!flipHorizontal && !flipVertical) return src;

  return new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Could not acquire 2D canvas context"));
          return;
        }
        ctx.translate(flipHorizontal ? img.width : 0, flipVertical ? img.height : 0);
        ctx.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => reject(new Error("Failed to load source image for mirroring"));
    img.src = src;
  });
}
