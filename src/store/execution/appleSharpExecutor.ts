/**
 * Executor for the Apple SHARP node.
 *
 * Sends a single image to the self-hosted SHARP server via /api/sharp proxy,
 * receives a .ply Gaussian Splat URL, and stores it in the node data.
 */

import type { AppleSharpNodeData } from "@/types";
import type { NodeExecutionContext } from "./types";

export async function executeAppleSharp(
  ctx: NodeExecutionContext
): Promise<void> {
  const { node, getConnectedInputs, updateNodeData, getFreshNode, signal, generationsPath, trackSaveGeneration } = ctx;

  const { images } = getConnectedInputs(node.id);
  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as AppleSharpNodeData;

  if (images.length === 0) {
    updateNodeData(node.id, {
      status: "error",
      error: "Connect an image input",
    });
    throw new Error("Apple SHARP: missing image input");
  }

  const image = images[0];

  updateNodeData(node.id, {
    inputImage: image,
    status: "loading",
    error: null,
    progress: "Sending to SHARP server...",
    output3dUrl: null,
    outputVideoUrl: null,
    savedFilename: null,
    savedFilePath: null,
  });

  try {
    const response = await fetch("/api/sharp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "predict",
        imageData: image,
        serverUrl: nodeData.serverUrl,
        renderVideo: nodeData.renderVideo,
      }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `SHARP server error (${response.status})`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorMessage;
      } catch {
        /* use default */
      }
      throw new Error(errorMessage);
    }

    const result = await response.json();

    if (!result.success || !result.plyUrl) {
      throw new Error(result.error || "SHARP prediction failed");
    }

    updateNodeData(node.id, {
      output3dUrl: result.plyUrl,
      outputVideoUrl: result.videoUrl || null,
      status: "complete",
      error: null,
      progress: null,
    });

    // Auto-save .ply to generations folder if configured
    if (generationsPath) {
      const savePromise = fetch("/api/save-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: generationsPath,
          model3d: result.plyUrl,
          prompt: "SHARP 3D reconstruction",
        }),
      })
        .then((res) => res.json())
        .then((saveResult: { success?: boolean; filename?: string; filePath?: string }) => {
          if (saveResult.success && saveResult.filename) {
            updateNodeData(node.id, {
              savedFilename: saveResult.filename,
              savedFilePath: saveResult.filePath || null,
            });
          }
        })
        .catch((err: unknown) =>
          console.error("Failed to save SHARP 3D model:", err)
        ) as Promise<void>;

      trackSaveGeneration(`sharp-${Date.now()}`, savePromise);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      updateNodeData(node.id, { status: "idle", progress: null });
      throw error;
    }

    const errorMessage =
      error instanceof Error ? error.message : "SHARP generation failed";
    updateNodeData(node.id, {
      status: "error",
      error: errorMessage,
      progress: null,
    });
    throw new Error(errorMessage);
  }
}
