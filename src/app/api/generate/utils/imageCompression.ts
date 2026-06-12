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

  // Parse with string ops, NOT a regex — a greedy `(.+)` capture overflows
  // V8's regex stack on very large strings (e.g. 28 MB images → RangeError
  // "Maximum call stack size exceeded").
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl;
  const header = dataUrl.slice(0, comma);
  if (!/;base64$/i.test(header)) return dataUrl;
  const mimeType = header.slice(5, header.indexOf(";")); // strip leading "data:"
  const base64Data = dataUrl.slice(comma + 1);
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

/** Estimate the decoded byte size of a base64 data URL without decoding it. */
export function estimatedImageBytes(dataUrl: string): number {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return 0;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  return Math.ceil((dataUrl.length - comma - 1) * 3 / 4);
}

/**
 * Proactively compress ONLY the images whose decoded size exceeds `maxBytes`,
 * leaving smaller images untouched (no needless quality loss). Used as a
 * pre-pass before provider dispatch so very large inputs don't blow inline
 * payload limits / cause deadlines (Gemini sends images inline, uncompressed).
 *
 * Covers both the `images` array and any image values inside `dynamicInputs`
 * (string or string[]). Returns `compressedCount` so the caller can log/skip.
 */
export async function compressLargeImages(
  images: string[],
  dynamicInputs: Record<string, string | string[]> | undefined,
  maxBytes: number
): Promise<{
  images: string[];
  dynamicInputs?: Record<string, string | string[]>;
  compressedCount: number;
}> {
  let compressedCount = 0;
  const maybeCompress = async (v: string): Promise<string> => {
    if (v.startsWith("data:image/") && estimatedImageBytes(v) > maxBytes) {
      compressedCount++;
      return compressImage(v);
    }
    return v;
  };

  const outImages = await Promise.all(images.map((img) => maybeCompress(img)));

  let outDynamic: Record<string, string | string[]> | undefined;
  if (dynamicInputs) {
    outDynamic = {};
    for (const [key, value] of Object.entries(dynamicInputs)) {
      if (typeof value === "string") {
        outDynamic[key] = await maybeCompress(value);
      } else if (Array.isArray(value)) {
        outDynamic[key] = await Promise.all(
          value.map((v) => (typeof v === "string" ? maybeCompress(v) : v))
        );
      } else {
        outDynamic[key] = value;
      }
    }
  }

  return { images: outImages, dynamicInputs: outDynamic, compressedCount };
}
