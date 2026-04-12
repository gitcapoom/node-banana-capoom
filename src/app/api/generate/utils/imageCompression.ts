/**
 * Image Compression Utilities
 *
 * Compresses images that are too large for provider APIs.
 * Strategy:
 *   1. If PNG → convert to JPEG (quality 85)
 *   2. If still > SIZE_THRESHOLD or already JPEG → resize to 50% dimensions, JPEG quality 80
 *
 * Uses sharp for server-side image processing.
 */

import sharp from "sharp";

/** Images above this size (in bytes) get resized after PNG→JPEG conversion */
const SIZE_THRESHOLD = 10 * 1024 * 1024; // 10 MB

/**
 * Compress a single image data URL.
 * Returns the compressed data URL, or the original if it's not an image data URL.
 */
export async function compressImage(dataUrl: string): Promise<string> {
  // Only process base64 image data URLs
  if (!dataUrl.startsWith("data:image/")) return dataUrl;

  const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) return dataUrl;

  const mimeType = match[1];
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, "base64");
  const originalSize = buffer.length;

  console.log(`[compress] Input: ${mimeType}, ${(originalSize / 1024 / 1024).toFixed(1)}MB`);

  let result: Buffer;

  // Step 1: If PNG, convert to JPEG
  if (mimeType === "image/png" || mimeType === "image/webp") {
    result = await sharp(buffer).jpeg({ quality: 85 }).toBuffer();
    console.log(`[compress] PNG/WebP → JPEG: ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(result.length / 1024 / 1024).toFixed(1)}MB`);

    // If conversion reduced size enough, return it
    if (result.length <= SIZE_THRESHOLD) {
      const compressed = `data:image/jpeg;base64,${result.toString("base64")}`;
      return compressed;
    }
  } else {
    result = buffer;
  }

  // Step 2: Resize to 50% dimensions and encode as JPEG
  const metadata = await sharp(result).metadata();
  const newWidth = Math.round((metadata.width || 1024) / 2);

  result = await sharp(result)
    .resize({ width: newWidth })
    .jpeg({ quality: 80 })
    .toBuffer();

  console.log(`[compress] Resized 50%: ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(result.length / 1024 / 1024).toFixed(1)}MB (${newWidth}px wide)`);

  return `data:image/jpeg;base64,${result.toString("base64")}`;
}

/**
 * Compress all image data URLs in the generation inputs.
 * Returns new images array and dynamicInputs with compressed images.
 */
export async function compressAllImages(
  images: string[],
  dynamicInputs?: Record<string, string | string[]>
): Promise<{
  images: string[];
  dynamicInputs?: Record<string, string | string[]>;
}> {
  // Compress images array
  const compressedImages = await Promise.all(
    images.map((img) => compressImage(img))
  );

  // Compress dynamic inputs
  let compressedDynamic: Record<string, string | string[]> | undefined;
  if (dynamicInputs) {
    compressedDynamic = {};
    for (const [key, value] of Object.entries(dynamicInputs)) {
      if (typeof value === "string" && value.startsWith("data:image/")) {
        compressedDynamic[key] = await compressImage(value);
      } else if (Array.isArray(value)) {
        compressedDynamic[key] = await Promise.all(
          value.map((v) =>
            typeof v === "string" && v.startsWith("data:image/")
              ? compressImage(v)
              : v
          )
        );
      } else {
        compressedDynamic[key] = value;
      }
    }
  }

  return { images: compressedImages, dynamicInputs: compressedDynamic };
}
