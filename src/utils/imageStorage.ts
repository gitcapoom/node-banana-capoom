import { WorkflowNode, WorkflowNodeData } from "@/types";
import { WorkflowFile } from "@/store/workflowStore";
import { createImageThumbnail, createImageThumbnailWithMeta, thumbMaxDim } from "./createImageThumbnail";
import crypto from "crypto";

/**
 * Fetch with timeout support using AbortController
 * @param url - The URL to fetch
 * @param options - Fetch options (RequestInit)
 * @param timeout - Timeout in milliseconds (default: 30000ms / 30 seconds)
 * @returns Promise<Response>
 * @throws Error if the request times out or fails
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeout}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Compute MD5 hash of image content for deduplication
 * Consistent with save-generation API (Phase 13 decision)
 *
 * Fed in CHUNKS: this runs client-side on crypto-browserify, whose Buffer
 * polyfill converts a string via a plain byte array built with Array.push —
 * a single update() with a giant data URL (e.g. a large inline video) threw
 * "RangeError: Invalid array length" and killed auto-save. Chunking bounds
 * the per-call allocation; the digest is identical.
 */
function computeContentHash(data: string): string {
  const CHUNK = 8 * 1024 * 1024; // 8M chars per update
  const hash = crypto.createHash("md5");
  for (let i = 0; i < data.length; i += CHUNK) {
    hash.update(data.slice(i, i + CHUNK));
  }
  return hash.digest("hex");
}

/**
 * Generate a unique image ID for external storage
 */
export function generateImageId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `img-${timestamp}-${random}`;
}

/**
 * Check if a string is a base64 data URL
 */
function isBase64DataUrl(str: string | null | undefined): str is string {
  return typeof str === "string" && str.startsWith("data:");
}

/**
 * Cheap existence check: is `<workflowPath>/<folder>/<ref>.*` actually present in
 * THIS project? Used at save-time so a ref carried in from another project (via
 * copy-paste) gets re-saved here instead of left dangling.
 */
async function imageRefExists(workflowPath: string, ref: string, folder: "inputs" | "generations"): Promise<boolean> {
  try {
    const params = new URLSearchParams({ workflowPath, imageId: ref, folder, check: "1" });
    const res = await fetch(`/api/workflow-images?${params.toString()}`);
    if (!res.ok) return false;
    const j = await res.json();
    return !!j.exists;
  } catch {
    return false;
  }
}

/**
 * Externalize a NON-displayed image field: full-res data URL → file ref, no
 * thumbnail. For fields not shown in a node preview (color/mask/roto
 * `sourceImage`, comp's input mirrors). Mutates `next`.
 */
async function externalizeRefField(
  d: Record<string, unknown>,
  next: Record<string, unknown>,
  rawKey: string,
  refKey: string,
  workflowPath: string,
  savedImageIds: Map<string, string>,
  folder: "inputs" | "generations" = "inputs",
): Promise<void> {
  const raw = d[rawKey] as string | null | undefined;
  const existingRef = d[refKey] as string | undefined;
  if (existingRef && isBase64DataUrl(raw)) {
    if (await imageRefExists(workflowPath, existingRef, folder)) {
      next[rawKey] = null; // ref valid here — keep it
    } else {
      // Foreign ref (e.g. pasted from another project) — re-save into THIS project.
      next[refKey] = await saveImageAndGetId(raw, workflowPath, savedImageIds, folder);
      next[rawKey] = null;
    }
  } else if (isBase64DataUrl(raw)) {
    next[refKey] = await saveImageAndGetId(raw, workflowPath, savedImageIds, folder);
    next[rawKey] = null;
  }
}

/**
 * Externalize a DISPLAYED image field: full-res → file ref AND generate a small
 * inline thumbnail (kept in the JSON so opening the workflow shows a preview
 * without loading full-res). Mutates `next` (raw → null, ref + thumb set).
 *
 * `isBase64DataUrl(raw)` reliably means "raw is full-res" because hydrate never
 * writes a thumb into the raw field — so we always (re)generate the thumb from
 * the current full-res. When `raw` is null (the on-open lazy state) we leave the
 * existing thumb + ref untouched.
 */
async function externalizeDisplayField(
  d: Record<string, unknown>,
  next: Record<string, unknown>,
  rawKey: string,
  refKey: string,
  thumbKey: string,
  workflowPath: string,
  savedImageIds: Map<string, string>,
  folder: "inputs" | "generations" = "inputs",
  thumbFormat: "jpeg" | "png" = "jpeg",
): Promise<void> {
  const raw = d[rawKey] as string | null | undefined;
  const existingRef = d[refKey] as string | undefined;
  if (existingRef && isBase64DataUrl(raw) && await imageRefExists(workflowPath, existingRef, folder)) {
    // Hydrated/loaded full-res that already has a matching ref IN THIS PROJECT —
    // keep the ref, just make sure a thumb exists, then drop the heavy inline data.
    if (!d[thumbKey]) {
      try {
        const t = await createImageThumbnailWithMeta(raw, thumbMaxDim(), 0.72, thumbFormat);
        next[thumbKey] = t.thumb;
        // Source size, captured while the full-res is still decodable — this is
        // what the node's resolution readout reads back after a reload.
        next[`${rawKey}Dims`] = { width: t.width, height: t.height };
      } catch { /* leave thumb unset */ }
    }
    next[rawKey] = null;
  } else if (isBase64DataUrl(raw)) {
    // New / changed full-res, OR a foreign ref (pasted from another project whose
    // file isn't here) — (re)generate the thumb and save a fresh ref in THIS project.
    try {
      const t = await createImageThumbnailWithMeta(raw, thumbMaxDim(), 0.72, thumbFormat);
      next[thumbKey] = t.thumb;
      // Source size, captured while the full-res is still decodable — this is
      // what the node's resolution readout reads back after a reload.
      next[`${rawKey}Dims`] = { width: t.width, height: t.height };
    } catch { /* leave thumb unset */ }
    next[refKey] = await saveImageAndGetId(raw, workflowPath, savedImageIds, folder);
    next[rawKey] = null;
  }
  // raw == null → nothing to do (lazy on-open state).
}

