/**
 * Upscale Grid Executor
 *
 * Pipeline:
 *   1. Crop the input into 4 corner quadrants server-side (/api/upscale-crop) —
 *      each the input's aspect ratio, enlarged by `overlapPercent` (default 10%).
 *   2. Send each quadrant to the chosen image generator independently (and
 *      sequentially, to avoid provider concurrency limits) with identical model
 *      parameters — the same payload shape as the nanoBanana node, so ANY
 *      provider/model works.
 *   3. Recombine the 4 outputs (/api/upscale-recombine): Lanczos-resize and
 *      feather-blend into one high-res image, baked into the generations folder.
 *
 * The final full-res PNG is written to the generations folder (like every other
 * generator node); the node keeps only a lightweight thumbnail and a reference,
 * loading full-res on double-click.
 */

import type { UpscaleGridNodeData } from "@/types";
import { buildGenerateHeaders } from "@/store/utils/buildApiHeaders";
import type { NodeExecutionContext } from "./types";

export async function executeUpscaleGrid(ctx: NodeExecutionContext): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    getFreshNode,
    signal,
    providerSettings,
    addIncurredCost,
    generationsPath,
  } = ctx;

  const { images: connectedImages, text: connectedText, dynamicInputs } = getConnectedInputs(node.id);

  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as UpscaleGridNodeData;

  const inputImage = connectedImages[0] ?? nodeData.inputImages?.[0] ?? null;
  if (!inputImage) {
    updateNodeData(node.id, { status: "error", error: "Missing input image" });
    throw new Error("Missing input image");
  }

  // Prompt is optional for upscalers; pass through whatever is connected.
  const promptFromDynamic = Array.isArray(dynamicInputs.prompt)
    ? dynamicInputs.prompt[0]
    : dynamicInputs.prompt;
  const promptText: string = connectedText || promptFromDynamic || nodeData.inputPrompt || "";

  const overlapPercent = nodeData.overlapPercent ?? 10;
  const finalLongEdge = nodeData.finalLongEdge ?? 8192;

  updateNodeData(node.id, {
    inputImages: [inputImage],
    inputPrompt: promptText || null,
    status: "loading",
    loadingStartedAt: Date.now(),
    loadingPhase: "Cropping quadrants…",
    error: null,
    lastGenerationCost: null,
    quadrantOutputs: [null, null, null, null],
  });

  try {
    // ── 1. Crop the 4 quadrants (server-side, exact) ──
    const cropResp = await fetch("/api/upscale-crop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: inputImage, overlapPercent }),
      ...(signal ? { signal } : {}),
    });
    const cropJson = await cropResp.json();
    if (!cropResp.ok || !cropJson.success) {
      throw new Error(cropJson.error || "Failed to crop input image");
    }
    const { quadrants, width: W, height: H } = cropJson as {
      quadrants: { ul: string; ur: string; ll: string; lr: string };
      width: number;
      height: number;
    };
    // Order: [UL, UR, LL, LR]
    const crops = [quadrants.ul, quadrants.ur, quadrants.ll, quadrants.lr];

    // Show the input tiles immediately so it's visually clear what each
    // generator receives (each slot is later replaced by its result).
    updateNodeData(node.id, { quadrantOutputs: [...crops] });

    // ── 2. Generate each quadrant independently with identical params ──
    const provider = nodeData.selectedModel?.provider || "gemini";
    const headers = buildGenerateHeaders(provider, providerSettings);

    // Build the per-quadrant dynamicInputs. When the selected model has a schema
    // image input (e.g. fal/Replicate `image_urls`), getConnectedInputs routes
    // the FULL connected image into dynamicInputs[schemaName] — and the API
    // feeds that to the model, bypassing our crop. So for each quadrant we
    // replace any occurrence of the full input image inside dynamicInputs with
    // that quadrant's crop, and drop `prompt` (sent top-level). This guarantees
    // the model only ever sees the tile, never the whole image.
    const buildQuadrantDynamicInputs = (crop: string): Record<string, string | string[]> => {
      const out: Record<string, string | string[]> = {};
      for (const [key, val] of Object.entries(dynamicInputs)) {
        if (key === "prompt") continue;
        if (Array.isArray(val)) {
          out[key] = val.map((item) => (item === inputImage ? crop : item));
        } else {
          out[key] = val === inputImage ? crop : val;
        }
      }
      return out;
    };

    const labels = ["UL", "UR", "LL", "LR"];
    const quadOutputs: (string | null)[] = [...crops];
    const generated: string[] = [];
    let totalCost = 0;

    updateNodeData(node.id, { loadingPhase: "Generating 4 quadrants…" });

    // Each tile is generated independently and in parallel — the model only
    // ever receives its own crop plus the user's prompt (no injected text,
    // no access to the full image).
    const generateQuadrant = async (index: number): Promise<void> => {
      const payload = {
        images: [crops[index]],
        prompt: promptText,
        aspectRatio: nodeData.aspectRatio,
        resolution: nodeData.resolution,
        model: nodeData.model,
        useGoogleSearch: nodeData.useGoogleSearch,
        useImageSearch: nodeData.useImageSearch,
        selectedModel: nodeData.selectedModel,
        parameters: nodeData.parameters,
        dynamicInputs: buildQuadrantDynamicInputs(crops[index]),
      };

      const response = await fetch("/api/generate", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let msg = `HTTP ${response.status}`;
        try { msg = JSON.parse(errorText).error || msg; }
        catch { if (errorText) msg += ` - ${errorText.substring(0, 200)}`; }
        throw new Error(`Quadrant ${labels[index]}: ${msg}`);
      }

      const result = await response.json();
      if (!result.success || !result.image) {
        throw new Error(`Quadrant ${labels[index]}: ${result.error || "Generation failed"}`);
      }

      generated[index] = result.image;
      if (typeof result.cost === "number") totalCost += result.cost;

      // Replace the tile preview with its generated result as it completes.
      quadOutputs[index] = result.image;
      updateNodeData(node.id, { quadrantOutputs: [...quadOutputs] });
    };

    await Promise.all(crops.map((_, i) => generateQuadrant(i)));

    // ── 3. Recombine + bake into the generations folder ──
    updateNodeData(node.id, { loadingPhase: "Blending…" });
    const recombineResp = await fetch("/api/upscale-recombine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quadrants: { ul: generated[0], ur: generated[1], ll: generated[2], lr: generated[3] },
        inputWidth: W,
        inputHeight: H,
        overlapPercent,
        finalLongEdge,
        generationsPath: generationsPath || undefined,
      }),
      ...(signal ? { signal } : {}),
    });

    const recombine = await recombineResp.json();
    if (!recombineResp.ok || !recombine.success) {
      throw new Error(recombine.error || "Recombine failed");
    }

    if (recombine.baked && recombine.imageId) {
      // Full-res lives on disk; keep only the thumbnail + reference on the node.
      updateNodeData(node.id, {
        outputImage: null,
        outputImageRef: recombine.imageId,
        outputImageThumb: recombine.thumbnail || null,
        status: "complete",
        error: null,
        loadingPhase: undefined,
        quadrantOutputs: [null, null, null, null],
      });
    } else {
      // No generations folder configured — fall back to keeping the data URL.
      updateNodeData(node.id, {
        outputImage: recombine.image || null,
        outputImageThumb: recombine.thumbnail || null,
        status: "complete",
        error: null,
        loadingPhase: undefined,
        quadrantOutputs: [null, null, null, null],
      });
    }

    if (totalCost > 0) {
      addIncurredCost(totalCost);
      updateNodeData(node.id, { lastGenerationCost: totalCost });
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : "Upscale failed";
    updateNodeData(node.id, { status: "error", error: errorMessage });
    throw new Error(errorMessage);
  }
}
