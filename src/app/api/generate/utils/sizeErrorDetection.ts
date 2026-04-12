/**
 * Size Error Detection
 *
 * Detects whether a generation error is related to image/file size limits.
 * Used to decide whether to retry with compressed images.
 */

const SIZE_ERROR_PATTERNS = [
  /too large/i,
  /file.?size/i,
  /payload too large/i,
  /\b413\b/,
  /request entity too large/i,
  /size.?limit/i,
  /exceeds.*limit/i,
  /maximum.*size/i,
  /upload.*limit/i,
  /content.*too.*large/i,
  /image.*too.*big/i,
  /too.*big/i,
  /exceeds.*max/i,
  /over.*limit/i,
];

/**
 * Check if an error message indicates an image/file size issue.
 */
export function isImageSizeError(errorMessage: string): boolean {
  return SIZE_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * Extract error message from various error shapes returned by providers.
 * Providers may throw Error objects, return {success: false, error: "..."}, etc.
 */
export function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.message === "string") return obj.message;
  }
  return String(error);
}
