import { WorkflowNode, WorkflowNodeData } from "@/types";
import { WorkflowFile } from "@/store/workflowStore";
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
 */
function computeContentHash(data: string): string {
  return crypto.createHash("md5").update(data).digest("hex");
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
      // Skip if already has a valid imageRef (prevents duplicates on re-save after hydration)
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

    case "annotation": {
      const d = data as import("@/types").AnnotationNodeData;
      let sourceImageRef = d.sourceImageRef;
      let outputImageRef = d.outputImageRef;
      let sourceImage = d.sourceImage;
      let outputImage = d.outputImage;

      // Annotation images are user-created, save to inputs
      // Skip if already has ref (prevents duplicates on re-save after hydration)
      if (d.sourceImageRef && isBase64DataUrl(d.sourceImage)) {
        sourceImage = null;
      } else if (isBase64DataUrl(d.sourceImage)) {
        sourceImageRef = await saveImageAndGetId(d.sourceImage, workflowPath, savedImageIds, "inputs");
        sourceImage = null;
      }
      if (d.outputImageRef && isBase64DataUrl(d.outputImage)) {
        outputImage = null;
      } else if (isBase64DataUrl(d.outputImage)) {
        outputImageRef = await saveImageAndGetId(d.outputImage, workflowPath, savedImageIds, "inputs");
        outputImage = null;
      }

      newData = {
        ...d,
        sourceImage,
        sourceImageRef,
        outputImage,
        outputImageRef,
      };
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

      newData = {
        ...d,
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
      const d = data as import("@/types").MaskPainterNodeData;
      let sourceImageRef = d.sourceImageRef;
      let sourceImage = d.sourceImage;
      let outputMaskRef = d.outputMaskRef;
      let outputMask = d.outputMask;

      // Externalize source image
      if (d.sourceImageRef && isBase64DataUrl(d.sourceImage)) {
        sourceImage = null;
      } else if (isBase64DataUrl(d.sourceImage)) {
        sourceImageRef = await saveImageAndGetId(d.sourceImage!, workflowPath, savedImageIds, "inputs");
        sourceImage = null;
      }

      // Externalize output mask
      if (d.outputMaskRef && isBase64DataUrl(d.outputMask)) {
        outputMask = null;
      } else if (isBase64DataUrl(d.outputMask)) {
        outputMaskRef = await saveImageAndGetId(d.outputMask!, workflowPath, savedImageIds, "inputs");
        outputMask = null;
      }

      newData = { ...d, sourceImage, sourceImageRef, outputMask, outputMaskRef };
      break;
    }

    case "imageCrop": {
      const d = data as import("@/types").ImageCropNodeData;
      let sourceImageRef = d.sourceImageRef;
      let outputImageRef = d.outputImageRef;
      let sourceImage = d.sourceImage;
      let outputImage = d.outputImage;

      if (d.sourceImageRef && isBase64DataUrl(d.sourceImage)) {
        sourceImage = null;
      } else if (isBase64DataUrl(d.sourceImage)) {
        sourceImageRef = await saveImageAndGetId(d.sourceImage!, workflowPath, savedImageIds, "inputs");
        sourceImage = null;
      }

      if (d.outputImageRef && isBase64DataUrl(d.outputImage)) {
        outputImage = null;
      } else if (isBase64DataUrl(d.outputImage)) {
        outputImageRef = await saveImageAndGetId(d.outputImage!, workflowPath, savedImageIds, "inputs");
        outputImage = null;
      }

      newData = { ...d, sourceImage, sourceImageRef, outputImage, outputImageRef };
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
  const hash = `${folder}-${computeContentHash(imageData)}`;

  // Skip deduplication if an explicit ID is requested - we must use that exact ID
  // to maintain consistency with imageHistory. Otherwise, deduplicate by content.
  if (!existingId && savedImageIds.has(hash)) {
    return savedImageIds.get(hash)!;
  }

  // Check if there's already an in-flight save for this hash
  if (!existingId && inFlightSaves.has(hash)) {
    return inFlightSaves.get(hash)!;
  }

  // Use existing ID if provided (for consistency with imageHistory), otherwise generate new
  const imageId = existingId || generateImageId();

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
  const hydratedNodes: WorkflowNode[] = [];
  const loadedImages = new Map<string, string>(); // imageId -> base64 (for caching)

  for (const node of workflow.nodes) {
    const newNode = await hydrateNodeImages(node, workflowPath, loadedImages);
    hydratedNodes.push(newNode);
  }

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
    case "imageInput": {
      const d = data as import("@/types").ImageInputNodeData;
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

    case "annotation": {
      const d = data as import("@/types").AnnotationNodeData;
      let sourceImage = d.sourceImage;
      let outputImage = d.outputImage;

      if (d.sourceImageRef && !d.sourceImage) {
        sourceImage = await loadImageById(d.sourceImageRef, workflowPath, loadedImages, "inputs");
      }
      if (d.outputImageRef && !d.outputImage) {
        outputImage = await loadImageById(d.outputImageRef, workflowPath, loadedImages, "inputs");
      }

      newData = {
        ...d,
        sourceImage,
        outputImage,
      };
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

    case "maskPainter": {
      const d = data as import("@/types").MaskPainterNodeData;
      let sourceImage = d.sourceImage;
      let outputMask = d.outputMask;

      if (d.sourceImageRef && !d.sourceImage) {
        sourceImage = await loadImageById(d.sourceImageRef, workflowPath, loadedImages, "inputs");
      }
      if (d.outputMaskRef && !d.outputMask) {
        outputMask = await loadImageById(d.outputMaskRef, workflowPath, loadedImages, "inputs");
      }

      newData = {
        ...d,
        sourceImage,
        outputMask,
      };
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

    case "imageCrop": {
      const d = data as import("@/types").ImageCropNodeData;
      let sourceImage = d.sourceImage;
      let outputImage = d.outputImage;

      if (d.sourceImageRef && !d.sourceImage) {
        sourceImage = await loadImageById(d.sourceImageRef, workflowPath, loadedImages, "inputs");
      }
      if (d.outputImageRef && !d.outputImage) {
        outputImage = await loadImageById(d.outputImageRef, workflowPath, loadedImages, "inputs");
      }

      newData = {
        ...d,
        sourceImage,
        outputImage,
      };
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
async function loadImageById(
  imageId: string,
  workflowPath: string,
  loadedImages: Map<string, string>,
  folder?: "inputs" | "generations"
): Promise<string> {
  if (loadedImages.has(imageId)) {
    return loadedImages.get(imageId)!;
  }

  const params = new URLSearchParams({
    workflowPath,
    imageId,
  });
  if (folder) {
    params.set("folder", folder);
  }

  const response = await fetch(`/api/workflow-images?${params.toString()}`);

  const result = await response.json();

  if (!result.success) {
    // Missing images are expected when refs point to deleted/moved files
    console.log(`Image not found: ${imageId}`);
    return ""; // Return empty string to avoid breaking the workflow
  }

  loadedImages.set(imageId, result.image);
  return result.image;
}