/**
 * Extract and save all images from a workflow, replacing base64 data with refs
 * Returns a new workflow object with image refs instead of base64 data
 */
export async function externalizeWorkflowImages(
  workflow: WorkflowFile,
  workflowPath: string
): Promise<WorkflowFile> {
  const savedImageIds = new Map<string, string>(); // base64 hash -> imageId (for deduplication)

  // Process nodes in parallel batches with controlled concurrency
  const BATCH_SIZE = 3;
  const externalizedNodes: WorkflowNode[] = new Array(workflow.nodes.length);

  for (let i = 0; i < workflow.nodes.length; i += BATCH_SIZE) {
    const batch = workflow.nodes.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((node, batchIndex) =>
        externalizeNodeImages(node, workflowPath, savedImageIds)
          .then(result => ({ index: i + batchIndex, result }))
      )
    );

    for (const { index, result } of results) {
      externalizedNodes[index] = result;
    }
  }

  return {
    ...workflow,
    nodes: externalizedNodes,
  };
}

/**
 * Externalize images from a single node
 */
async function externalizeNodeImages(
  node: WorkflowNode,
  workflowPath: string,
  savedImageIds: Map<string, string>
): Promise<WorkflowNode> {
  const data = node.data as WorkflowNodeData;
  let newData: WorkflowNodeData;

  switch (node.type) {
    case "imageInput": {
      const d = data as import("@/types").ImageInputNodeData;
      const next: Record<string, unknown> = { ...d };

      await externalizeDisplayField(d, next, "image", "imageRef", "imageThumb", workflowPath, savedImageIds, "inputs");

      // outputImage is a pre-rendered mirror — only persist if a flip is active
      // (otherwise it's redundant; drop it and its thumb).
      const flipActive = !!d.flipHorizontal || !!d.flipVertical;
      if (!flipActive) {
        next.outputImage = null;
        next.outputImageRef = undefined;
        next.outputImageThumb = undefined;
      } else {
        await externalizeDisplayField(d, next, "outputImage", "outputImageRef", "outputImageThumb", workflowPath, savedImageIds, "inputs");
      }

      newData = next as import("@/types").ImageInputNodeData;
      break;
    }

    case "annotation": {
      const d = data as import("@/types").AnnotationNodeData;
      const next: Record<string, unknown> = { ...d };
      await externalizeDisplayField(d, next, "sourceImage", "sourceImageRef", "sourceImageThumb", workflowPath, savedImageIds, "inputs");
      await externalizeDisplayField(d, next, "outputImage", "outputImageRef", "outputImageThumb", workflowPath, savedImageIds, "inputs");
      newData = next as import("@/types").AnnotationNodeData;
      break;
    }

    case "imageCompare": {
      // A/B are full-res mirrors of the connected inputs; externalize them to
      // /inputs (ref + small thumb) so they don't bloat the workflow JSON.
      const d = data as import("@/types").ImageCompareNodeData;
      const next: Record<string, unknown> = { ...d };
      await externalizeDisplayField(d, next, "imageA", "imageARef", "imageAThumb", workflowPath, savedImageIds, "inputs");
      await externalizeDisplayField(d, next, "imageB", "imageBRef", "imageBThumb", workflowPath, savedImageIds, "inputs");
      newData = next as import("@/types").ImageCompareNodeData;
      break;
    }

    case "nanoBanana": {
      const d = data as import("@/types").NanoBananaNodeData;
      let outputImageRef = d.outputImageRef;
      let outputImage = d.outputImage;
      let inputImageRefs = d.inputImageRefs ? [...d.inputImageRefs] : [];
      const inputImages: string[] = [];

      // Handle output image - AI generated, save to generations
      // Use selectedHistoryIndex to get the correct history entry (not hardcoded 0)
      const selectedIndex = d.selectedHistoryIndex || 0;
      const expectedRef = d.imageHistory?.[selectedIndex]?.id;

      if (d.outputImageRef && isBase64DataUrl(d.outputImage)) {
        // Verify existing ref matches expected history ID
        if (d.outputImageRef === expectedRef) {
          outputImage = null; // Ref is correct, just clear base64
        } else {
          // Ref doesn't match history - re-save with correct ID
          outputImageRef = await saveImageAndGetId(d.outputImage, workflowPath, savedImageIds, "generations", expectedRef);
          outputImage = null;
        }
      } else if (isBase64DataUrl(d.outputImage)) {
        // No existing ref - save with expected history ID for consistency
        outputImageRef = await saveImageAndGetId(d.outputImage, workflowPath, savedImageIds, "generations", expectedRef);
        outputImage = null;
      }

      // Handle input images array (these come from connected nodes, save to inputs if present)
      // Skip if corresponding inputImageRef already exists
      for (let i = 0; i < (d.inputImages?.length || 0); i++) {
        const img = d.inputImages[i];
        const existingRef = d.inputImageRefs?.[i];
        if (existingRef && isBase64DataUrl(img)) {
          inputImages.push(""); // Already has ref, just clear the base64
        } else if (isBase64DataUrl(img)) {
          const ref = await saveImageAndGetId(img, workflowPath, savedImageIds, "inputs");
          inputImageRefs[i] = ref;
          inputImages.push(""); // Empty placeholder
        } else {
          inputImages.push(img);
        }
      }

      newData = {
        ...d,
        inputImages: inputImages.length > 0 && inputImages.every(i => i === "") ? [] : inputImages,
        inputImageRefs: inputImageRefs.length > 0 ? inputImageRefs : undefined,
        outputImage,
        outputImageRef,
      };
      break;
    }

    case "viewer": {
      // A Viewer is a DISPLAY tap: whatever it shows already exists on the node
      // upstream, and re-resolves from there the moment the graph loads. Saving
      // its own full-res copy duplicated tens of MB per viewer into the workflow
      // (one measured at 74MB). Keep a thumbnail for the pre-resolve preview and
      // drop the full-res — there is nothing to lose and no ref to write.
      const d = data as Record<string, unknown>;
      const raw = d.image as string | null | undefined;
      newData = d;
      if (isBase64DataUrl(raw)) {
        const next: Record<string, unknown> = { ...d, image: null, imageRef: undefined };
        try {
          const t = await createImageThumbnailWithMeta(raw!, thumbMaxDim(), 0.72, "png");
          next.imageThumb = t.thumb;
          next.imageDims = { width: t.width, height: t.height };
        } catch { /* keep whatever thumb is already there */ }
        newData = next;
      }
      break;
    }

    case "llmGenerate": {
      const d = data as import("@/types").LLMGenerateNodeData;
      let inputImageRefs = d.inputImageRefs ? [...d.inputImageRefs] : [];
      const inputImages: string[] = [];

      // Handle input images array (save to inputs)
      // Skip if corresponding inputImageRef already exists
      for (let i = 0; i < (d.inputImages?.length || 0); i++) {
        const img = d.inputImages[i];
        const existingRef = d.inputImageRefs?.[i];
        if (existingRef && isBase64DataUrl(img)) {
          inputImages.push(""); // Already has ref, just clear the base64
        } else if (isBase64DataUrl(img)) {
          const ref = await saveImageAndGetId(img, workflowPath, savedImageIds, "inputs");
          inputImageRefs[i] = ref;
          inputImages.push(""); // Empty placeholder
        } else {
          inputImages.push(img);
        }
      }

      // Conversation transcript. Every turn kept its images inline at FULL
      // resolution, so a long chat grew without bound — 398MB in one measured
      // workflow, dwarfing everything else in the file and sitting in memory for
      // the whole session. Each image becomes a ref (full-res on disk, loadable)
      // plus a thumbnail for the transcript UI, which is all the node renders.
      let conversation = d.conversation;
      if (Array.isArray(conversation) && conversation.length > 0) {
        conversation = await Promise.all(
          conversation.map(async (turn) => {
            if (!Array.isArray(turn.images) || turn.images.length === 0) return turn;
            const refs = turn.imageRefs ? [...turn.imageRefs] : [];
            const thumbs = turn.imageThumbs ? [...turn.imageThumbs] : [];
            for (let i = 0; i < turn.images.length; i++) {
              const img = turn.images[i];
              if (!isBase64DataUrl(img)) continue;
              if (!refs[i]) {
                refs[i] = await saveImageAndGetId(img, workflowPath, savedImageIds, "inputs");
              }
              if (!thumbs[i]) {
                try {
                  thumbs[i] = await createImageThumbnail(img, thumbMaxDim(), 0.72, "jpeg");
                } catch { /* transcript falls back to no preview */ }
              }
            }
            return { ...turn, images: [], imageRefs: refs, imageThumbs: thumbs };
          }),
        );
      }

      newData = {
        ...d,
        conversation,
        inputImages: inputImages.length > 0 && inputImages.every(i => i === "") ? [] : inputImages,
        inputImageRefs: inputImageRefs.length > 0 ? inputImageRefs : undefined,
      };
      break;
    }

    case "generateVideo": {
      const d = data as import("@/types").GenerateVideoNodeData;
      let inputImageRefs = d.inputImageRefs ? [...d.inputImageRefs] : [];
      const inputImages: string[] = [];
      let outputVideoRef = d.outputVideoRef;
      let outputVideo = d.outputVideo;
      let thumbnailImageRef = d.thumbnailImageRef;
      let thumbnailImage = d.thumbnailImage;

      // Handle input images array (save to inputs)
      // Skip if corresponding inputImageRef already exists
      for (let i = 0; i < (d.inputImages?.length || 0); i++) {
        const img = d.inputImages[i];
        const existingRef = d.inputImageRefs?.[i];
        if (existingRef && isBase64DataUrl(img)) {
          inputImages.push(""); // Already has ref, just clear the base64
        } else if (isBase64DataUrl(img)) {
          const ref = await saveImageAndGetId(img, workflowPath, savedImageIds, "inputs");
          inputImageRefs[i] = ref;
          inputImages.push(""); // Empty placeholder
        } else {
          inputImages.push(img);
        }
      }

      // Externalize output video — save to generations folder
      const selectedVideoIndex = d.selectedVideoHistoryIndex || 0;
      const expectedVideoRef = d.videoHistory?.[selectedVideoIndex]?.id;

      if (d.outputVideoRef && isBase64DataUrl(d.outputVideo)) {
        outputVideo = null; // Already has ref, just clear base64
      } else if (isBase64DataUrl(d.outputVideo)) {
        outputVideoRef = await saveImageAndGetId(d.outputVideo, workflowPath, savedImageIds, "generations", expectedVideoRef);
        outputVideo = null;
      }

      // Externalize thumbnail
      if (d.thumbnailImageRef && isBase64DataUrl(d.thumbnailImage)) {
        thumbnailImage = null;
      } else if (isBase64DataUrl(d.thumbnailImage)) {
        thumbnailImageRef = await saveImageAndGetId(d.thumbnailImage!, workflowPath, savedImageIds, "generations");
        thumbnailImage = null;
      }

      newData = {
        ...d,
        inputImages: inputImages.length > 0 && inputImages.every(i => i === "") ? [] : inputImages,
        inputImageRefs: inputImageRefs.length > 0 ? inputImageRefs : undefined,
        outputVideo,
        outputVideoRef,
        thumbnailImage,
        thumbnailImageRef,
      };
      break;
    }

    case "generateAudio": {
      const d = data as import("@/types").GenerateAudioNodeData;
      let outputAudioRef = d.outputAudioRef;
      let outputAudio = d.outputAudio;

      // Externalize output audio — save to generations folder
      const selectedAudioIndex = d.selectedAudioHistoryIndex || 0;
      const expectedAudioRef = d.audioHistory?.[selectedAudioIndex]?.id;

      if (d.outputAudioRef && isBase64DataUrl(d.outputAudio)) {
        outputAudio = null; // Already has ref, just clear base64
      } else if (isBase64DataUrl(d.outputAudio)) {
        outputAudioRef = await saveImageAndGetId(d.outputAudio, workflowPath, savedImageIds, "generations", expectedAudioRef);
        outputAudio = null;
      }

      newData = {
        ...d,
        outputAudio,
        outputAudioRef,
      };
      break;
    }

    case "output": {
      const d = data as import("@/types").OutputNodeData;
      // Output content is saved to /outputs during workflow execution, not here
      // Clear ALL media fields to keep workflow file small - outputs are re-pulled from upstream on load
      newData = { ...d, image: null, imageRef: undefined, video: null, model3d: null, audio: null };
      break;
    }

    case "splitGrid": {
      const d = data as import("@/types").SplitGridNodeData;
      // SplitGrid source is input content, save to inputs
      // Skip if already has ref (prevents duplicates on re-save after hydration)
      if (d.sourceImageRef && isBase64DataUrl(d.sourceImage)) {
        newData = { ...d, sourceImage: null };
      } else if (isBase64DataUrl(d.sourceImage)) {
        const imageId = await saveImageAndGetId(d.sourceImage, workflowPath, savedImageIds, "inputs");
        newData = { ...d, sourceImage: null, sourceImageRef: imageId };
      } else {
        newData = d;
      }
      break;
    }

    case "videoInput": {
      const d = data as import("@/types").VideoInputNodeData;
      let videoFileRef = d.videoFileRef;
      let videoFile = d.videoFile;
      let thumbnailImageRef = d.thumbnailImageRef;
      let thumbnailImage = d.thumbnailImage;

      // Externalize video file
      if (d.videoFileRef && isBase64DataUrl(d.videoFile)) {
        videoFile = null;
      } else if (isBase64DataUrl(d.videoFile)) {
        videoFileRef = await saveImageAndGetId(d.videoFile, workflowPath, savedImageIds, "inputs");
        videoFile = null;
      }

      // Externalize thumbnail
      if (d.thumbnailImageRef && isBase64DataUrl(d.thumbnailImage)) {
        thumbnailImage = null;
      } else if (isBase64DataUrl(d.thumbnailImage)) {
        thumbnailImageRef = await saveImageAndGetId(d.thumbnailImage!, workflowPath, savedImageIds, "inputs");
        thumbnailImage = null;
      }

      newData = { ...d, videoFile, videoFileRef, thumbnailImage, thumbnailImageRef };
      break;
    }

    case "generate3d": {
      const d = data as import("@/types").Generate3DNodeData;
      let thumbnailImageRef = d.thumbnailImageRef;
      let thumbnailImage = d.thumbnailImage;

      if (d.thumbnailImageRef && isBase64DataUrl(d.thumbnailImage)) {
        thumbnailImage = null;
      } else if (isBase64DataUrl(d.thumbnailImage)) {
        thumbnailImageRef = await saveImageAndGetId(d.thumbnailImage!, workflowPath, savedImageIds, "generations");
        thumbnailImage = null;
      }

      // Also externalize inputImages (same pattern as nanoBanana)
      let inputImageRefs = d.inputImageRefs ? [...d.inputImageRefs] : [];
      const inputImages = [...d.inputImages];
      for (let i = 0; i < inputImages.length; i++) {
        if (isBase64DataUrl(inputImages[i])) {
          const existingRef = inputImageRefs[i];
          if (existingRef) {
            inputImages[i] = "";
          } else {
            const ref = await saveImageAndGetId(inputImages[i], workflowPath, savedImageIds, "inputs");
            inputImageRefs[i] = ref;
            inputImages[i] = "";
          }
        }
      }

      newData = { ...d, thumbnailImage, thumbnailImageRef, inputImages, inputImageRefs, output3dUrl: null };
      break;
    }

    case "image2GS": {
      const d = data as import("@/types").Image2GSNodeData;
      // Drop only the ephemeral blob: output URL — it's dead after a reload, and
      // the node re-hydrates output3dUrl from model3dHistory on mount. Keep the
      // cached RGB so it survives as an execution fallback.
      newData = { ...d, output3dUrl: null };
      break;
    }

    case "glbViewer": {
      const d = data as import("@/types").GLBViewerNodeData;
      let capturedImageRef = d.capturedImageRef;
      let capturedImage = d.capturedImage;
      let thumbnailImageRef = d.thumbnailImageRef;
      let thumbnailImage = d.thumbnailImage;
      let glbFileRef = d.glbFileRef;

      if (d.capturedImageRef && isBase64DataUrl(d.capturedImage)) {
        capturedImage = null;
      } else if (isBase64DataUrl(d.capturedImage)) {
        capturedImageRef = await saveImageAndGetId(d.capturedImage!, workflowPath, savedImageIds, "inputs");
        capturedImage = null;
      }

      if (d.thumbnailImageRef && isBase64DataUrl(d.thumbnailImage)) {
        thumbnailImage = null;
      } else if (isBase64DataUrl(d.thumbnailImage)) {
        thumbnailImageRef = await saveImageAndGetId(d.thumbnailImage!, workflowPath, savedImageIds, "inputs");
        thumbnailImage = null;
      }

      // Fallback: save GLB file from blob URL if glbFileRef was never set
      // (e.g. saveDirectoryPath was null at upload time, or save failed due to MIME type)
      if (!glbFileRef && d.glbUrl && d.glbUrl.startsWith("blob:")) {
        try {
          const response = await fetch(d.glbUrl);
          const blob = await response.blob();
          // Re-wrap with explicit MIME type for correct file extension
          const glbBlob = new Blob([blob], { type: "model/gltf-binary" });
          const glbDataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(glbBlob);
          });
          glbFileRef = await saveImageAndGetId(glbDataUrl, workflowPath, savedImageIds, "inputs");
        } catch (error) {
          console.warn("Failed to save GLB file during externalization:", error);
        }
      }

      // Clear blob URL (cannot persist across reloads); glbFileRef preserves the file on disk
      newData = { ...d, capturedImage, capturedImageRef, thumbnailImage, thumbnailImageRef, glbUrl: null, glbFileRef };
      break;
    }

    case "panoCrop": {
      const d = data as import("@/types").PanoCropNodeData;
      if (d.imageRef && isBase64DataUrl(d.image)) {
        newData = { ...d, image: null };
      } else if (isBase64DataUrl(d.image)) {
        const imageId = await saveImageAndGetId(d.image, workflowPath, savedImageIds, "inputs");
        newData = { ...d, image: null, imageRef: imageId };
      } else {
        newData = d;
      }
      break;
    }

    case "maskPainter": {
      // sourceImage isn't shown in the preview (the matte is) → ref only.
      // outputMask is the displayed field → ref + inline PNG thumb (alpha).
      const d = data as import("@/types").MaskPainterNodeData;
      const next: Record<string, unknown> = { ...d };
      await externalizeRefField(d, next, "sourceImage", "sourceImageRef", workflowPath, savedImageIds, "inputs");
      await externalizeDisplayField(d, next, "outputMask", "outputMaskRef", "outputMaskThumb", workflowPath, savedImageIds, "inputs", "png");
      newData = next as import("@/types").MaskPainterNodeData;
      break;
    }

    case "roto": {
      // Externalize the (large) source image + output matte to files. The vector
      // `shapes` stay inline (small) and are the real source of truth — `...d`
      // preserves them and every other field. The matte gets a PNG thumb.
      const d = data as import("@/types").RotoNodeData;
      const next: Record<string, unknown> = { ...d };
      await externalizeRefField(d, next, "sourceImage", "sourceImageRef", workflowPath, savedImageIds, "inputs");
      await externalizeDisplayField(d, next, "outputMask", "outputMaskRef", "outputMaskThumb", workflowPath, savedImageIds, "inputs", "png");
      newData = next as import("@/types").RotoNodeData;
      break;
    }

    case "imageCrop": {
      const d = data as import("@/types").ImageCropNodeData;
      const next: Record<string, unknown> = { ...d };
      await externalizeDisplayField(d, next, "sourceImage", "sourceImageRef", "sourceImageThumb", workflowPath, savedImageIds, "inputs");
      await externalizeDisplayField(d, next, "outputImage", "outputImageRef", "outputImageThumb", workflowPath, savedImageIds, "inputs");
      newData = next as import("@/types").ImageCropNodeData;
      break;
    }

    case "upscaleGrid": {
      const d = data as import("@/types").UpscaleGridNodeData;
      const next: Record<string, unknown> = { ...d };
      // Output already baked into the generations folder by the executor; this
      // re-externalizes only if a run rehydrated outputImage to a data URL.
      await externalizeDisplayField(d, next, "outputImage", "outputImageRef", "outputImageThumb", workflowPath, savedImageIds, "generations");
      newData = next as import("@/types").UpscaleGridNodeData;
      break;
    }

    case "mirror": {
      const d = data as import("@/types").MirrorNodeData;
      const next: Record<string, unknown> = { ...d };
      await externalizeDisplayField(d, next, "sourceImage", "sourceImageRef", "sourceImageThumb", workflowPath, savedImageIds, "inputs");
      await externalizeDisplayField(d, next, "outputImage", "outputImageRef", "outputImageThumb", workflowPath, savedImageIds, "inputs");
      newData = next as import("@/types").MirrorNodeData;
      break;
    }

    case "cubemapEquirect": {
      const d = data as import("@/types").CubemapEquirectNodeData;
      const next: Record<string, unknown> = { ...d };
      await externalizeDisplayField(d, next, "sourceImage", "sourceImageRef", "sourceImageThumb", workflowPath, savedImageIds, "inputs");
      await externalizeDisplayField(d, next, "outputImage", "outputImageRef", "outputImageThumb", workflowPath, savedImageIds, "inputs");
      newData = next as import("@/types").CubemapEquirectNodeData;
      break;
    }

    case "cubemapFaces": {
      const d = data as import("@/types").CubemapFacesNodeData;
      const next: Record<string, unknown> = { ...d };

      const externalize = async (
        rawKey: keyof import("@/types").CubemapFacesNodeData,
        refKey: keyof import("@/types").CubemapFacesNodeData
      ) => {
        const raw = d[rawKey] as string | null | undefined;
        const existingRef = d[refKey] as string | undefined;
        if (existingRef && isBase64DataUrl(raw)) {
          next[rawKey] = null;
        } else if (isBase64DataUrl(raw)) {
          next[refKey] = await saveImageAndGetId(raw!, workflowPath, savedImageIds, "inputs");
          next[rawKey] = null;
        }
      };

      await externalize("sourceImage", "sourceImageRef");
      await externalize("outputUp", "outputUpRef");
      await externalize("outputDown", "outputDownRef");
      await externalize("outputLeft", "outputLeftRef");
      await externalize("outputRight", "outputRightRef");
      await externalize("outputFront", "outputFrontRef");
      await externalize("outputBack", "outputBackRef");
      await externalize("outputCross", "outputCrossRef");

      newData = next as import("@/types").CubemapFacesNodeData;
      break;
    }

    // colorGrade / hsvCorrect / contrastAdjust: the node preview shows the
    // committed `outputImage` (thumbed); `sourceImage` is never displayed → ref
    // only. ( ...d keeps every other field, e.g. hsv params, grade channels.)
    case "colorGrade":
    case "hsvCorrect":
    case "contrastAdjust": {
      const d = data as import("@/types").ColorGradeNodeData;
      const next: Record<string, unknown> = { ...d };
      await externalizeRefField(d, next, "sourceImage", "sourceImageRef", workflowPath, savedImageIds, "inputs");
      await externalizeDisplayField(d, next, "outputImage", "outputImageRef", "outputImageThumb", workflowPath, savedImageIds, "inputs");
      newData = next as import("@/types").ColorGradeNodeData;
      break;
    }

    // reformat is a transform node — it shows the source as a fallback before
    // it has computed output, so both fields are thumbed.
    case "reformat": {
      const d = data as import("@/types").ReformatNodeData;
      const next: Record<string, unknown> = { ...d };
      await externalizeDisplayField(d, next, "sourceImage", "sourceImageRef", "sourceImageThumb", workflowPath, savedImageIds, "inputs");
      await externalizeDisplayField(d, next, "outputImage", "outputImageRef", "outputImageThumb", workflowPath, savedImageIds, "inputs");
      newData = next as import("@/types").ReformatNodeData;
      break;
    }

    case "comp": {
      const d = data as import("@/types").CompNodeData;
      const next: Record<string, unknown> = { ...d };
      // The 5 input mirrors are re-derived from the connected upstream nodes on
      // open / run (their pixels are already persisted by those upstream nodes),
      // so we must NOT persist them here. CompNode clears each input's ref every
      // time it re-mirrors, so externalizing them re-saved a fresh copy on every
      // save — steadily bloating the inputs folder with orphaned duplicates.
      // Drop them; the node + executor rebuild them from the edges.
      next.bgImage = null; next.bgImageRef = undefined;
      next.bgAlphaImage = null; next.bgAlphaImageRef = undefined;
      next.fgImage = null; next.fgImageRef = undefined;
      next.fgAlphaImage = null; next.fgAlphaImageRef = undefined;
      next.matteImage = null; next.matteImageRef = undefined;
      // The composited output IS displayed → keep it (ref + inline PNG thumb).
      await externalizeDisplayField(d, next, "outputImage", "outputImageRef", "outputImageThumb", workflowPath, savedImageIds, "inputs", "png");
      newData = next as import("@/types").CompNodeData;
      break;
    }

    case "panoShift": {
      const d = data as import("@/types").PanoShiftNodeData;
      const next: Record<string, unknown> = { ...d };
      await externalizeDisplayField(d, next, "sourceImage", "sourceImageRef", "sourceImageThumb", workflowPath, savedImageIds, "inputs");
      await externalizeDisplayField(d, next, "outputImage", "outputImageRef", "outputImageThumb", workflowPath, savedImageIds, "inputs");
      newData = next as import("@/types").PanoShiftNodeData;
      break;
    }

    default:
      newData = data;
  }

  return {
    ...node,
    data: newData,
  } as WorkflowNode;
}

