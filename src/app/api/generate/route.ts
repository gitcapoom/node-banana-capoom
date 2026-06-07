/**
 * Generate API Route
 * 
 * TIMEOUT CONFIGURATION:
 * - maxDuration: Only applies on Vercel, not locally
 * - AbortSignal.timeout: Controls outgoing fetch to providers
 * - For local development, server.requestTimeout must be set in server.js (Node.js default is 5 minutes)
 * 
 * FAL.AI QUEUE API NOTE:
 * Uses generateWithFalQueue with async queue submission + polling.
 * Images are uploaded to fal CDN before submission to avoid payload size issues.
 */
import { NextRequest, NextResponse } from "next/server";
import { GenerateRequest, GenerateResponse, ModelType, SelectedModel, ProviderType } from "@/types";
import { GenerationInput, GenerationOutput, ModelCapability } from "@/lib/providers/types";
import { generateWithGemini, generateWithGeminiVideo } from "./providers/gemini";
import { generateWithReplicate } from "./providers/replicate";
import { clearFalInputMappingCache as _clearFalInputMappingCache, generateWithFalQueue, type FalStatusUpdate } from "./providers/fal";
import { generateWithKie } from "./providers/kie";
import { generateWithWaveSpeed } from "./providers/wavespeed";
import { generateWithMuapi } from "./providers/muapi";
import { wantsSSE, createSSEStream, SSE_HEADERS } from "./utils/sse";
import { calculateGenerationCost } from "@/utils/costCalculator";
import { compressAllImages } from "./utils/imageCompression";
import { isImageSizeError } from "./utils/sizeErrorDetection";

// Re-export for backward compatibility (test file imports from route)
export const clearFalInputMappingCache = _clearFalInputMappingCache;

export const maxDuration = 300; // 5 minute timeout (Vercel hobby plan limit)
export const dynamic = 'force-dynamic'; // Ensure this route is always dynamic


/**
 * Extended request format that supports both legacy and multi-provider requests
 */
interface MultiProviderGenerateRequest extends GenerateRequest {
  selectedModel?: SelectedModel;
  parameters?: Record<string, unknown>;
  /** Dynamic inputs from schema-based connections (e.g., image_url, tail_image_url, prompt) */
  dynamicInputs?: Record<string, string | string[]>;
}


function buildMediaResponse(
  output: { type: string; data: string; url?: string },
  allOutputs?: Array<{ type: string; data: string; url?: string }>
): NextResponse {
  if (output.type === "3d") {
    return NextResponse.json<GenerateResponse>({
      success: true,
      model3dUrl: output.url,
      contentType: "3d",
    });
  }

  if (output.type === "video") {
    const isLarge = !output.data && output.url;
    return NextResponse.json<GenerateResponse>({
      success: true,
      video: isLarge ? undefined : output.data,
      videoUrl: isLarge ? output.url : undefined,
      contentType: "video",
    });
  }

  if (output.type === "audio") {
    const isLarge = !output.data && output.url;
    return NextResponse.json<GenerateResponse>({
      success: true,
      audio: isLarge ? undefined : output.data,
      audioUrl: isLarge ? output.url : undefined,
      contentType: "audio",
    });
  }

  // Image: support multiple images (e.g., num_images > 1)
  const imageOutputs = (allOutputs || [output]).filter(o => o.type === "image" && o.data);
  const imagesArr = imageOutputs.map(o => o.data);
  return NextResponse.json<GenerateResponse>({
    success: true,
    image: output.data, // First image for back-compat
    images: imagesArr.length > 1 ? imagesArr : undefined,
    contentType: "image",
  });
}

/**
 * Retry a generation with compressed images if the first attempt fails with a size error.
 * The generateFn receives (images, dynamicInputs) so it can be re-called with compressed versions.
 */
