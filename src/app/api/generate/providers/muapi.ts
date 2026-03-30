/**
 * muapi.ai Provider for Generate API Route
 *
 * Handles image/video/audio generation using muapi.ai API.
 * Uses async task submission + polling.
 *
 * API:
 *   Submit: POST https://api.muapi.ai/api/v1/{model-endpoint}
 *   Poll:   GET  https://api.muapi.ai/api/v1/predictions/{request_id}/result
 *   Auth:   x-api-key header
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { validateMediaUrl } from "@/utils/urlValidation";
import { uploadImageToFal } from "./fal";

const MUAPI_BASE = "https://api.muapi.ai/api/v1";

/**
 * Generate image/video/audio using muapi.ai API
 */
export async function generateWithMuapi(
  requestId: string,
  apiKey: string,
  input: GenerationInput,
  falApiKey?: string | null
): Promise<GenerationOutput> {
  console.log(`[API:${requestId}] muapi.ai generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  const modelId = input.model.id;

  // Validate modelId to prevent path traversal
  if (/[^a-zA-Z0-9\-_/.]/.test(modelId) || modelId.includes('..')) {
    return { success: false, error: `Invalid model ID: ${modelId}` };
  }

  const hasDynamicInputs = input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0;
  console.log(`[API:${requestId}] Dynamic inputs: ${hasDynamicInputs ? Object.keys(input.dynamicInputs!).join(", ") : "none"}`);

  // Determine output type from model capabilities
  const isVideoModel = input.model.capabilities.some(c =>
    c.includes("video") || c.includes("animate")
  );
  const isAudioModel = input.model.capabilities.some(c => c.includes("audio"));

  // Build payload — spread parameters first so explicit prompt wins
  const payload: Record<string, unknown> = {
    ...input.parameters,
    prompt: input.prompt || undefined,
  };

  // Remove undefined prompt (some models don't use it)
  if (!payload.prompt) delete payload.prompt;

  // Coerce numeric string parameters to actual numbers (muapi expects integers for duration, seed, etc.)
  for (const key of Object.keys(payload)) {
    const val = payload[key];
    if (typeof val === "string" && /^\d+$/.test(val)) {
      payload[key] = parseInt(val, 10);
    }
  }

  // Apply dynamic inputs (schema-mapped connections)
  if (hasDynamicInputs) {
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value !== null && value !== undefined && value !== '') {
        payload[key] = value;
      }
    }
  } else if (input.images && input.images.length > 0) {
    // Fallback: pass first image as image_url (and images_list for models that need it)
    payload.image_url = input.images[0];
    payload.images_list = input.images;
  }

  // Upload base64 images to CDN — muapi.ai requires URLs, not data URIs
  for (const key of Object.keys(payload)) {
    const val = payload[key];
    if (typeof val === "string" && val.startsWith("data:")) {
      console.log(`[API:${requestId}] Uploading ${key} to CDN...`);
      payload[key] = await uploadImageToFal(val, falApiKey || null);
    } else if (Array.isArray(val)) {
      payload[key] = await Promise.all(
        val.map(async (item: unknown) => {
          if (typeof item === "string" && item.startsWith("data:")) {
            console.log(`[API:${requestId}] Uploading ${key}[] item to CDN...`);
            return uploadImageToFal(item as string, falApiKey || null);
          }
          return item;
        })
      );
    }
  }

  console.log(`[API:${requestId}] Submitting to muapi.ai: ${modelId} with keys: ${Object.keys(payload).join(", ")}`);

  // Submit task
  const submitUrl = `${MUAPI_BASE}/${modelId}`;
  const submitResponse = await fetch(submitUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    let errorDetail = errorText || `HTTP ${submitResponse.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      // Extract error message — handle string, array, or nested object
      const raw = errorJson.error || errorJson.message || errorJson.detail;
      if (typeof raw === "string") {
        errorDetail = raw;
      } else if (raw) {
        errorDetail = JSON.stringify(raw);
      }
    } catch {
      // Keep original text
    }

    console.error(`[API:${requestId}] muapi.ai submit failed: ${submitResponse.status} - ${errorDetail}`);

    if (submitResponse.status === 429) {
      return { success: false, error: `${input.model.name || 'muapi.ai'}: Rate limit exceeded. Try again in a moment.` };
    }
    if (submitResponse.status === 402) {
      return { success: false, error: `${input.model.name || 'muapi.ai'}: Insufficient credits. Top up at muapi.ai.` };
    }

    return { success: false, error: `${input.model.name || 'muapi.ai'}: ${errorDetail}` };
  }

  const submitResult = await submitResponse.json();
  console.log(`[API:${requestId}] muapi.ai submit response:`, JSON.stringify(submitResult).substring(0, 500));

  const taskId = submitResult.request_id;
  if (!taskId) {
    console.error(`[API:${requestId}] No request_id in muapi.ai submit response`);
    return { success: false, error: "muapi.ai: No request_id returned from API" };
  }

  console.log(`[API:${requestId}] muapi.ai task submitted: ${taskId}`);

  // Poll for completion
  // Status flow: processing → completed | failed
  const maxWaitTime = 20 * 60 * 1000; // 20 minutes (video models can be very slow)
  const pollInterval = 2000; // 2 seconds
  const startTime = Date.now();
  let lastStatus = "";

  interface MuapiPollResponse {
    status?: string;
    outputs?: string[];
    output?: {
      images?: string[];
      video?: string;
      audio?: string;
    };
    error?: string | unknown;
    message?: string | unknown;
  }

  let resultData: MuapiPollResponse | null = null;

  while (true) {
    if (Date.now() - startTime > maxWaitTime) {
      console.error(`[API:${requestId}] muapi.ai task timed out after 10 minutes`);
      return { success: false, error: `${input.model.name}: Generation timed out after 10 minutes` };
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      const pollUrl = `${MUAPI_BASE}/predictions/${taskId}/result`;
      const pollResponse = await fetch(pollUrl, {
        headers: { "x-api-key": apiKey },
      });

      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      console.log(`[API:${requestId}] muapi.ai poll (${elapsedSec}s): ${pollResponse.status}`);

      // 404 means result not ready yet
      if (pollResponse.status === 404) {
        lastStatus = "pending";
        continue;
      }

      if (!pollResponse.ok) {
        const errorText = await pollResponse.text();
        let errorDetail = errorText || `HTTP ${pollResponse.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          const raw = errorJson.error || errorJson.message;
          if (typeof raw === "string") {
            errorDetail = raw;
          } else if (raw) {
            errorDetail = JSON.stringify(raw);
          }
        } catch {
          // Keep original
        }
        console.error(`[API:${requestId}] muapi.ai poll failed: ${pollResponse.status} - ${errorDetail}`);
        return { success: false, error: `${input.model.name}: ${errorDetail}` };
      }

      const pollData: MuapiPollResponse = await pollResponse.json();
      console.log(`[API:${requestId}] muapi.ai poll data:`, JSON.stringify(pollData).substring(0, 300));

      const currentStatus = pollData.status;

      if (currentStatus !== lastStatus) {
        console.log(`[API:${requestId}] muapi.ai status: ${lastStatus} → ${currentStatus}`);
        lastStatus = currentStatus || "";
      }

      if (currentStatus === "completed") {
        console.log(`[API:${requestId}] muapi.ai task completed`);
        resultData = pollData;
        break;
      }

      if (currentStatus === "failed") {
        const rawErr = pollData.error || pollData.message || "Generation failed";
        const failureReason = typeof rawErr === "string" ? rawErr : JSON.stringify(rawErr);
        console.error(`[API:${requestId}] muapi.ai task failed: ${failureReason}`);
        return { success: false, error: `${input.model.name}: ${failureReason}` };
      }

      // Continue polling for processing/pending
    } catch (pollError) {
      const message = pollError instanceof Error ? pollError.message : String(pollError);
      console.error(`[API:${requestId}] muapi.ai poll error: ${message}`);
      return { success: false, error: `${input.model.name}: ${message}` };
    }
  }

  if (!resultData) {
    return { success: false, error: `${input.model.name}: No result received` };
  }

  // Extract output URL(s)
  // Format: { outputs: ["url1", "url2"] } or { output: { images: [...], video: "...", audio: "..." } }
  let outputUrl: string | null = null;

  if (resultData.outputs && Array.isArray(resultData.outputs) && resultData.outputs.length > 0) {
    outputUrl = resultData.outputs[0];
  } else if (resultData.output) {
    if (isVideoModel && resultData.output.video) {
      outputUrl = resultData.output.video;
    } else if (isAudioModel && resultData.output.audio) {
      outputUrl = resultData.output.audio;
    } else if (resultData.output.images && resultData.output.images.length > 0) {
      outputUrl = resultData.output.images[0];
    }
  }

  if (!outputUrl) {
    console.error(`[API:${requestId}] No outputs in muapi.ai result:`, JSON.stringify(resultData).substring(0, 500));
    return { success: false, error: `${input.model.name}: No outputs in generation result` };
  }

  // Validate URL
  const outputUrlCheck = validateMediaUrl(outputUrl);
  if (!outputUrlCheck.valid) {
    return { success: false, error: `Invalid output URL: ${outputUrlCheck.error}` };
  }

  console.log(`[API:${requestId}] Fetching muapi.ai output from: ${outputUrl.substring(0, 80)}...`);

  // For video/audio, return URL directly (large files)
  if (isVideoModel) {
    console.log(`[API:${requestId}] SUCCESS - Returning video URL`);
    return {
      success: true,
      outputs: [{ type: "video", data: "", url: outputUrl }],
    };
  }

  if (isAudioModel) {
    console.log(`[API:${requestId}] SUCCESS - Returning audio URL`);
    return {
      success: true,
      outputs: [{ type: "audio", data: "", url: outputUrl }],
    };
  }

  // For images, fetch and convert to base64
  const outputResponse = await fetch(outputUrl);
  if (!outputResponse.ok) {
    return { success: false, error: `Failed to fetch output: ${outputResponse.status}` };
  }

  const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50MB
  const contentLength = parseInt(outputResponse.headers.get("content-length") || "0", 10);
  if (!isNaN(contentLength) && contentLength > MAX_IMAGE_SIZE) {
    return { success: false, error: `Image too large: ${(contentLength / (1024 * 1024)).toFixed(0)}MB` };
  }

  const outputArrayBuffer = await outputResponse.arrayBuffer();
  const contentType = outputResponse.headers.get("content-type") || "image/png";
  const base64 = Buffer.from(outputArrayBuffer).toString("base64");
  const dataUrl = `data:${contentType};base64,${base64}`;

  console.log(`[API:${requestId}] SUCCESS - Image: ${(outputArrayBuffer.byteLength / 1024).toFixed(0)}KB`);

  return {
    success: true,
    outputs: [{ type: "image", data: dataUrl }],
  };
}
