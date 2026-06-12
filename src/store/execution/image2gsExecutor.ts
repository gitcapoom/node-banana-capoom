/**
 * image2GS Executor
 *
 * Runs the local SHARP backend (via /api/image2gs) to turn a connected RGB
 * image + an on-node metric-depth EXR into a 3D Gaussian Splat `.ply`.
 *
 * Output mirrors generate3d: a short-lived blob: URL on `output3dUrl` (consumed
 * by the Gaussian Splat Viewer, which opens /viewer?url=…) plus an auto-save of
 * the `.ply` into the generations folder for persistence across reloads.
 *
 * The metric float depth never travels a graph edge — it is loaded straight
 * from the saved `.exr` and forwarded to the backend, which reads it with the
 * SHARP module's `load_depth_exr`.
 */

import type { Image2GSNodeData, Carousel3DItem } from "@/types";
import { loadMediaById } from "@/utils/mediaStorage";
import type { NodeExecutionContext } from "./types";

/** Convert a data: URL (or any fetchable URL) into a Blob (browser context). */
async function urlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  return await res.blob();
}

export async function executeImage2GS(ctx: NodeExecutionContext): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    getFreshNode,
    getNodes,
    signal,
    generationsPath,
    saveDirectoryPath,
    trackSaveGeneration,
  } = ctx;

  const { images } = getConnectedInputs(node.id);
  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as Image2GSNodeData;

  const rgb = images[0] || nodeData.inputImages?.[0] || null;
  if (!rgb) {
    updateNodeData(node.id, { status: "error", error: "Connect an RGB image input" });
    throw new Error("image2GS: missing RGB image input");
  }
  if (!nodeData.depthExrRef) {
    updateNodeData(node.id, { status: "error", error: "Load a depth EXR on the node" });
    throw new Error("image2GS: missing depth EXR");
  }
  if (!saveDirectoryPath) {
    updateNodeData(node.id, { status: "error", error: "Set a project save directory first" });
    throw new Error("image2GS: no saveDirectoryPath");
  }

  updateNodeData(node.id, {
    inputImages: [rgb],
    status: "loading",
    loadingStartedAt: Date.now(),
    loadingPhase: "Loading depth…",
    error: null,
    lastGenerationCost: null,
  });

  // Load the saved depth EXR bytes back from inputs/.
  const depthDataUrl = await loadMediaById(nodeData.depthExrRef, saveDirectoryPath, "inputs");
  if (!depthDataUrl) {
    updateNodeData(node.id, { status: "error", error: "Depth EXR file not found in inputs/" });
    throw new Error("image2GS: depth EXR ref not resolvable");
  }

  try {
    const [rgbBlob, depthBlob] = await Promise.all([urlToBlob(rgb), urlToBlob(depthDataUrl)]);

    const form = new FormData();
    // Backend (/generate) requires the RGB field named "image" (not "rgb").
    form.append("image", rgbBlob, "rgb.png");
    form.append("depth", depthBlob, nodeData.depthExrFilename || "depth.exr");
    // Sent for forward-compat; the current backend contract has no depth_channel
    // field (it auto-reads depth), so this is ignored server-side for now.
    form.append("depth_channel", nodeData.selectedDepthChannel || "");
    form.append("focal_mm", String(nodeData.focalLengthMm ?? 24));
    form.append("aperture_mm", String(nodeData.apertureMm ?? 36));
    if (nodeData.fPxOverride != null) form.append("f_px", String(nodeData.fPxOverride));
    form.append("blend_alpha", String(nodeData.blendAlpha ?? 0.4));

    updateNodeData(node.id, { loadingPhase: "Generating splat…" });

    const response = await fetch("/api/image2gs", {
      method: "POST",
      body: form,
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      try {
        const j = await response.json();
        const e = j?.error ?? j?.detail;
        if (typeof e === "string" && e) msg = e;
        else if (e != null) msg = JSON.stringify(e); // never let an object stringify to "[object Object]"
      } catch {
        /* non-JSON error body */
      }
      updateNodeData(node.id, { status: "error", error: msg });
      throw new Error(msg);
    }

    const plyBlob = await response.blob();
    const blobUrl = URL.createObjectURL(plyBlob);

    const timestamp = Date.now();
    const model3dId = `${timestamp}`;
    const newHistoryItem: Carousel3DItem = {
      id: model3dId,
      timestamp,
      prompt: nodeData.depthExrFilename || "image2GS",
      model: "sharp-local",
    };
    const updatedHistory = [newHistoryItem, ...(nodeData.model3dHistory || [])].slice(0, 50);

    updateNodeData(node.id, {
      output3dUrl: blobUrl,
      status: "complete",
      error: null,
      model3dHistory: updatedHistory,
      selectedModel3dHistoryIndex: 0,
    });

    // Auto-save the .ply to the generations folder. Multipart with a `.ply`
    // filename makes save-generation preserve the extension + dedupe by hash.
    if (generationsPath) {
      const saveForm = new FormData();
      saveForm.append("directoryPath", generationsPath);
      saveForm.append("customFilename", model3dId);
      saveForm.append("createDirectory", "true");
      saveForm.append("file", new File([plyBlob], `${model3dId}.ply`, { type: "application/octet-stream" }));

      const savePromise = fetch("/api/save-generation", { method: "POST", body: saveForm })
        .then((res) => res.json())
        .then((saveResult) => {
          if (saveResult.success && saveResult.filename) {
            updateNodeData(node.id, {
              savedFilename: saveResult.filename,
              savedFilePath: saveResult.filePath,
            });
            // Sync the history id to the on-disk stem so reload can reload it.
            if (saveResult.imageId && saveResult.imageId !== model3dId) {
              const currentNode = getNodes().find((n) => n.id === node.id);
              if (currentNode) {
                const currentData = currentNode.data as Image2GSNodeData;
                const histCopy = [...(currentData.model3dHistory || [])];
                const entryIndex = histCopy.findIndex((h) => h.id === model3dId);
                if (entryIndex !== -1) {
                  histCopy[entryIndex] = { ...histCopy[entryIndex], id: saveResult.imageId };
                  updateNodeData(node.id, { model3dHistory: histCopy });
                }
              }
            }
          }
        })
        .catch((err) => {
          console.error("Failed to save splat .ply:", err);
        });

      trackSaveGeneration(model3dId, savePromise);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const msg = error instanceof Error ? error.message : "Splat generation failed";
    updateNodeData(node.id, { status: "error", error: msg });
    throw new Error(msg);
  }
}
