/**
 * WorldLabs World Executor
 *
 * Executes World Generator nodes via the Marble API.
 * Expects a single 2:1 panorama image input (always "image" prompt type).
 * Defaults to Marble 0.1-plus for production quality.
 * Stores SPZ URLs, panorama, thumbnail, marble viewer URL, and caption.
 */

import type { WorldLabsWorldNodeData } from "@/types";
import { buildGenerateHeaders } from "@/store/utils/buildApiHeaders";
import { uploadImage, pollUntilDone, fetchWorldAssets } from "./worldLabsUtils";
import type { NodeExecutionContext } from "./types";

export async function executeWorldLabsWorld(
  ctx: NodeExecutionContext
): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    getFreshNode,
    signal,
    providerSettings,
    generationsPath,
    trackSaveGeneration,
  } = ctx;

  const { images: connectedImages } = getConnectedInputs(node.id);

  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as WorldLabsWorldNodeData;

  // Requires exactly one panorama image input
  if (connectedImages.length === 0) {
    updateNodeData(node.id, {
      status: "error",
      error: "Connect a 2:1 panorama image to generate a world",
    });
    throw new Error("Missing panorama image input");
  }

  const apiModel = nodeData.model;

  updateNodeData(node.id, {
    inputImages: connectedImages,
    inputPrompt: null,
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
    // ─── Step 1: Upload panorama image ────────────────────────
    updateNodeData(node.id, { progress: "Uploading panorama..." });
    const uploadResult = await uploadImage(headers, connectedImages[0], signal);

    // ─── Step 2: Submit generation (always "image" prompt type) ─
    updateNodeData(node.id, { progress: "Submitting to WorldLabs..." });

    const generateBody: Record<string, unknown> = {
      action: "generate",
      promptType: "image",
      model: apiModel,
      worldName: nodeData.worldName || "",
      mediaAssetId: uploadResult.mediaAssetId,
      isPano: nodeData.isPano || false,
    };

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

    // ─── Step 3: Poll until done ──────────────────────────────
    const worldId = await pollUntilDone(
      headers,
      operationId,
      (msg) => updateNodeData(node.id, { progress: msg }),
      signal
    );

    // ─── Step 4: Fetch world assets ───────────────────────────
    updateNodeData(node.id, {
      worldId,
      progress: "Fetching world assets...",
    });

    const assets = await fetchWorldAssets(headers, worldId, signal);

    // ─── Step 5: Update node with full world results ──────────
    updateNodeData(node.id, {
      worldId: assets.worldId,
      spzUrls: assets.spzUrls,
      panoUrl: assets.panoUrl,
      thumbnailUrl: assets.thumbnailUrl,
      marbleViewerUrl: assets.marbleViewerUrl,
      caption: assets.caption,
      status: "complete",
      error: null,
      progress: null,
    });

    // ─── Step 6: Auto-save SPZ + panorama to generations folder ─
    if (generationsPath) {
      const worldLabel = (nodeData.worldName || "world")
        .slice(0, 30)
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")
        .toLowerCase() || "world";

      // Save best available SPZ file (full_res > 500k > 100k)
      const spzUrl =
        assets.spzUrls?.full_res ||
        assets.spzUrls?.["500k"] ||
        assets.spzUrls?.["100k"];

      if (spzUrl) {
        const spzSavePromise = fetch("/api/save-generation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directoryPath: generationsPath,
            model3d: spzUrl,
            customFilename: `${worldLabel}_spz`,
          }),
        })
          .then((res) => res.json())
          .then((result) => {
            if (!result.success) {
              console.warn("[WorldLabs] Failed to save SPZ:", result.error);
            }
          })
          .catch((err) => {
            console.error("[WorldLabs] Failed to save SPZ:", err);
          });

        trackSaveGeneration(`worldlabs-spz-${worldId}`, spzSavePromise);
      }

      // Save panorama image
      if (assets.panoUrl) {
        const panoSavePromise = fetch("/api/save-generation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directoryPath: generationsPath,
            image: assets.panoUrl,
            customFilename: `${worldLabel}_pano`,
          }),
        })
          .then((res) => res.json())
          .then((result) => {
            if (!result.success) {
              console.warn("[WorldLabs] Failed to save panorama:", result.error);
            }
          })
          .catch((err) => {
            console.error("[WorldLabs] Failed to save panorama:", err);
          });

        trackSaveGeneration(`worldlabs-pano-${worldId}`, panoSavePromise);
      }
    }
  } catch (error) {
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
