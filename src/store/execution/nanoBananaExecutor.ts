/**
 * NanoBanana Executor
 *
 * Unified executor for nanoBanana (image generation) nodes.
 * Used by both executeWorkflow and regenerateNode.
 */

import type {
  NanoBananaNodeData,
} from "@/types";
import { buildGenerateHeaders } from "@/store/utils/buildApiHeaders";
import { consumeGenerateSSE, isSSEResponse } from "@/utils/generateSSE";
import type { NodeExecutionContext } from "./types";

export interface NanoBananaOptions {
  /** When true, falls back to stored inputImages/inputPrompt if no connections provide them. */
  useStoredFallback?: boolean;
}

export async function executeNanoBanana(
  ctx: NodeExecutionContext,
  options: NanoBananaOptions = {}
): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    getFreshNode,
    getEdges,
    getNodes,
    signal,
    providerSettings,
    addIncurredCost,
    addToGlobalHistory,
    generationsPath,
    trackSaveGeneration,
    appendOutputGalleryImage,
    get,
  } = ctx;

  const { useStoredFallback = false } = options;

  const { images: connectedImages, text: connectedText, dynamicInputs } = getConnectedInputs(node.id);

  // Get fresh node data from store
  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as NanoBananaNodeData;

  // Determine images and text (with optional fallback to stored values)
  let images: string[];
  let promptText: string | null;

  if (useStoredFallback) {
    images = connectedImages.length > 0 ? connectedImages : nodeData.inputImages;
    promptText = connectedText ?? nodeData.inputPrompt;
  } else {
    images = connectedImages;
    // For dynamic inputs, check if we have at least a prompt
    const promptFromDynamic = Array.isArray(dynamicInputs.prompt)
      ? dynamicInputs.prompt[0]
      : dynamicInputs.prompt;
    promptText = connectedText || promptFromDynamic || null;
  }

  // Defensive: ensure promptText is actually a string at runtime
  // (Guards against corrupted node data or race conditions in parallel execution)
  if (promptText !== null && typeof promptText !== 'string') {
    const raw: unknown = promptText;
    console.warn('[nanoBanana] promptText was not a string, coercing:', typeof raw, Array.isArray(raw) ? `<redacted array length=${(raw as unknown[]).length}>` : '<redacted>');
    promptText = Array.isArray(raw) ? (raw as string[])[0] ?? null : null;
  }

  if (!promptText) {
    updateNodeData(node.id, {
      status: "error",
      error: "Missing text input",
    });
    throw new Error("Missing text input");
  }

  updateNodeData(node.id, {
    inputImages: images,
    inputPrompt: promptText,
    status: "loading",
    loadingStartedAt: Date.now(),
    loadingPhase: "Submitting…",
    error: null,
    lastGenerationCost: null,
  });

  const provider = nodeData.selectedModel?.provider || "gemini";
  const headers = buildGenerateHeaders(provider, providerSettings);

  // Sanitize dynamicInputs: remove prompt since it's already sent as the top-level
  // `prompt` field in requestPayload. Keeping both can cause providers like Replicate
  // to prefer dynamicInputs.prompt over the authoritative top-level value.
  const sanitizedDynamicInputs = { ...dynamicInputs };
  delete sanitizedDynamicInputs.prompt;

  // Process {image:N} placeholders — replaces with description markers for providers
  // that support inline image references, or logs the mapping for debugging
  if (promptText && images.length > 0) {
    promptText = promptText.replace(/\{image:(\d+)\}/g, (match, numStr) => {
      const idx = parseInt(numStr, 10) - 1; // 1-indexed → 0-indexed
      if (idx >= 0 && idx < images.length) {
        return `[image ${numStr}]`; // Provider-neutral marker
      }
      return match; // Leave out-of-range placeholders as-is
    });
  }

  const requestPayload = {
    images,
    prompt: promptText,
    aspectRatio: nodeData.aspectRatio,
    resolution: nodeData.resolution,
    model: nodeData.model,
    useGoogleSearch: nodeData.useGoogleSearch,
    useImageSearch: nodeData.useImageSearch,
    selectedModel: nodeData.selectedModel,
    parameters: nodeData.parameters,
    dynamicInputs: sanitizedDynamicInputs,
  };

  // Final guard: assert that prompt is a string before sending to API
  // This catches any remaining edge cases and provides a clear error message
  if (typeof requestPayload.prompt !== 'string') {
    const errorMsg = `Internal error: prompt is ${typeof requestPayload.prompt}, expected string`;
    console.error('[nanoBanana]', errorMsg);
    updateNodeData(node.id, { status: 'error', error: errorMsg });
    throw new Error(errorMsg);
  }

  try {
    let body: string;
    try {
      body = JSON.stringify(requestPayload);
    } catch (serializeError) {
      const msg = `Failed to serialize request (${images.length} images): ${serializeError instanceof Error ? serializeError.message : String(serializeError)}`;
      console.error('[nanoBanana] Serialization failed:', serializeError);
      updateNodeData(node.id, { status: "error", error: msg });
      throw new Error(msg);
    }

    // Ask the server for SSE streaming so we get live queue position
    // updates while the upstream provider polls. The server falls back to
    // JSON on its own for providers that haven't been wired to SSE yet.
    const sseHeaders = { ...headers, Accept: "text/event-stream" };
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: sseHeaders,
      body,
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorMessage;
      } catch {
        if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
      }

      updateNodeData(node.id, {
        status: "error",
        error: errorMessage,
      });
      throw new Error(errorMessage);
    }

    // Parse SSE stream when the server opted into it; status events
    // become live loadingPhase / queuePosition updates on the node.
    // Falls back to the legacy JSON path otherwise.
    let result: { success?: boolean; error?: string; image?: string; images?: string[]; cost?: number; [k: string]: unknown };
    if (isSSEResponse(response)) {
      result = await consumeGenerateSSE(response, (status) => {
        const label =
          status.phase === "queued"
            ? (status.queuePosition != null
                ? `Queued · #${status.queuePosition + 1}`
                : "Queued…")
            : status.phase === "running"
              ? "Generating…"
              : status.phase === "downloading"
                ? "Downloading…"
                : "Submitting…";
        updateNodeData(node.id, {
          loadingPhase: label,
          ...(status.queuePosition != null ? { queuePosition: status.queuePosition } : { queuePosition: null }),
        });
      }) as typeof result;
    } else {
      result = await response.json();
    }

    if (result.success && result.image) {
      const timestamp = Date.now();
      // Collect all returned images (multi-image generation support)
      const allImages: string[] = Array.isArray(result.images) && result.images.length > 1
        ? result.images
        : [result.image];

      // Build a history item per image (newest first within this generation batch)
      // Use indexed IDs so each image gets a unique entry
      const newHistoryItems = allImages.map((img, idx) => ({
        id: allImages.length > 1 ? `${timestamp}-${idx}` : `${timestamp}`,
        image: img,
        timestamp: timestamp + idx, // offset by idx to keep stable sort order
        prompt: promptText,
        aspectRatio: nodeData.aspectRatio,
        model: nodeData.model,
        resolution: nodeData.resolution,
        selectedModel: nodeData.selectedModel,
        parameters: nodeData.parameters ? { ...nodeData.parameters } : undefined,
        useGoogleSearch: nodeData.useGoogleSearch,
        useImageSearch: nodeData.useImageSearch,
      }));

      // Save ALL images to global history
      for (const item of newHistoryItems) {
        addToGlobalHistory({
          image: item.image,
          timestamp: item.timestamp,
          prompt: promptText,
          aspectRatio: nodeData.aspectRatio,
          model: nodeData.model,
        });
      }

      // Add all new items to the node's carousel history (newest first)
      // Strip `image` field from history entries since it's only used here for saving;
      // the carousel loads images from disk by ID.
      const carouselEntries = newHistoryItems.map(({ image: _img, ...rest }) => rest);
      const reversedEntries = [...carouselEntries].reverse(); // so item 0 appears first
      const updatedHistory = [...reversedEntries, ...(nodeData.imageHistory || [])].slice(0, 50);

      updateNodeData(node.id, {
        outputImage: result.image, // Show first image as the active output
        status: "complete",
        error: null,
        imageHistory: updatedHistory,
        selectedHistoryIndex: 0,
      });

      // Push all new images to connected downstream outputGallery nodes
      const edges = getEdges();
      const nodes = getNodes();
      edges
        .filter((e) => e.source === node.id)
        .forEach((e) => {
          const target = nodes.find((n) => n.id === e.target);
          if (target?.type === "outputGallery") {
            for (const img of allImages) {
              appendOutputGalleryImage(target.id, img);
            }
          }
        });

      // Track cost from server response
      if (result.cost != null) {
        addIncurredCost(result.cost);
        updateNodeData(node.id, { lastGenerationCost: result.cost });
      }

      // Auto-save ALL images to generations folder if configured
      if (generationsPath) {
        for (const item of newHistoryItems) {
          const savedItemId = item.id;
          const savePromise = fetch("/api/save-generation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              directoryPath: generationsPath,
              image: item.image,
              prompt: promptText,
              imageId: savedItemId,
            }),
          })
            .then((res) => res.json())
            .then((saveResult) => {
              if (saveResult.success && saveResult.imageId && saveResult.imageId !== savedItemId) {
                const currentNode = getNodes().find((n) => n.id === node.id);
                if (currentNode) {
                  const currentData = currentNode.data as NanoBananaNodeData;
                  const histCopy = [...(currentData.imageHistory || [])];
                  const entryIndex = histCopy.findIndex((h) => h.id === savedItemId);
                  if (entryIndex !== -1) {
                    histCopy[entryIndex] = { ...histCopy[entryIndex], id: saveResult.imageId };
                    updateNodeData(node.id, { imageHistory: histCopy });
                  }
                }
              }
            })
            .catch((err) => {
              console.error("Failed to save generation:", err);
            });

          trackSaveGeneration(savedItemId, savePromise);
        }
      }
    } else {
      updateNodeData(node.id, {
        status: "error",
        error: result.error || "Generation failed",
      });
      throw new Error(result.error || "Generation failed");
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    // Convert network errors to user-friendly messages
    let errorMessage = "Generation failed";
    if (error instanceof TypeError && error.message.includes("NetworkError")) {
      errorMessage = "Network error. Check your connection and try again.";
    } else if (error instanceof TypeError) {
      errorMessage = `Network error: ${error.message}`;
    } else if (error instanceof Error) {
      const raw = error.message;
      if (/UNAVAILABLE|Deadline expired|\b503\b|overloaded|temporarily unavailable/i.test(raw)) {
        errorMessage = "The image model is temporarily unavailable — please retry in a moment.";
      } else if (/call stack|stack size|RangeError/i.test(raw)) {
        errorMessage = "Internal error: this request was too complex to process. Try fewer or smaller inputs.";
      } else {
        errorMessage = raw;
      }
    }

    updateNodeData(node.id, {
      status: "error",
      error: errorMessage,
    });
    throw new Error(errorMessage);
  }
}