async function retryWithCompressedImages(
  requestId: string,
  images: string[],
  dynamicInputs: Record<string, string | string[]> | undefined,
  generateFn: (imgs: string[], dynInputs: Record<string, string | string[]> | undefined) => Promise<GenerationOutput>,
): Promise<GenerationOutput> {
  // Check if there are any compressible images (data:image/ URLs)
  const hasImages = images.some(img => img.startsWith("data:image/"));
  const hasDynImages = dynamicInputs && Object.values(dynamicInputs).some(v =>
    typeof v === "string" ? v.startsWith("data:image/") :
    Array.isArray(v) ? v.some(item => typeof item === "string" && item.startsWith("data:image/")) : false
  );
  const canCompress = hasImages || hasDynImages;

  // First attempt — original images
  let result: GenerationOutput;
  try {
    result = await generateFn(images, dynamicInputs);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (canCompress && isImageSizeError(msg)) {
      console.log(`[API:${requestId}] Size error (thrown): "${msg.substring(0, 100)}". Compressing images and retrying...`);
      const compressed = await compressAllImages(images, dynamicInputs);
      return generateFn(compressed.images, compressed.dynamicInputs);
    }
    throw error;
  }

  // Check returned error
  if (!result.success && result.error && canCompress && isImageSizeError(result.error)) {
    console.log(`[API:${requestId}] Size error (returned): "${result.error.substring(0, 100)}". Compressing images and retrying...`);
    const compressed = await compressAllImages(images, dynamicInputs);
    return generateFn(compressed.images, compressed.dynamicInputs);
  }

  return result;
}

function capabilitiesForMediaType(mediaType?: string): ModelCapability[] {
  const map: Record<string, ModelCapability[]> = {
    audio: ["text-to-audio"],
    video: ["text-to-video"],
    "3d": ["text-to-3d"],
  };
  return map[mediaType ?? ""] ?? ["text-to-image"];
}