// In-flight saves guard to prevent duplicate concurrent uploads of the same image
const inFlightSaves = new Map<string, Promise<string>>();

/**
 * Save an image and return its ID (with deduplication)
 * @param folder - "inputs" for user-uploaded images, "generations" for AI-generated images
 * @param existingId - Optional ID to use instead of generating a new one (for consistency with history)
 */
async function saveImageAndGetId(
  imageData: string,
  workflowPath: string,
  savedImageIds: Map<string, string>,
  folder: "inputs" | "generations" = "inputs",
  existingId?: string
): Promise<string> {
  // Use MD5 hash for reliable deduplication (consistent with save-generation API, Phase 13 decision)
  // Include folder in hash so same image in different folders gets different IDs
  const contentHash = computeContentHash(imageData);
  const hash = `${folder}-${contentHash}`;

  // Skip deduplication if an explicit ID is requested - we must use that exact ID
  // to maintain consistency with imageHistory. Otherwise, deduplicate by content.
  if (!existingId && savedImageIds.has(hash)) {
    return savedImageIds.get(hash)!;
  }

  // Check if there's already an in-flight save for this hash
  if (!existingId && inFlightSaves.has(hash)) {
    return inFlightSaves.get(hash)!;
  }

  // Use existing ID if provided (for consistency with imageHistory). Otherwise
  // derive the id from the CONTENT (content-addressed): identical content always
  // maps to one file, so nodes that re-mirror + re-save the same input on every
  // save (color/contrast/hsv/annotation/crop) reuse that file instead of piling
  // up duplicate copies in the folder.
  const imageId = existingId || `img-${contentHash}`;

  const savePromise = (async () => {
    const response = await fetchWithTimeout(
      "/api/workflow-images",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowPath,
          imageId,
          imageData,
          folder,
        }),
      }
    );

    const result = await response.json();

    if (!result.success) {
      throw new Error(`Failed to save image: ${result.error}`);
    }

    savedImageIds.set(hash, imageId);
    return imageId;
  })();

  if (!existingId) {
    inFlightSaves.set(hash, savePromise);
  }

  try {
    return await savePromise;
  } catch (error) {
    throw error;
  } finally {
    inFlightSaves.delete(hash);
  }
}

