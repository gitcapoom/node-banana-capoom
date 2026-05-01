/**
 * Simple Node Executors
 *
 * Executors for node types that don't call external APIs:
 * annotation, prompt, promptConstructor, output, outputGallery, imageCompare.
 *
 * These are used by executeWorkflow (and some by regenerateNode).
 */

import type {
  AnnotationNodeData,
  ArrayNodeData,
  MaskPainterNodeData,
  PromptConstructorNodeData,
  PromptNodeData,
  LLMGenerateNodeData,
  OutputNodeData,
  OutputGalleryNodeData,
  WorkflowNode,
  ImageCropNodeData,
  MirrorNodeData,
  CubemapEquirectNodeData,
  CubemapFacesNodeData,
  ColorGradeNodeData,
} from "@/types";
import type { NodeExecutionContext } from "./types";
import { parseTextToArray } from "@/utils/arrayParser";
import { parseVarTags } from "@/utils/parseVarTags";
import { cropImageToDataUrl } from "@/utils/cropImage";
import { mirrorImage } from "@/utils/mirrorImage";
import { applyCubemapEquirect, splitCubemap, combineCubemap, CUBE_FACES, type CubeFace } from "@/utils/cubemapEquirect";
import { applyGrade, coerceChannel } from "@/utils/colorGrade";
import { getSourceOutput } from "@/store/utils/connectedInputs";

/**
 * Annotation node: receives upstream image as source, passes through if no annotations.
 */
