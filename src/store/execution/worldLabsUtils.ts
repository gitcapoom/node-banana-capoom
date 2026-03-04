/**
 * WorldLabs Shared Utilities
 *
 * Common helpers used by both the panorama and world executors:
 * image upload, polling, and shared constants.
 */

/** Polling interval in milliseconds */
export const POLL_INTERVAL_MS = 5_000;

/** Maximum poll attempts (5s × 120 = 10 minutes max) */
export const MAX_POLL_ATTEMPTS = 120;

/**
 * Upload an image to WorldLabs via the media-assets endpoint.
 */
export async function uploadImage(
  headers: Record<string, string>,
  imageData: string,
  signal?: AbortSignal | null
): Promise<{ mediaAssetId: string }> {
  const uploadResponse = await fetch("/api/worldlabs", {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "uploadImage",
      imageData,
      extension: "png",
    }),
    ...(signal ? { signal } : {}),
  });

  if (!uploadResponse.ok) {
    const err = await uploadResponse.text();
    throw new Error(`Image upload failed: ${err}`);
  }

  const uploadResult = await uploadResponse.json();
  if (!uploadResult.success) {
    throw new Error(uploadResult.error || "Image upload failed");
  }

  return { mediaAssetId: uploadResult.mediaAssetId };
}

/**
 * Poll a WorldLabs operation until it completes.
 * Returns the worldId on success, throws on timeout or error.
 */
export async function pollUntilDone(
  headers: Record<string, string>,
  operationId: string,
  onProgress: (msg: string) => void,
  signal?: AbortSignal | null
): Promise<string> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("Operation cancelled", "AbortError");
    }

    // Wait before polling
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Operation cancelled", "AbortError"));
        }, { once: true });
      }
    });

    const pollResponse = await fetch("/api/worldlabs", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "poll",
        operationId,
      }),
      ...(signal ? { signal } : {}),
    });

    if (!pollResponse.ok) {
      console.warn(`[WorldLabs] Poll attempt ${attempt + 1} failed (${pollResponse.status})`);
      continue;
    }

    const pollResult = await pollResponse.json();

    if (pollResult.error) {
      throw new Error(`WorldLabs error: ${pollResult.error}`);
    }

    if (pollResult.done && pollResult.worldId) {
      return pollResult.worldId;
    }

    const elapsed = ((attempt + 1) * POLL_INTERVAL_MS / 1000).toFixed(0);
    onProgress(`Generating... (${elapsed}s)`);
  }

  throw new Error("World generation timed out after maximum polling attempts");
}

/** Max retries for fetching world assets (assets may not be available immediately) */
const FETCH_ASSETS_MAX_RETRIES = 3;
const FETCH_ASSETS_RETRY_DELAY_MS = 3_000;

/**
 * Fetch world assets (SPZ URLs, panorama, thumbnail, etc.) by worldId.
 * Retries up to 3 times with a 3s delay if the response is missing SPZ URLs,
 * since assets may not be immediately available after generation completes.
 */
export async function fetchWorldAssets(
  headers: Record<string, string>,
  worldId: string,
  signal?: AbortSignal | null
): Promise<{
  worldId: string;
  spzUrls: { full_res: string | null; "500k": string | null; "100k": string | null };
  panoUrl: string | null;
  thumbnailUrl: string | null;
  marbleViewerUrl: string | null;
  caption: string | null;
}> {
  let lastError: string | null = null;

  for (let attempt = 0; attempt < FETCH_ASSETS_MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("Operation cancelled", "AbortError");
    }

    // Wait before retrying (skip delay on first attempt)
    if (attempt > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, FETCH_ASSETS_RETRY_DELAY_MS);
        if (signal) {
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Operation cancelled", "AbortError"));
          }, { once: true });
        }
      });
    }

    const worldResponse = await fetch("/api/worldlabs", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "getWorld",
        worldId,
      }),
      ...(signal ? { signal } : {}),
    });

    if (!worldResponse.ok) {
      const errText = await worldResponse.text();
      lastError = `Failed to fetch world (${worldResponse.status}): ${errText}`;
      console.warn(`[WorldLabs] getWorld attempt ${attempt + 1} failed: ${lastError}`);
      continue;
    }

    const worldResult = await worldResponse.json();
    if (!worldResult.success) {
      lastError = worldResult.error || "Failed to fetch world assets";
      console.warn(`[WorldLabs] getWorld attempt ${attempt + 1} returned error: ${lastError}`);
      continue;
    }

    const spzUrls = worldResult.spzUrls;
    const hasSpz = spzUrls && (spzUrls.full_res || spzUrls["500k"] || spzUrls["100k"]);

    // If no SPZ URLs yet and we have retries left, wait and retry
    if (!hasSpz && attempt < FETCH_ASSETS_MAX_RETRIES - 1) {
      console.warn(`[WorldLabs] getWorld attempt ${attempt + 1}: no SPZ URLs yet, retrying...`);
      continue;
    }

    return {
      worldId: worldResult.worldId,
      spzUrls: worldResult.spzUrls,
      panoUrl: worldResult.panoUrl,
      thumbnailUrl: worldResult.thumbnailUrl,
      marbleViewerUrl: worldResult.marbleViewerUrl,
      caption: worldResult.caption,
    };
  }

  throw new Error(lastError || "Failed to fetch world assets after retries");
}