/**
 * Convert a base64 data URL to a blob Object URL.
 * Used to restore binary files (e.g. GLB models) as blob URLs after workflow reload.
 */
function dataUrlToObjectUrl(dataUrl: string): string | null {
  try {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    const [, mime, base64] = match;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/**
 * Load all external images into a workflow, replacing refs with base64 data
 * Returns a new workflow object with base64 data instead of refs
 */
export async function hydrateWorkflowImages(
  workflow: WorkflowFile,
  workflowPath: string
): Promise<WorkflowFile> {
  const loadedImages = new Map<string, string>(); // imageId -> base64 (for caching)

  // Hydrate all nodes in parallel — the browser caps concurrent connections to
  // the same host (~6), so this naturally throttles while being far faster than
  // loading every image serially. Shared image ids dedup via inFlightLoads.
  const hydratedNodes = await Promise.all(
    workflow.nodes.map((node) => hydrateNodeImages(node, workflowPath, loadedImages)),
  );

  return {
    ...workflow,
    nodes: hydratedNodes,
  };
}

/**
 * Hydrate images for a single node
 */
async function hydrateNodeImages(
  node: WorkflowNode,
  workflowPath: string,
  loadedImages: Map<string, string>
): Promise<WorkflowNode> {
  const data = node.data as WorkflowNodeData;
  let newData: WorkflowNodeData;

  switch (node.type) {
    // Lazy full-res: image fields are NOT loaded on open. The inline thumb
    // (image/outputImage…Thumb) drives the preview; full-res loads on demand
    // (double-click / run) via useFullResField + the execution pre-pass.
    case "imageInput":
    case "annotation":
    case "imageCompare": {
      newData = data;
      break;
    }

    case "nanoBanana": {
      const d = data as import("@/types").NanoBananaNodeData;
      let outputImage = d.outputImage;
      const inputImages = [...(d.inputImages || [])];

      if (d.outputImageRef && !d.outputImage) {
        outputImage = await loadImageById(d.outputImageRef, workflowPath, loadedImages, "generations");
      }

      // Hydrate input images from refs
      if (d.inputImageRefs && d.inputImageRefs.length > 0) {
        for (let i = 0; i < d.inputImageRefs.length; i++) {
          const ref = d.inputImageRefs[i];
          if (ref) {
            inputImages[i] = await loadImageById(ref, workflowPath, loadedImages, "inputs");
          }
        }
      }

      newData = {
        ...d,
        inputImages,
        outputImage,
      };
      break;
    }

    case "llmGenerate": {
      const d = data as import("@/types").LLMGenerateNodeData;
      const inputImages = [...(d.inputImages || [])];

      // Hydrate input images from refs
      if (d.inputImageRefs && d.inputImageRefs.length > 0) {
        for (let i = 0; i < d.inputImageRefs.length; i++) {
          const ref = d.inputImageRefs[i];
          if (ref) {
            inputImages[i] = await loadImageById(ref, workflowPath, loadedImages, "inputs");
          }
        }
      }

      newData = {
        ...d,
        inputImages,
      };
      break;
    }

    case "generateVideo": {
      const d = data as import("@/types").GenerateVideoNodeData;
      const inputImages = [...(d.inputImages || [])];

      // Hydrate input images from refs
      if (d.inputImageRefs && d.inputImageRefs.length > 0) {
        for (let i = 0; i < d.inputImageRefs.length; i++) {
          const ref = d.inputImageRefs[i];
          if (ref) {
            inputImages[i] = await loadImageById(ref, workflowPath, loadedImages, "inputs");
          }
        }
      }

      // Hydrate thumbnail from ref (don't load full video — loaded on-demand in overlay)
      let thumbnailImage = d.thumbnailImage;
      if (!thumbnailImage && d.thumbnailImageRef) {
        thumbnailImage = await loadImageById(d.thumbnailImageRef, workflowPath, loadedImages, "generations");
      }
      // Fallback: try _thumb convention from history item
      if (!thumbnailImage && d.outputVideoRef) {
        const thumbId = `${d.outputVideoRef}_thumb`;
        const thumb = await loadImageById(thumbId, workflowPath, loadedImages, "generations");
        if (thumb) thumbnailImage = thumb;
      }

      newData = {
        ...d,
        inputImages,
        outputVideo: null, // Don't hydrate full video — loaded on-demand in overlay
        thumbnailImage,
      };
      break;
    }

    case "generateAudio": {
      const d = data as import("@/types").GenerateAudioNodeData;

      // Hydrate audio from ref
      let outputAudio = d.outputAudio;
      if (d.outputAudioRef && !d.outputAudio) {
        outputAudio = await loadImageById(d.outputAudioRef, workflowPath, loadedImages, "generations");
      }

      newData = {
        ...d,
        outputAudio,
      };
      break;
    }

    case "output": {
      // Output content is not persisted - it's regenerated on each workflow run
      // and saved to /outputs directory during execution
      newData = data;
      break;
    }

    case "splitGrid": {
      const d = data as import("@/types").SplitGridNodeData;
      if (d.sourceImageRef && !d.sourceImage) {
        const sourceImage = await loadImageById(d.sourceImageRef, workflowPath, loadedImages, "inputs");
        newData = {
          ...d,
          sourceImage,
        };
      } else {
        newData = d;
      }
      break;
    }

    case "videoInput": {
      const d = data as import("@/types").VideoInputNodeData;
      let thumbnailImage = d.thumbnailImage;

      // Hydrate thumbnail only — full video is loaded on-demand in overlay
      if (d.thumbnailImageRef && !d.thumbnailImage) {
        thumbnailImage = await loadImageById(d.thumbnailImageRef, workflowPath, loadedImages, "inputs");
      }

      newData = {
        ...d,
        videoFile: null, // Don't hydrate full video — loaded on-demand in overlay
        thumbnailImage,
      };
      break;
    }

    case "generate3d": {
      const d = data as import("@/types").Generate3DNodeData;
      let thumbnailImage = d.thumbnailImage;
      const inputImages = [...(d.inputImages || [])];

      // Hydrate thumbnail
      if (d.thumbnailImageRef && !d.thumbnailImage) {
        thumbnailImage = await loadImageById(d.thumbnailImageRef, workflowPath, loadedImages, "generations");
      }

      // Hydrate input images from refs
      if (d.inputImageRefs && d.inputImageRefs.length > 0) {
        for (let i = 0; i < d.inputImageRefs.length; i++) {
          const ref = d.inputImageRefs[i];
          if (ref) {
            inputImages[i] = await loadImageById(ref, workflowPath, loadedImages, "inputs");
          }
        }
      }

      newData = {
        ...d,
        thumbnailImage,
        inputImages,
      };
      break;
    }

    case "glbViewer": {
      const d = data as import("@/types").GLBViewerNodeData;
      let capturedImage = d.capturedImage;
      let thumbnailImage = d.thumbnailImage;

      if (d.capturedImageRef && !d.capturedImage) {
        capturedImage = await loadImageById(d.capturedImageRef, workflowPath, loadedImages, "inputs");
      }
      if (d.thumbnailImageRef && !d.thumbnailImage) {
        thumbnailImage = await loadImageById(d.thumbnailImageRef, workflowPath, loadedImages, "inputs");
      }

      // GLB file (glbUrl) is NOT hydrated here — the component self-hydrates
      // via useEffect (matching Generate3DNode's pattern) so that the React Flow
      // re-render triggers handle position re-computation for edge rendering.

      newData = {
        ...d,
        capturedImage,
        thumbnailImage,
      };
      break;
    }

    case "panoCrop": {
      const d = data as import("@/types").PanoCropNodeData;
      if (d.imageRef && !d.image) {
        const image = await loadImageById(d.imageRef, workflowPath, loadedImages, "inputs");
        newData = {
          ...d,
          image,
        };
      } else {
        newData = d;
      }
      break;
    }

    // Lazy: matte preview comes from outputMaskThumb; sourceImage + full-res
    // matte load on demand (editor open / run).
    case "maskPainter":
    case "roto": {
      newData = data;
      break;
    }

    case "videoInput": {
      const d = data as import("@/types").VideoInputNodeData;
      let videoFile = d.videoFile;
      let thumbnailImage = d.thumbnailImage;

      if (d.videoFileRef && !d.videoFile) {
        videoFile = await loadImageById(d.videoFileRef, workflowPath, loadedImages, "inputs");
      }
      if (d.thumbnailImageRef && !d.thumbnailImage) {
        thumbnailImage = await loadImageById(d.thumbnailImageRef, workflowPath, loadedImages, "inputs");
      }

      newData = {
        ...d,
        videoFile,
        thumbnailImage,
      };
      break;
    }

    // Lazy: source/output thumbs drive the preview; full-res on demand.
    case "imageCrop":
    case "mirror":
    case "cubemapEquirect": {
      newData = data;
      break;
    }

    case "cubemapFaces": {
      const d = data as import("@/types").CubemapFacesNodeData;
      const next: Record<string, unknown> = { ...d };

      const hydrate = async (
        rawKey: keyof import("@/types").CubemapFacesNodeData,
        refKey: keyof import("@/types").CubemapFacesNodeData
      ) => {
        const raw = d[rawKey] as string | null | undefined;
        const ref = d[refKey] as string | undefined;
        if (ref && !raw) {
          next[rawKey] = await loadImageById(ref, workflowPath, loadedImages, "inputs");
        }
      };

      await hydrate("sourceImage", "sourceImageRef");
      await hydrate("outputUp", "outputUpRef");
      await hydrate("outputDown", "outputDownRef");
      await hydrate("outputLeft", "outputLeftRef");
      await hydrate("outputRight", "outputRightRef");
      await hydrate("outputFront", "outputFrontRef");
      await hydrate("outputBack", "outputBackRef");
      await hydrate("outputCross", "outputCrossRef");

      newData = next as import("@/types").CubemapFacesNodeData;
      break;
    }

    // Lazy: color nodes show outputImageThumb; comp shows outputImageThumb and
    // re-derives its inputs from upstream. Full-res loads on edit / run.
    case "colorGrade":
    case "hsvCorrect":
    case "contrastAdjust":
    case "reformat":
    case "comp":
    case "panoShift": {
      newData = data;
      break;
    }

    default:
      newData = data;
  }

  return {
    ...node,
    data: newData,
  } as WorkflowNode;
}

/**
 * Load an image by ID (with caching)
 * @param folder - Optional hint for which folder to check first
 */
// In-flight loads guard so parallel hydration doesn't fetch the same id twice
// (content-hash dedup means several nodes can reference one image file).
const inFlightLoads = new Map<string, Promise<string>>();

async function loadImageById(
  imageId: string,
  workflowPath: string,
  loadedImages: Map<string, string>,
  folder?: "inputs" | "generations"
): Promise<string> {
  if (loadedImages.has(imageId)) {
    return loadedImages.get(imageId)!;
  }

  const key = `${workflowPath}::${folder ?? ""}::${imageId}`;
  const existing = inFlightLoads.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<string> => {
    try {
      const params = new URLSearchParams({ workflowPath, imageId });
      if (folder) params.set("folder", folder);
      const response = await fetch(`/api/workflow-images?${params.toString()}`);
      const result = await response.json();
      if (!result.success) {
        // Missing images are expected when refs point to deleted/moved files
        console.log(`Image not found: ${imageId}`);
        return ""; // Return empty string to avoid breaking the workflow
      }
      loadedImages.set(imageId, result.image);
      return result.image;
    } finally {
      inFlightLoads.delete(key);
    }
  })();

  inFlightLoads.set(key, promise);
  return promise;
}
