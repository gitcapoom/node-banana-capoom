/**
 * Client-side utilities for immediately saving media content to disk.
 * Used by nodes that need to save content (videos, frame grabs, thumbnails)
 * to the project folder immediately on load/capture, rather than waiting for
 * workflow save-time externalization.
 */

import { generateImageId } from "./imageStorage";
import { THUMB_DISPLAY_FIELDS } from "./imageFieldMap";
import type { WorkflowNode, WorkflowNodeData, NodeType } from "@/types";

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
 * In-flight de-duplication for loadMediaById.
 *
 * Every consumer resolves its own inputs independently, so N nodes sharing one
 * upstream fire N identical full-res reads at the same instant. Measured on a
 * real project immediately after opening it: 87 requests for 43 distinct files,
 * one of them fetched 8 times over, each taking up to 59 SECONDS from the
 * network share. That queue is what makes a freshly opened workflow sluggish for
 * minutes and starves every other request behind it — including saves, which is
 * how this was found.
 *
 * Deliberately NOT a result cache: entries are dropped the moment the request
 * settles, so nothing retains a ~30MB data URL. Callers already keep what they
 * need in node data. `loadImageById` in imageStorage.ts has had both this and a
 * result cache all along; this is the sibling that never got either.
 */
const inFlightMediaLoads = new Map<string, Promise<string | null>>();

/**
 * Load media content from disk by ref ID.
 * Tries the workflow-images API first, then falls back to load-generation.
 *
 * Concurrent calls for the same (path, folder, ref) share one request.
 *
 * @param refId - The ref ID to load
 * @param saveDirectoryPath - Project directory path
 * @param folder - "inputs" or "generations"
 * @returns Base64 data URL on success, or null on failure
 */
export function loadMediaById(
  refId: string,
  saveDirectoryPath: string,
  folder: "inputs" | "generations" = "inputs"
): Promise<string | null> {
  if (!refId || !saveDirectoryPath) return Promise.resolve(null);

  const key = `${saveDirectoryPath}::${folder}::${refId}`;
  const existing = inFlightMediaLoads.get(key);
  if (existing) return existing;

  const pending = fetchMediaById(refId, saveDirectoryPath, folder).finally(() => {
    inFlightMediaLoads.delete(key);
  });
  inFlightMediaLoads.set(key, pending);
  return pending;
}

async function fetchMediaById(
  refId: string,
  saveDirectoryPath: string,
  folder: "inputs" | "generations"
): Promise<string | null> {
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

/**
 * Re-localize image refs on freshly-pasted nodes that came from a DIFFERENT
 * project. The pasted data carries the SOURCE project's ref ids (`img-…`), but
 * the files live in the source folder — so load each referenced file from the
 * source and re-save it into THIS project with a fresh id, then point the node
 * at the new ref (clearing the inline + thumb so the correct preview
 * regenerates). Refs the source no longer has are left untouched (no worse than
 * before). Fire-and-forget / non-blocking.
 */
export async function relocalizeNodeImageRefs(
  newNodes: WorkflowNode[],
  sourcePath: string | null,
  destPath: string | null,
  updateNodeData: (id: string, data: Partial<WorkflowNodeData>) => void,
): Promise<void> {
  if (!sourcePath || !destPath || sourcePath === destPath) return;
  for (const node of newNodes) {
    const fields = THUMB_DISPLAY_FIELDS[node.type as NodeType];
    if (!fields) continue;
    const data = node.data as Record<string, unknown>;
    for (const f of fields) {
      const ref = data[f.ref] as string | undefined;
      if (!ref) continue;
      try {
        const content = await loadMediaById(ref, sourcePath, f.folder); // from the SOURCE project
        if (!content) continue; // source file gone — leave the ref as-is
        const newRef = await saveMediaImmediately(content, destPath, f.folder); // copy into THIS project, fresh id
        if (newRef) {
          updateNodeData(node.id, { [f.raw]: null, [f.ref]: newRef, [f.thumb]: undefined } as Partial<WorkflowNodeData>);
        }
      } catch { /* skip this field */ }
    }
  }
}
