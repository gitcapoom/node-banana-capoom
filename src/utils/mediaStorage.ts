/**
 * Client-side utilities for immediately saving media content to disk.
 * Used by nodes that need to save content (videos, frame grabs, thumbnails)
 * to the project folder immediately on load/capture, rather than waiting for
 * workflow save-time externalization.
 */

import { generateImageId } from "./imageStorage";

/**
 * Save media content to the workflow's inputs/ or generations/ folder
 * immediately and return the ref ID.
 *
 * Uses /api/workflow-images for images (small files).
 * Falls back gracefully if the save fails (returns null).
 *
 * @param mediaData - Base64 data URL of the content
 * @param saveDirectoryPath - Project directory path (from store.saveDirectoryPath)
 * @param folder - "inputs" for user content, "generations" for AI-generated content
 * @param existingId - Optional existing ID to reuse
 * @returns The ref ID on success, or null on failure
 */
export async function saveMediaImmediately(
  mediaData: string,
  saveDirectoryPath: string,
  folder: "inputs" | "generations",
  existingId?: string
): Promise<string | null> {
  if (!saveDirectoryPath || !mediaData) return null;

  const imageId = existingId || generateImageId();

  try {
    // Check if this is a large video file (> 10MB base64 ≈ 7.5MB binary)
    const isLargeFile = mediaData.length > 10 * 1024 * 1024;
    const isVideo = mediaData.startsWith("data:video/");

    if (isLargeFile && isVideo) {
      // Use /api/save-generation for large video files (supports streaming)
      const response = await fetch("/api/save-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: `${saveDirectoryPath}/${folder}`,
          video: mediaData,
          customFilename: imageId,
          createDirectory: true,
        }),
      });

      if (!response.ok) {
        console.warn("Failed to save large media:", response.status);
        return null;
      }

      const result = await response.json();
      return result.imageId || imageId;
    }

    // Use /api/workflow-images for images and small files
    const response = await fetch("/api/workflow-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowPath: saveDirectoryPath,
        imageId,
        imageData: mediaData,
        folder,
      }),
    });

    if (!response.ok) {
      console.warn("Failed to save media:", response.status);
      return null;
    }

    return imageId;
  } catch (error) {
    console.warn("Error saving media to disk:", error);
    return null;
  }
}

/**
 * Load media content from disk by ref ID.
 * Tries the workflow-images API first, then falls back to load-generation.
 *
 * @param refId - The ref ID to load
 * @param saveDirectoryPath - Project directory path
 * @param folder - "inputs" or "generations"
 * @returns Base64 data URL on success, or null on failure
 */
export async function loadMediaById(
  refId: string,
  saveDirectoryPath: string,
  folder: "inputs" | "generations" = "inputs"
): Promise<string | null> {
  if (!refId || !saveDirectoryPath) return null;

  try {
    // Try workflow-images API first
    const params = new URLSearchParams({
      workflowPath: saveDirectoryPath,
      imageId: refId,
      folder,
    });

    const response = await fetch(`/api/workflow-images?${params}`);
    if (response.ok) {
      const result = await response.json();
      if (result.success && result.image) {
        return result.image;
      }
    }

    // Fallback: try load-generation API
    const genResponse = await fetch("/api/load-generation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        directoryPath: `${saveDirectoryPath}/${folder}`,
        imageId: refId,
      }),
    });

    if (genResponse.ok) {
      const result = await genResponse.json();
      if (result.success) {
        return result.image || result.video || result.audio || result.model3d || null;
      }
    }

    return null;
  } catch (error) {
    console.warn("Error loading media from disk:", error);
    return null;
  }
}