export async function executeAnnotation(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  try {
    const { images } = getConnectedInputs(node.id);
    const image = images[0] || null;
    if (image) {
      const nodeData = node.data as AnnotationNodeData;
      updateNodeData(node.id, { sourceImage: image, sourceImageRef: undefined });
      // Pass through the image if no annotations exist, or if the previous
      // output was itself a pass-through of the old source image
      if (!nodeData.outputImage || nodeData.outputImage === nodeData.sourceImage) {
        updateNodeData(node.id, { outputImage: image, outputImageRef: undefined });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] Annotation node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}

/**
 * Prompt node: receives upstream text and updates its prompt field.
 */
export async function executePrompt(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  try {
    const { text: connectedText } = getConnectedInputs(node.id);
    if (connectedText !== null) {
      updateNodeData(node.id, { prompt: connectedText });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] Prompt node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}

/**
 * Array node: splits connected text into itemized text outputs.
 */
export async function executeArray(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData, getFreshNode } = ctx;

  try {
    const freshNode = getFreshNode(node.id);
    const nodeData = (freshNode?.data || node.data) as ArrayNodeData;
    const { text: connectedText } = getConnectedInputs(node.id);
    const inputText = connectedText ?? nodeData.inputText ?? "";

    const parsed = parseTextToArray(inputText, {
      splitMode: nodeData.splitMode,
      delimiter: nodeData.delimiter,
      regexPattern: nodeData.regexPattern,
      trimItems: nodeData.trimItems,
      removeEmpty: nodeData.removeEmpty,
    });

    updateNodeData(node.id, {
      inputText,
      outputItems: parsed.items,
      outputText: JSON.stringify(parsed.items),
      error: parsed.error,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] Array node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}

/**
 * PromptConstructor node: resolves @variables from connected prompt nodes.
 */
export async function executePromptConstructor(ctx: NodeExecutionContext): Promise<void> {
  const { node, updateNodeData, getFreshNode, getEdges, getNodes } = ctx;
  try {
    // Get fresh node data from store
    const freshNode = getFreshNode(node.id);
    const nodeData = (freshNode?.data || node.data) as PromptConstructorNodeData;
    const template = nodeData.template;

    const edges = getEdges();
    const nodes = getNodes();

    // Find all connected text nodes
    const connectedTextNodes = edges
      .filter((e) => e.target === node.id && e.targetHandle === "text")
      .map((e) => nodes.find((n) => n.id === e.source))
      .filter((n): n is WorkflowNode => n !== undefined);

    // Build variable map: named variables from Prompt nodes take precedence
    const variableMap: Record<string, string> = {};
    connectedTextNodes.forEach((srcNode) => {
      if (srcNode.type === "prompt") {
        const promptData = srcNode.data as PromptNodeData;
        if (promptData.variableName) {
          variableMap[promptData.variableName] = promptData.prompt;
        }
      }
    });

    // Parse inline <var> tags from all connected text nodes
    connectedTextNodes.forEach((srcNode) => {
      let text: string | null = null;
      if (srcNode.type === "prompt") {
        text = (srcNode.data as PromptNodeData).prompt || null;
      } else if (srcNode.type === "llmGenerate") {
        text = (srcNode.data as LLMGenerateNodeData).outputText || null;
      } else if (srcNode.type === "promptConstructor") {
        const pcData = srcNode.data as PromptConstructorNodeData;
        text = pcData.outputText ?? pcData.template ?? null;
      }

      if (text) {
        const parsed = parseVarTags(text);
        parsed.forEach(({ name, value }) => {
          if (variableMap[name] === undefined) {
            variableMap[name] = value;
          }
        });
      }
    });

    // Find all @variable patterns in template
    const varPattern = /@(\w+)/g;
    const unresolvedVars: string[] = [];
    let resolvedText = template;

    // Replace @variables with values or track unresolved
    const matches = template.matchAll(varPattern);
    for (const match of matches) {
      const varName = match[1];
      if (variableMap[varName] !== undefined) {
        resolvedText = resolvedText.replaceAll(`@${varName}`, variableMap[varName]);
      } else {
        if (!unresolvedVars.includes(varName)) {
          unresolvedVars.push(varName);
        }
      }
    }

    updateNodeData(node.id, {
      outputText: resolvedText,
      unresolvedVars,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] PromptConstructor node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}

/**
 * Output node: displays final image/video result.
 */
export async function executeOutput(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData, saveDirectoryPath, getEdges, getNodes } = ctx;
  const { images, videos, audio, model3d } = getConnectedInputs(node.id);

  // Diagnostic logging to help debug cases where Output node stays empty
  if (images.length === 0 && videos.length === 0 && audio.length === 0 && !model3d) {
    const edges = getEdges();
    const nodes = getNodes();
    const incomingEdges = edges.filter((e) => e.target === node.id);
    const sourceInfo = incomingEdges.map((e) => {
      const src = nodes.find((n) => n.id === e.source);
      const srcData = src?.data as Record<string, unknown> | undefined;
      const contentKeys = srcData
        ? Object.entries(srcData)
            .filter(([, v]) => v != null && typeof v === "string" && (v as string).length > 0)
            .map(([k]) => k)
            .join(", ")
        : "none";
      return `${src?.type || "unknown"}(${e.source}) via ${e.sourceHandle}->${e.targetHandle} [has: ${contentKeys}]`;
    });
    console.warn(
      `[Workflow] Output node ${node.id}: No images, videos, audio, or 3D models received.`,
      `Connected sources: [${sourceInfo.join(", ")}]`
    );
  }

  // Check audio array first
  if (audio.length > 0) {
    const audioContent = audio[0];
    updateNodeData(node.id, {
      audio: audioContent,
      image: null,
      video: null,
      model3d: null,
      contentType: "audio",
    });
    return;
  }

  // Check 3D model
  if (model3d) {
    updateNodeData(node.id, {
      model3d: model3d,
      image: null,
      video: null,
      audio: null,
      contentType: "3d",
    });
    return;
  }

  // Check videos array (typed data from source)
  if (videos.length > 0) {
    const videoContent = videos[0];
    updateNodeData(node.id, {
      image: videoContent,
      video: videoContent,
      model3d: null,
      contentType: "video",
    });
  } else if (images.length > 0) {
    const content = images[0];
    // Fallback pattern matching for edge cases (video data that ended up in images array)
    const isVideoContent =
      content.startsWith("data:video/") ||
      content.includes(".mp4") ||
      content.includes(".webm") ||
      content.includes("fal.media");

    if (isVideoContent) {
      updateNodeData(node.id, {
        image: content,
        video: content,
        model3d: null,
        contentType: "video",
      });
    } else {
      updateNodeData(node.id, {
        image: content,
        video: null,
        model3d: null,
        contentType: "image",
      });
    }
  }
}

/**
 * OutputGallery node: accumulates images from upstream nodes.
 */
export async function executeOutputGallery(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  const { images } = getConnectedInputs(node.id);
  const galleryData = node.data as OutputGalleryNodeData;
  const existing = new Set(galleryData.images || []);
  const newImages = images.filter((img) => !existing.has(img));
  if (newImages.length > 0) {
    updateNodeData(node.id, {
      images: [...newImages, ...(galleryData.images || [])],
    });
  }
}

/**
 * ImageCompare node: takes two upstream images for side-by-side comparison.
 */
export async function executeImageCompare(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  const { images } = getConnectedInputs(node.id);
  updateNodeData(node.id, {
    imageA: images[0] || null,
    imageB: images[1] || null,
  });
}

/**
 * VideoCompare node: takes two upstream videos for side-by-side comparison.
 */
export async function executeVideoCompare(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  const { videos } = getConnectedInputs(node.id);
  updateNodeData(node.id, {
    videoA: videos[0] || null,
    videoB: videos[1] || null,
  });
}

/**
 * Extract a filename from a URL path, falling back to a default.
 */
function extractFilenameFromUrl(url: string, fallback = "generated.glb"): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const lastSegment = pathname.split("/").filter(Boolean).pop();
    if (lastSegment && lastSegment.includes(".")) {
      return lastSegment;
    }
  } catch {
    // ignore parse errors
  }
  return fallback;
}

/**
 * SPZ Viewer node: receives SPZ/PLY URL from upstream and stores it for the external viewer.
 */
export async function executeSpzViewer(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  const { model3d } = getConnectedInputs(node.id);
  if (model3d) {
    updateNodeData(node.id, {
      spzUrl: model3d,
      filename: extractFilenameFromUrl(model3d, "world.spz"),
    });
  }
}

/**
 * Panorama Viewer node: receives equirectangular panorama URL from upstream
 * and stores it for the external panorama viewer.
 */
export async function executePanoViewer(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  const { images } = getConnectedInputs(node.id);
  if (images.length > 0) {
    updateNodeData(node.id, {
      panoUrl: images[0],
    });
  }
}

/**
 * Router node: pure passthrough with brief status flash.
 */
export async function executeRouter(ctx: NodeExecutionContext): Promise<void> {
  // Router is pure passthrough — data flows via edge traversal in getConnectedInputs.
  // Brief status flash to show execution occurred.
  ctx.updateNodeData(ctx.node.id, { status: "loading" });
  await new Promise(resolve => setTimeout(resolve, 50));
  if (!ctx.signal?.aborted) {
    ctx.updateNodeData(ctx.node.id, { status: "complete" });
  }
}

/**
 * Switch node: pure passthrough with toggle-controlled routing.
 */
export async function executeSwitch(ctx: NodeExecutionContext): Promise<void> {
  // Switch is pure passthrough — data flows via edge traversal in getConnectedInputs.
  // Disabled outputs are filtered during traversal.
  ctx.updateNodeData(ctx.node.id, { status: "loading" });
  await new Promise(resolve => setTimeout(resolve, 50));
  if (!ctx.signal?.aborted) {
    ctx.updateNodeData(ctx.node.id, { status: "complete" });
  }
}

/**
 * ConditionalSwitch node: pure passthrough with text-based rule matching.
 */
export async function executeConditionalSwitch(ctx: NodeExecutionContext): Promise<void> {
  // ConditionalSwitch is pure passthrough — actual text matching happens during connectedInputs traversal.
  // Brief status flash to show execution occurred.
  ctx.updateNodeData(ctx.node.id, { status: "loading" });
  await new Promise(resolve => setTimeout(resolve, 50));
  if (!ctx.signal?.aborted) {
    ctx.updateNodeData(ctx.node.id, { status: "complete" });
  }
}

/**
 * GLB Viewer node: receives 3D model URL from upstream, fetches via server proxy and loads it.
 */
export async function executeGlbViewer(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData, signal } = ctx;
  const { model3d } = getConnectedInputs(node.id);
  if (model3d) {
    // Use server-side proxy to avoid CORS issues with remote CDN URLs
    try {
      const response = await fetch("/api/proxy-fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: model3d }),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        let errorDetail = `${response.status}`;
        try {
          const errJson = await response.json();
          if (errJson.error) errorDetail = errJson.error;
        } catch {
          // ignore json parse failure
        }
        throw new Error(`Failed to fetch 3D model: ${errorDetail}`);
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const filename = extractFilenameFromUrl(model3d);
      updateNodeData(node.id, {
        glbUrl: blobUrl,
        filename,
        capturedImage: null,
      });
    } catch (error) {
      // Don't set error state on abort
      if ((error instanceof DOMException && error.name === "AbortError") || signal?.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Workflow] GLB Viewer node ${node.id} failed to load 3D model:`, message);
      updateNodeData(node.id, { error: message });
    }
  }
}

/**
 * Mask Painter node: receives upstream image, sets as sourceImage.
 * Preserves outputMask if strokes exist (user has painted a mask).
 */
export async function executeMaskPainter(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  try {
    const { images } = getConnectedInputs(node.id);
    const image = images[0] || null;
    if (image) {
      const nodeData = node.data as MaskPainterNodeData;
      updateNodeData(node.id, { sourceImage: image });
      // If no strokes yet, no mask to output
      if (nodeData.strokes.length === 0) {
        updateNodeData(node.id, { outputMask: null });
      }
      // If strokes exist, keep the existing outputMask (user must re-open modal to regenerate)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] Mask Painter node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}

/**
 * Image Crop node: receives upstream image and applies the persisted crop region.
 * If no region is defined, passes the image through unchanged.
 * Crop region uses relative (0-1) coordinates so it adapts to any input resolution.
 */
export async function executeImageCrop(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  try {
    const { images } = getConnectedInputs(node.id);
    const incoming = images[0] || null;
    const nodeData = node.data as ImageCropNodeData;

    if (!incoming) {
      // No input — clear output
      if (nodeData.outputImage !== null) {
        updateNodeData(node.id, { outputImage: null, sourceImage: null });
      }
      return;
    }

    // Update sourceImage if changed
    if (incoming !== nodeData.sourceImage) {
      updateNodeData(node.id, { sourceImage: incoming, sourceImageRef: undefined });
    }

    // No crop region → passthrough
    if (!nodeData.cropRegion) {
      updateNodeData(node.id, { outputImage: incoming, outputImageRef: undefined });
      return;
    }

    // Apply the crop
    try {
      const cropped = await cropImageToDataUrl(incoming, nodeData.cropRegion);
      updateNodeData(node.id, { outputImage: cropped, outputImageRef: undefined });
    } catch (err) {
      console.error(`[Workflow] Image Crop failed:`, err);
      updateNodeData(node.id, { outputImage: incoming, outputImageRef: undefined });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] Image Crop node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}

/**
 * Execute a Mirror node: flip the incoming image horizontally, vertically,
 * or both, depending on the node's toggle state. Passthrough if neither
 * toggle is on.
 */
export async function executeMirror(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  try {
    const { images } = getConnectedInputs(node.id);
    const incoming = images[0] || null;
    const nodeData = node.data as MirrorNodeData;

    if (!incoming) {
      if (nodeData.outputImage !== null) {
        updateNodeData(node.id, { outputImage: null, sourceImage: null });
      }
      return;
    }

    if (incoming !== nodeData.sourceImage) {
      updateNodeData(node.id, { sourceImage: incoming, sourceImageRef: undefined });
    }

    const h = !!nodeData.flipHorizontal;
    const v = !!nodeData.flipVertical;
    if (!h && !v) {
      updateNodeData(node.id, { outputImage: incoming, outputImageRef: undefined });
      return;
    }

    try {
      const flipped = await mirrorImage(incoming, h, v);
      updateNodeData(node.id, { outputImage: flipped, outputImageRef: undefined });
    } catch (err) {
      console.error(`[Workflow] Mirror failed:`, err);
      updateNodeData(node.id, { outputImage: incoming, outputImageRef: undefined });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] Mirror node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}

/**
 * Cubemap ⇄ Equirectangular conversion executor.
 *   - cubeToEquirect: input is a 4×3 cube cross, output is 2:1 equirect.
 *   - equirectToCube: input is 2:1 equirect, output is 4×3 cube cross.
 */
export async function executeCubemapEquirect(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  try {
    const { images } = getConnectedInputs(node.id);
    const incoming = images[0] || null;
    const nodeData = node.data as CubemapEquirectNodeData;

    if (!incoming) {
      if (nodeData.outputImage !== null) {
        updateNodeData(node.id, { outputImage: null, sourceImage: null });
      }
      return;
    }

    if (incoming !== nodeData.sourceImage) {
      updateNodeData(node.id, { sourceImage: incoming, sourceImageRef: undefined });
    }

    try {
      const output = await applyCubemapEquirect(incoming, nodeData.mode, nodeData.outputSize);
      updateNodeData(node.id, { outputImage: output, outputImageRef: undefined });
    } catch (err) {
      console.error(`[Workflow] Cubemap/Equirect conversion failed:`, err);
      updateNodeData(node.id, { outputImage: incoming, outputImageRef: undefined });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] Cubemap/Equirect node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}

/**
 * Cubemap ⇄ 6 faces executor.
 *   - split  : 1 cross input → 6 face outputs
 *   - combine: 6 face inputs (by edge.targetHandle = up/down/left/right/front/back)
 *              → 1 cross output
 */
export async function executeCubemapFaces(ctx: NodeExecutionContext): Promise<void> {
  const { node, getNodes, getEdges, updateNodeData } = ctx;
  try {
    const nodeData = node.data as CubemapFacesNodeData;
    const allNodes = getNodes();
    const edges = getEdges();

    if (nodeData.mode === "split") {
      // Pull the upstream cross via the central helper.
      let cross: string | null = null;
      for (const edge of edges) {
        if (edge.target !== node.id) continue;
        if (edge.targetHandle !== "image" && edge.targetHandle != null) continue;
        const src = allNodes.find((n) => n.id === edge.source);
        if (!src) continue;
        const out = getSourceOutput(
          src,
          edge.sourceHandle,
          edge.data as Record<string, unknown> | undefined
        );
        if (out.type === "image" && out.value) {
          cross = out.value;
          break;
        }
      }

      if (!cross) {
        updateNodeData(node.id, {
          sourceImage: null,
          outputUp: null, outputDown: null, outputLeft: null,
          outputRight: null, outputFront: null, outputBack: null,
        });
        return;
      }

      if (cross !== nodeData.sourceImage) {
        updateNodeData(node.id, { sourceImage: cross, sourceImageRef: undefined });
      }

      try {
        const faces = await splitCubemap(cross, nodeData.outputSize);
        updateNodeData(node.id, {
          outputUp: faces.up,         outputUpRef: undefined,
          outputDown: faces.down,     outputDownRef: undefined,
          outputLeft: faces.left,     outputLeftRef: undefined,
          outputRight: faces.right,   outputRightRef: undefined,
          outputFront: faces.front,   outputFrontRef: undefined,
          outputBack: faces.back,     outputBackRef: undefined,
        });
      } catch (err) {
        console.error(`[Workflow] Cubemap split failed:`, err);
      }
      return;
    }

    // Combine mode: read up to six face inputs by edge.targetHandle.
    const faces: Partial<Record<CubeFace, string>> = {};
    for (const edge of edges) {
      if (edge.target !== node.id) continue;
      const handle = edge.targetHandle as CubeFace | null;
      if (!handle || !CUBE_FACES.includes(handle)) continue;
      const src = allNodes.find((n) => n.id === edge.source);
      if (!src) continue;
      const out = getSourceOutput(
        src,
        edge.sourceHandle,
        edge.data as Record<string, unknown> | undefined
      );
      if (out.type === "image" && out.value) faces[handle] = out.value;
    }

    if (Object.values(faces).every((v) => !v)) {
      updateNodeData(node.id, { outputCross: null });
      return;
    }

    try {
      const cross = await combineCubemap(faces, nodeData.outputSize);
      updateNodeData(node.id, { outputCross: cross, outputCrossRef: undefined });
    } catch (err) {
      console.error(`[Workflow] Cubemap combine failed:`, err);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] Cubemap Faces node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}

/**
 * Color Grade executor — applies the Nuke-style Grade formula to the
 * incoming image using the node's stored slider parameters.
 */
export async function executeColorGrade(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  try {
    const { images } = getConnectedInputs(node.id);
    const incoming = images[0] || null;
    const nodeData = node.data as ColorGradeNodeData;

    if (!incoming) {
      if (nodeData.outputImage !== null) {
        updateNodeData(node.id, { outputImage: null, sourceImage: null });
      }
      return;
    }

    if (incoming !== nodeData.sourceImage) {
      updateNodeData(node.id, { sourceImage: incoming, sourceImageRef: undefined });
    }

    try {
      const output = await applyGrade(incoming, {
        blackpoint: coerceChannel(nodeData.blackpoint, 0),
        whitepoint: coerceChannel(nodeData.whitepoint, 1),
        lift:       coerceChannel(nodeData.lift, 0),
        gain:       coerceChannel(nodeData.gain, 1),
        multiply:   coerceChannel(nodeData.multiply, 1),
        offset:     coerceChannel(nodeData.offset, 0),
        gamma:      coerceChannel(nodeData.gamma, 1),
      });
      updateNodeData(node.id, { outputImage: output, outputImageRef: undefined });
    } catch (err) {
      console.error(`[Workflow] Color Grade failed:`, err);
      updateNodeData(node.id, { outputImage: incoming, outputImageRef: undefined });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] Color Grade node ${node.id} failed:`, message);
    updateNodeData(node.id, { error: message });
  }
}
