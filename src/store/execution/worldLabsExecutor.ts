/**
 * WorldLabs Executor
 *
 * Executes WorldLabs "Generate World" nodes via the Marble API.
 * Flow: upload image(s) → submit generation → poll until done → fetch world assets.
 * Supports single-image, multi-image (with azimuth), and text-only prompts.
 * Supports cancellation via AbortSignal.
 */

import type { WorldLabsNodeData } from "@/types";
import { buildGenerateHeaders } from "@/store/utils/buildApiHeaders";
import type { NodeExecutionContext } from "./types";

/** Polling interval in milliseconds */
const POLL_INTERVAL_MS = 5_000;

/** Maximum poll attempts (5s × 120 = 10 minutes max) */
const MAX_POLL_ATTEMPTS = 120;

/** Default azimuths for multi-image (front, right, back, left) */
const DEFAULT_AZIMUTHS = [0, 90, 180, 270];

interface MultiImagePrompt {
  azimuth: number;
  content: {
    source: "media_asset";
    media_asset_id: string;
  };
}

export async function executeWorldLabs(
  ctx: NodeExecutionContext
): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    getFreshNode,
    signal,
    providerSettings,
  } = ctx;

  const { images: connectedImages, text: connectedText } = getConnectedInputs(node.id);

  // Get fresh node data
  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as WorldLabsNodeData;

  // Need at least text or image input
  if (!connectedText && connectedImages.length === 0) {
    updateNodeData(node.id, {
      status: "error",
      error: "Connect a text prompt or image to generate a world",
    });
    throw new Error("Missing text or image input");
  }

  // Determine prompt type: "text", "image" (single), or "multi-image" (2+)
  const hasText = !!connectedText;
  const hasImage = connectedImages.length > 0;
  const isMultiImage = connectedImages.length >= 2;
  const promptType: "text" | "image" | "multi-image" = isMultiImage
    ? "multi-image"
    : hasImage
      ? "image"
      : "text";

  // UI model names match API model names exactly
  const apiModel = nodeData.model;

  updateNodeData(node.id, {
    inputImages: connectedImages,
    inputPrompt: connectedText,
    status: "loading",
    error: null,
    progress: "Preparing...",
    operationId: null,
    worldId: null,
    spzUrls: null,
    panoUrl: null,
    thumbnailUrl: null,
    marbleViewerUrl: null,
    caption: null,
  });

  const headers = buildGenerateHeaders("worldlabs", providerSettings);

  try {
    // ─── Step 1: Upload image(s) via media assets ────────────
    let mediaAssetId: string | undefined;
    const multiImagePrompts: MultiImagePrompt[] = [];

    if (hasImage) {
      if (isMultiImage) {
        // Multi-image: upload ALL images and build azimuth array
        updateNodeData(node.id, { progress: `Uploading ${connectedImages.length} images...` });

        for (let i = 0; i < connectedImages.length; i++) {
          if (signal?.aborted) {
            throw new DOMException("Operation cancelled", "AbortError");
          }

          updateNodeData(node.id, {
            progress: `Uploading image ${i + 1} of ${connectedImages.length}...`,
          });

          const uploadResult = await uploadImage(headers, connectedImages[i], signal);

          // Get azimuth: use user-set value or default by index
          const azimuth = nodeData.imageAzimuths[i] ?? DEFAULT_AZIMUTHS[i % DEFAULT_AZIMUTHS.length];

          multiImagePrompts.push({
            azimuth,
            content: {
              source: "media_asset",
              media_asset_id: uploadResult.mediaAssetId,
            },
          });
        }
      } else {
        // Single image: upload just the first
        updateNodeData(node.id, { progress: "Uploading image..." });
        const uploadResult = await uploadImage(headers, connectedImages[0], signal);
        mediaAssetId = uploadResult.mediaAssetId;
      }
    }

    // ─── Step 2: Submit generation ──────────────────────────────
    updateNodeData(node.id, { progress: "Submitting to WorldLabs..." });

    const generateBody: Record<string, unknown> = {
      action: "generate",
      promptType,
      model: apiModel,
      worldName: nodeData.worldName || "",
    };

    if (connectedText) {
      generateBody.textPrompt = connectedText;
    }
    if (mediaAssetId) {
      generateBody.mediaAssetId = mediaAssetId;
    }
    if (multiImagePrompts.length > 0) {
      generateBody.multiImagePrompts = multiImagePrompts;
    }
    if (nodeData.seed != null) {
      generateBody.seed = nodeData.seed;
    }

    const generateResponse = await fetch("/api/worldlabs", {
      method: "POST",
      headers,
      body: JSON.stringify(generateBody),
      ...(signal ? { signal } : {}),
    });

    if (!generateResponse.ok) {
      const errText = await generateResponse.text();
      let errMsg = `Generation failed (${generateResponse.status})`;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.error || errMsg;
      } catch { /* use default */ }
      throw new Error(errMsg);
    }

    const generateResult = await generateResponse.json();
    if (!generateResult.success || !generateResult.operationId) {
      throw new Error(generateResult.error || "No operation ID returned");
    }

    const operationId = generateResult.operationId;
    updateNodeData(node.id, {
      operationId,
      progress: "Generating world...",
    });

    // ─── Step 3: Poll until done ────────────────────────────────
    let worldId: string | null = null;

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      // Check for cancellation
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
        // Transient errors during polling — continue trying
        console.warn(`[WorldLabs] Poll attempt ${attempt + 1} failed (${pollResponse.status})`);
        continue;
      }

      const pollResult = await pollResponse.json();

      if (pollResult.error) {
        throw new Error(`WorldLabs error: ${pollResult.error}`);
      }

      if (pollResult.done && pollResult.worldId) {
        worldId = pollResult.worldId;
        break;
      }

      // Update progress with attempt count
      const elapsed = ((attempt + 1) * POLL_INTERVAL_MS / 1000).toFixed(0);
      updateNodeData(node.id, {
        progress: `Generating world... (${elapsed}s)`,
      });
    }

    if (!worldId) {
      throw new Error("World generation timed out after maximum polling attempts");
    }

    // ─── Step 4: Fetch world assets ─────────────────────────────
    updateNodeData(node.id, {
      worldId,
      progress: "Fetching world assets...",
    });

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
      throw new Error(`Failed to fetch world: ${errText}`);
    }

    const worldResult = await worldResponse.json();
    if (!worldResult.success) {
      throw new Error(worldResult.error || "Failed to fetch world assets");
    }

    // ─── Step 5: Update node with results ───────────────────────
    updateNodeData(node.id, {
      worldId: worldResult.worldId,
      spzUrls: worldResult.spzUrls,
      panoUrl: worldResult.panoUrl,
      thumbnailUrl: worldResult.thumbnailUrl,
      marbleViewerUrl: worldResult.marbleViewerUrl,
      caption: worldResult.caption,
      status: "complete",
      error: null,
      progress: null,
    });
  } catch (error) {
    // Re-throw abort errors
    if (error instanceof DOMException && error.name === "AbortError") {
      updateNodeData(node.id, {
        status: "idle",
        progress: null,
      });
      throw error;
    }

    const errorMessage =
      error instanceof Error ? error.message : "World generation failed";

    updateNodeData(node.id, {
      status: "error",
      error: errorMessage,
      progress: null,
    });
    throw new Error(errorMessage);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

async function uploadImage(
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