export async function POST(request: NextRequest) {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`\n[API:${requestId}] ========== NEW GENERATE REQUEST ==========`);

  try {
    const body: MultiProviderGenerateRequest = await request.json();
    const {
      images,
      prompt,
      model = "nano-banana-pro",
      aspectRatio,
      resolution,
      useGoogleSearch,
      useImageSearch,
      selectedModel,
      parameters,
      dynamicInputs,
      mediaType,
    } = body;

    // Prompt is required unless:
    // - Provided via dynamicInputs
    // - Images are provided (image-to-video/image-to-image models)
    // - Dynamic inputs contain image frames (first_frame, last_frame, etc.)
    const hasPrompt = prompt || (dynamicInputs && (
      typeof dynamicInputs.prompt === 'string'
        ? dynamicInputs.prompt
        : Array.isArray(dynamicInputs.prompt) && dynamicInputs.prompt.length > 0
    ));
    const hasImages = (images && images.length > 0);
    const hasImageInputs = dynamicInputs && Object.keys(dynamicInputs).some(key =>
      key.includes('frame') || key.includes('image')
    );

    if (!hasPrompt && !hasImages && !hasImageInputs) {
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: "Prompt or image input is required",
        },
        { status: 400 }
      );
    }

    // Determine which provider to use
    const provider: ProviderType = selectedModel?.provider || "gemini";
    console.log(`[API:${requestId}] Provider: ${provider}, Model: ${selectedModel?.modelId || model}`);

    // Route to appropriate provider
    if (provider === "replicate") {
      if (!selectedModel?.modelId || !selectedModel?.displayName) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "selectedModel with modelId and displayName is required for Replicate" },
          { status: 400 }
        );
      }

      // User-provided key takes precedence over env variable
      const replicateApiKey = request.headers.get("X-Replicate-API-Key") || process.env.REPLICATE_API_KEY;
      if (!replicateApiKey) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "Replicate API key not configured. Add REPLICATE_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      }

      // Keep Data URIs as-is since localhost URLs won't work (provider can't reach them)
      const processedImages: string[] = images ? [...images] : [];

      // Process dynamicInputs: filter empty values, keep Data URIs
      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values (arrays pass through)
          if (value === null || value === undefined || value === '') {
            continue;
          }

          // Keep the value as-is (Data URIs work with Replicate)
          processedDynamicInputs[key] = value;
        }
      }

      // Build generation input
      const genInput: GenerationInput = {
        model: {
          id: selectedModel.modelId,
          name: selectedModel.displayName,
          provider: "replicate",
          capabilities: capabilitiesForMediaType(mediaType),
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      const result = await retryWithCompressedImages(
        requestId, processedImages, processedDynamicInputs,
        (imgs, dynIn) => generateWithReplicate(requestId, replicateApiKey, { ...genInput, images: imgs, dynamicInputs: dynIn }),
      );

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: result.error || "Generation failed" },
          { status: 500 }
        );
      }

      const output = result.outputs?.[0];
      if (!output?.data && !output?.url) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "No output in generation result" },
          { status: 500 }
        );
      }

      return buildMediaResponse(output, result.outputs);
    }

    if (provider === "fal") {
      if (!selectedModel?.modelId || !selectedModel?.displayName) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "selectedModel with modelId and displayName is required for fal.ai" },
          { status: 400 }
        );
      }

      // User-provided key takes precedence over env variable
      const falApiKey = request.headers.get("X-Fal-API-Key") || process.env.FAL_API_KEY || null;

      if (!falApiKey) {
        console.warn(`[API:${requestId}] No FAL API key configured. Proceeding without auth (rate-limited).`);
      }

      // Pass images as-is; generateWithFalQueue uploads base64 to CDN internally
      const processedImages: string[] = images ? [...images] : [];

      // Process dynamicInputs: filter empty values
      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values (arrays pass through)
          if (value === null || value === undefined || value === '') {
            continue;
          }

          // Keep the value as-is; CDN upload happens in generateWithFalQueue
          processedDynamicInputs[key] = value;
        }
      }

      // Build generation input
      const genInput: GenerationInput = {
        model: {
          id: selectedModel.modelId,
          name: selectedModel.displayName,
          provider: "fal",
          capabilities: capabilitiesForMediaType(mediaType),
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      // ── SSE streaming path ──────────────────────────────────
      // When the client sends `Accept: text/event-stream`, we stream the
      // upstream provider's status updates back as the job moves through
      // queue → running → downloading. Final result lands as an event:result.
      if (wantsSSE(request)) {
        const { stream, emit, finish } = createSSEStream();
        const sseStart = Date.now();
        const onStatus = (s: FalStatusUpdate) => {
          emit("status", { ...s, elapsedMs: Date.now() - sseStart });
        };
        // Kick the async work off the stack so we return the response
        // immediately and start flushing the stream.
        void (async () => {
          try {
            onStatus({ phase: "submitting" });
            const result = await retryWithCompressedImages(
              requestId, processedImages, processedDynamicInputs,
              (imgs, dynIn) => generateWithFalQueue(
                requestId, falApiKey,
                { ...genInput, images: imgs, dynamicInputs: dynIn },
                onStatus,
              ),
            );
            if (!result.success) {
              finish("result", { success: false, error: result.error || "Generation failed" });
              return;
            }
            const output = result.outputs?.[0];
            if (!output?.data && !output?.url) {
              finish("result", { success: false, error: "No output in generation result" });
              return;
            }
            // Re-use buildMediaResponse's shape by extracting its body —
            // we can't return its NextResponse from inside the stream, so
            // construct the same JSON-shaped payload.
            const mediaResponse = buildMediaResponse(output, result.outputs);
            const body = await mediaResponse.clone().json();
            finish("result", body);
          } catch (err) {
            finish("result", { success: false, error: err instanceof Error ? err.message : String(err) });
          }
        })();
        return new Response(stream, { headers: SSE_HEADERS });
      }

      // ── Legacy blocking path (no Accept: text/event-stream) ────
      const result = await retryWithCompressedImages(
        requestId, processedImages, processedDynamicInputs,
        (imgs, dynIn) => generateWithFalQueue(requestId, falApiKey, { ...genInput, images: imgs, dynamicInputs: dynIn }),
      );

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: result.error || "Generation failed" },
          { status: 500 }
        );
      }

      const output = result.outputs?.[0];
      if (!output?.data && !output?.url) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "No output in generation result" },
          { status: 500 }
        );
      }

      return buildMediaResponse(output, result.outputs);
    }

    if (provider === "kie") {
      if (!selectedModel?.modelId || !selectedModel?.displayName) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "selectedModel with modelId and displayName is required for Kie.ai" },
          { status: 400 }
        );
      }

      // User-provided key takes precedence over env variable
      const kieApiKey = request.headers.get("X-Kie-Key") || process.env.KIE_API_KEY;
      if (!kieApiKey) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "Kie.ai API key not configured. Add KIE_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      }

      // Process images - Kie requires URLs, we'll upload base64 images in generateWithKie
      const processedImages: string[] = images ? [...images] : [];

      // Process dynamicInputs: filter empty values
      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values
          if (value === null || value === undefined || value === '') {
            continue;
          }

          processedDynamicInputs[key] = value;
        }
      }

      // Build generation input
      const genInput: GenerationInput = {
        model: {
          id: selectedModel.modelId,
          name: selectedModel.displayName,
          provider: "kie",
          capabilities: capabilitiesForMediaType(mediaType),
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      const result = await retryWithCompressedImages(
        requestId, processedImages, processedDynamicInputs,
        (imgs, dynIn) => generateWithKie(requestId, kieApiKey, { ...genInput, images: imgs, dynamicInputs: dynIn }),
      );

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: result.error || "Generation failed" },
          { status: 500 }
        );
      }

      const output = result.outputs?.[0];
      if (!output?.data && !output?.url) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "No output in generation result" },
          { status: 500 }
        );
      }

      return buildMediaResponse(output, result.outputs);
    }

    if (provider === "wavespeed") {
      if (!selectedModel?.modelId || !selectedModel?.displayName) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "selectedModel with modelId and displayName is required for WaveSpeed" },
          { status: 400 }
        );
      }

      // User-provided key takes precedence over env variable
      const wavespeedApiKey = request.headers.get("X-WaveSpeed-Key") || process.env.WAVESPEED_API_KEY;
      if (!wavespeedApiKey) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "WaveSpeed API key not configured. Add WAVESPEED_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      }

      // Keep Data URIs as-is since localhost URLs won't work
      const processedImages: string[] = images ? [...images] : [];

      // Process dynamicInputs: filter empty values
      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values
          if (value === null || value === undefined || value === '') {
            continue;
          }

          processedDynamicInputs[key] = value;
        }
      }

      // Build generation input
      const genInput: GenerationInput = {
        model: {
          id: selectedModel.modelId,
          name: selectedModel.displayName,
          provider: "wavespeed",
          capabilities: capabilitiesForMediaType(mediaType),
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      const result = await retryWithCompressedImages(
        requestId, processedImages, processedDynamicInputs,
        (imgs, dynIn) => generateWithWaveSpeed(requestId, wavespeedApiKey, { ...genInput, images: imgs, dynamicInputs: dynIn }),
      );

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: result.error || "Generation failed" },
          { status: 500 }
        );
      }

      const output = result.outputs?.[0];
      if (!output?.data && !output?.url) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "No output in generation result" },
          { status: 500 }
        );
      }

      return buildMediaResponse(output, result.outputs);
    }

    // muapi.ai provider
    if (provider === "muapi") {
      if (!selectedModel?.modelId || !selectedModel?.displayName) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "selectedModel with modelId and displayName is required for muapi.ai" },
          { status: 400 }
        );
      }

      const muapiApiKey = request.headers.get("X-Muapi-API-Key") || process.env.MUAPI_API_KEY;
      const falApiKeyForUpload = request.headers.get("X-Fal-API-Key") || process.env.FAL_API_KEY || null;
      if (!muapiApiKey) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "muapi.ai API key not configured. Add MUAPI_API_KEY to .env.local or configure in Settings." },
          { status: 401 }
        );
      }

      const processedImages: string[] = images ? [...images] : [];

      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;
      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];
          if (value === null || value === undefined || value === '') continue;
          processedDynamicInputs[key] = value;
        }
      }

      const genInput: GenerationInput = {
        model: {
          id: selectedModel.modelId,
          name: selectedModel.displayName,
          provider: "muapi",
          capabilities: capabilitiesForMediaType(mediaType),
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      const result = await retryWithCompressedImages(
        requestId, processedImages, processedDynamicInputs,
        (imgs, dynIn) => generateWithMuapi(requestId, muapiApiKey, { ...genInput, images: imgs, dynamicInputs: dynIn }, falApiKeyForUpload),
      );

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: result.error || "Generation failed" },
          { status: 500 }
        );
      }

      const output = result.outputs?.[0];
      if (!output?.data && !output?.url) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "No output in generation result" },
          { status: 500 }
        );
      }

      return buildMediaResponse(output, result.outputs);
    }

    // Default: Use Gemini
    // User-provided key (from settings) takes precedence over env variable
    const geminiApiKey = request.headers.get("X-Gemini-API-Key") || process.env.GEMINI_API_KEY;

    if (!geminiApiKey) {
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: "API key not configured. Add GEMINI_API_KEY to .env.local or configure in Settings.",
        },
        { status: 500 }
      );
    }

    // Use selectedModel.modelId if available (new format), fallback to legacy model field
    const geminiModel = (selectedModel?.modelId as ModelType) || model;

    // Resolve prompt: use top-level prompt, fall back to dynamicInputs.prompt
    // This handles cases where the prompt arrives via dynamicInputs instead of top-level
    let resolvedPrompt = prompt;
    if (!resolvedPrompt && dynamicInputs?.prompt) {
      resolvedPrompt = Array.isArray(dynamicInputs.prompt)
        ? dynamicInputs.prompt[0]
        : dynamicInputs.prompt;
    }
    // Validate: if a prompt was provided but isn't a string (corrupted data), return clear error
    // If no prompt provided but images exist, that's valid (image-to-image)
    if (resolvedPrompt !== undefined && resolvedPrompt !== null && typeof resolvedPrompt !== 'string') {
      return NextResponse.json<GenerateResponse>(
        { success: false, error: "prompt must be a string" },
        { status: 400 }
      );
    }

    // Check if this is a Veo video model request
    if (selectedModel?.modelId?.startsWith("veo-")) {
      // Merge negative prompt from dynamic inputs (connected handle) into parameters
      const veoParams = { ...(parameters || {}) };
      if (dynamicInputs?.negative_prompt) {
        const neg = Array.isArray(dynamicInputs.negative_prompt)
          ? dynamicInputs.negative_prompt[0]
          : dynamicInputs.negative_prompt;
        if (neg) veoParams.negativePrompt = neg;
      }
      const result = await retryWithCompressedImages(
        requestId, images || [], undefined,
        (imgs) => generateWithGeminiVideo(requestId, geminiApiKey, selectedModel.modelId, resolvedPrompt || "", imgs, veoParams),
      );

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: result.error || "Video generation failed" },
          { status: 500 }
        );
      }

      const output = result.outputs?.[0];
      if (!output?.data && !output?.url) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "No output in video generation result" },
          { status: 500 }
        );
      }

      return buildMediaResponse(output, result.outputs);
    }

    // Gemini returns NextResponse directly — handle retry manually
    try {
      return await generateWithGemini(requestId, geminiApiKey, resolvedPrompt, images || [], geminiModel, aspectRatio, resolution, useGoogleSearch, useImageSearch, parameters);
    } catch (geminiError) {
      const msg = geminiError instanceof Error ? geminiError.message : String(geminiError);
      if (isImageSizeError(msg) && images && images.length > 0) {
        console.log(`[API:${requestId}] Gemini size error: "${msg.substring(0, 100)}". Compressing images and retrying...`);
        const compressed = await compressAllImages(images, undefined);
        return await generateWithGemini(requestId, geminiApiKey, resolvedPrompt, compressed.images, geminiModel, aspectRatio, resolution, useGoogleSearch, useImageSearch, parameters);
      }
      throw geminiError;
    }
  } catch (error) {
    // Extract error information
    let errorMessage = "Generation failed";
    let errorDetails = "";

    if (error instanceof Error) {
      errorMessage = error.message;
      if ("cause" in error && error.cause) {
        errorDetails = JSON.stringify(error.cause);
      }
    }

    // Try to extract more details from API errors
    if (error && typeof error === "object") {
      const apiError = error as Record<string, unknown>;
      if (apiError.status) {
        errorDetails += ` Status: ${apiError.status}`;
      }
      if (apiError.statusText) {
        errorDetails += ` ${apiError.statusText}`;
      }
    }

    // Handle rate limiting
    if (errorMessage.includes("429")) {
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: "Rate limit reached. Please wait and try again.",
        },
        { status: 429 }
      );
    }

    console.error(`[API:${requestId}] Generation error: ${errorMessage}${errorDetails ? ` (${errorDetails.substring(0, 200)})` : ""}`);
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}
