/**
 * fal.ai Provider for Generate API Route
 *
 * Handles image/video generation using fal.ai's Queue API.
 * Images are uploaded to fal CDN before submission to avoid payload size issues.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { GENERATION_MAX_WAIT_MS } from "../utils/timeouts";
import { waitUnlessCancelled, cancelUpstream, cancelledOutput } from "../utils/cancellation";
import { validateMediaUrl } from "@/utils/urlValidation";
import { setAtPath } from "./deepSet";
import {
  INPUT_PATTERNS,
  InputMapping,
  ParameterTypeInfo,
  coerceParameterTypes,
  isArraySchemaProperty,
  canHoldMediaUrl,
} from "../schemaUtils";

/**
 * Extended input mapping with parameter types for fal.ai
 */
interface FalInputMapping extends InputMapping {
  parameterTypes: ParameterTypeInfo;
  // `schemaLoaded` is inherited from InputMapping — every failure path below
  // returns EMPTY sets, which the reshape in generateWithFal() cannot tell
  // apart from "the schema says none of these are arrays".
}

/**
 * In-memory cache for fal.ai schema mappings to avoid extra API call per generation
 */
const falInputMappingCache = new Map<string, { result: FalInputMapping; timestamp: number }>();
const FAL_MAPPING_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/** Clear the fal schema mapping cache (exported for testing) */
export function clearFalInputMappingCache() {
  falInputMappingCache.clear();
}

/**
 * Fetch fal.ai model schema and extract input parameter mappings
 * Uses the Model Search API with OpenAPI expansion (same as /api/models/[modelId])
 * Results are cached in-memory for 30 minutes per model.
 */
async function getFalInputMapping(modelId: string, apiKey: string | null): Promise<FalInputMapping> {
  // Check cache first
  const cached = falInputMappingCache.get(modelId);
  if (cached && Date.now() - cached.timestamp < FAL_MAPPING_CACHE_TTL) {
    return cached.result;
  }
  const paramMap: Record<string, string> = {};
  const arrayParams = new Set<string>();
  const schemaArrayParams = new Set<string>();
  const parameterTypes: ParameterTypeInfo = {};
  let schemaLoaded = false;

  try {
    // Use fal.ai Model Search API with OpenAPI expansion
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Key ${apiKey}`;
    }

    const url = `https://api.fal.ai/v1/models?endpoint_id=${encodeURIComponent(modelId)}&expand=openapi-3.0`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      return { paramMap, arrayParams, schemaArrayParams, parameterTypes, schemaLoaded };
    }

    const data = await response.json();
    const modelData = data.models?.[0];
    if (!modelData?.openapi) {
      return { paramMap, arrayParams, schemaArrayParams, parameterTypes, schemaLoaded };
    }

    // Extract input schema from OpenAPI spec (same logic as /api/models/[modelId])
    const spec = modelData.openapi;
    let inputSchema: Record<string, unknown> | null = null;

    for (const pathObj of Object.values(spec.paths || {})) {
      const postOp = (pathObj as Record<string, unknown>)?.post as Record<string, unknown> | undefined;
      const reqBody = postOp?.requestBody as Record<string, unknown> | undefined;
      const content = reqBody?.content as Record<string, Record<string, unknown>> | undefined;
      const jsonContent = content?.["application/json"];

      if (jsonContent?.schema) {
        const schema = jsonContent.schema as Record<string, unknown>;
        if (schema.$ref && typeof schema.$ref === "string") {
          const refPath = schema.$ref.replace("#/components/schemas/", "");
          inputSchema = spec.components?.schemas?.[refPath] as Record<string, unknown>;
          break;
        } else if (schema.properties) {
          inputSchema = schema;
          break;
        }
      }
    }

    if (!inputSchema) {
      return { paramMap, arrayParams, schemaArrayParams, parameterTypes, schemaLoaded };
    }

    const properties = inputSchema.properties as Record<string, unknown> | undefined;
    if (!properties) return { paramMap, arrayParams, schemaArrayParams, parameterTypes, schemaLoaded };
    // For $ref resolution inside isArraySchemaProperty (e.g. Kling's `elements`,
    // an array of $ref'd element objects).
    const componentSchemas = (spec.components as Record<string, unknown> | undefined)
      ?.schemas as Record<string, unknown> | undefined;

    // First pass: detect all array-typed properties and extract parameter types
    // This is used for dynamicInputs which use schema names directly
    for (const [propName, prop] of Object.entries(properties)) {
      const property = prop as Record<string, unknown>;
      if (isArraySchemaProperty(propName, prop, componentSchemas)) {
        schemaArrayParams.add(propName);
      }
      // Extract parameter type for type coercion
      const type = property?.type as string | undefined;
      if (type && ["string", "integer", "number", "boolean", "array", "object"].includes(type)) {
        parameterTypes[propName] = type as ParameterTypeInfo[string];
      }
    }

    // Second pass: match properties to INPUT_PATTERNS and detect array types
    const propertyNames = Object.keys(properties);
    for (const [genericName, patterns] of Object.entries(INPUT_PATTERNS)) {
      for (const pattern of patterns) {
        let matchedParam: string | null = null;

        // Check for exact match first
        if (properties[pattern]) {
          matchedParam = pattern;
        } else {
          // Case-insensitive partial match, but only onto a property that could
          // actually hold a URL. Without the type gate, pattern "image" matches
          // `num_images` and the image is written into a counter — fal then
          // answers 422 "num_images: Input should be a valid integer".
          const match = propertyNames.find(name =>
            (name.toLowerCase().includes(pattern.toLowerCase()) ||
             pattern.toLowerCase().includes(name.toLowerCase())) &&
            canHoldMediaUrl(name, properties[name], componentSchemas)
          );
          if (match) {
            matchedParam = match;
          }
        }

        if (matchedParam) {
          paramMap[genericName] = matchedParam;
          // Check if this property expects an array type
          if (isArraySchemaProperty(matchedParam, properties[matchedParam], componentSchemas)) {
            arrayParams.add(genericName);
          }
          break;
        }
      }
    }

    schemaLoaded = true;
    const result = { paramMap, arrayParams, schemaArrayParams, parameterTypes, schemaLoaded };
    falInputMappingCache.set(modelId, { result, timestamp: Date.now() });
    return result;
  } catch {
    // Schema parsing failed - return defaults without caching so next call retries
    return { paramMap, arrayParams, schemaArrayParams, parameterTypes, schemaLoaded };
  }
}

/**
 * fal CDN upload sizes.
 *
 * There used to be a 20 MB cap here, which refused any image or video data URL
 * larger than that before it reached fal. fal's CDN accepts far more: measured
 * against the live endpoint, a single signed PUT succeeds at 100 MiB and is
 * refused at 101 MiB with `413 File too large, use multipart solution`.
 * Beyond that fal takes a multipart upload with no stated ceiling.
 *
 * The threshold and part size match fal's own JS client (fal-ai/fal-js,
 * libs/client/src/storage.ts: MULTIPART_THRESHOLD 90 MiB, 10 MiB parts), so the
 * path taken here is the one fal itself exercises rather than the edge of what
 * happened to work in a probe.
 */
export const FAL_MULTIPART_THRESHOLD = 90 * 1024 * 1024;
export const FAL_MULTIPART_CHUNK_SIZE = 10 * 1024 * 1024;
const FAL_STORAGE_BASE = "https://rest.alpha.fal.ai/storage/upload";

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_UPLOAD_ATTEMPTS = 3;

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  label: string,
  maxAttempts = MAX_UPLOAD_ATTEMPTS,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.ok) return response;

      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === maxAttempts) {
        throw new Error(`${label}: ${response.status}`);
      }

      console.warn(`[fal] ${label} returned ${response.status}, retrying (${attempt}/${maxAttempts})...`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry non-retryable errors (our own thrown errors with status info)
      if (lastError.message.startsWith(label)) throw lastError;

      if (attempt === maxAttempts) throw lastError;

      console.warn(`[fal] ${label} failed: ${lastError.message}, retrying (${attempt}/${maxAttempts})...`);
    }

    // Exponential backoff: 1s, 2s
    await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
  }

  throw lastError || new Error(`${label} failed after ${maxAttempts} attempts`);
}

/** The signed URLs come back in a response, so they are checked before use (SSRF). */
function assertSafeCdnUrl(label: string, url: unknown): asserts url is string {
  if (typeof url !== "string" || !url) {
    throw new Error(`fal CDN initiate response missing ${label}`);
  }
  const check = validateMediaUrl(url);
  if (!check.valid || !url.startsWith("https://")) {
    throw new Error(`fal CDN ${label} failed validation: ${check.error || "not HTTPS"}`);
  }
}

async function initiateFalUpload(
  kind: "initiate" | "initiate-multipart",
  contentType: string,
  fileName: string,
  apiKey: string | null,
): Promise<{ uploadUrl: string; fileUrl: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Key ${apiKey}`;
  const response = await fetchWithRetry(
    `${FAL_STORAGE_BASE}/${kind}?storage_type=fal-cdn-v3`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ content_type: contentType, file_name: fileName }),
    },
    "Failed to initiate fal CDN upload",
  );
  const { upload_url: uploadUrl, file_url: fileUrl } = await response.json();
  assertSafeCdnUrl("upload_url", uploadUrl);
  assertSafeCdnUrl("file_url", fileUrl);
  return { uploadUrl, fileUrl };
}

/**
 * Multipart PUT, mirroring fal-js: part n goes to `{upload_url}/{n}`, each part
 * returns an etag (in the body, repeated as a header), and the upload is closed
 * by POSTing the ordered etags to `{upload_url}/complete`.
 */
async function putFalMultipart(uploadUrl: string, data: Buffer<ArrayBuffer>): Promise<void> {
  const parsed = new URL(uploadUrl);
  const base = `${parsed.origin}${parsed.pathname}`;
  const parts: Array<{ partNumber: number; etag: string }> = [];

  for (let offset = 0, partNumber = 1; offset < data.length; offset += FAL_MULTIPART_CHUNK_SIZE, partNumber++) {
    const chunk = data.subarray(offset, Math.min(offset + FAL_MULTIPART_CHUNK_SIZE, data.length));
    const response = await fetchWithRetry(
      `${base}/${partNumber}${parsed.search}`,
      { method: "PUT", body: chunk },
      `Failed to upload part ${partNumber} to fal CDN`,
    );
    let etag = response.headers.get("etag") ?? undefined;
    try {
      const body = (await response.json()) as { etag?: string };
      etag = body?.etag ?? etag;
    } catch {
      /* body is optional; the header carries the same etag */
    }
    if (!etag) throw new Error(`fal CDN returned no etag for part ${partNumber}`);
    parts.push({ partNumber, etag });
  }

  await fetchWithRetry(
    `${base}/complete${parsed.search}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts }),
    },
    `Failed to complete fal CDN multipart upload (${parts.length} parts)`,
  );
}

/**
 * Upload bytes to the fal CDN and return the file URL: one signed PUT up to
 * FAL_MULTIPART_THRESHOLD, multipart above it. The single route for both the
 * data-URL and the on-disk uploaders, so the size handling cannot drift
 * between them again.
 */
export async function uploadBytesToFal(
  data: Buffer<ArrayBuffer>,
  contentType: string,
  ext: string,
  apiKey: string | null,
): Promise<string> {
  const fileName = `${Date.now()}.${ext || "bin"}`;

  if (data.length > FAL_MULTIPART_THRESHOLD) {
    const { uploadUrl, fileUrl } = await initiateFalUpload("initiate-multipart", contentType, fileName, apiKey);
    await putFalMultipart(uploadUrl, data);
    return fileUrl;
  }

  const { uploadUrl, fileUrl } = await initiateFalUpload("initiate", contentType, fileName, apiKey);
  await fetchWithRetry(
    uploadUrl,
    { method: "PUT", headers: { "Content-Type": contentType }, body: data },
    "Failed to upload to fal CDN",
  );
  return fileUrl;
}

/**
 * Upload a file that is ALREADY ON DISK to the fal CDN, and return its URL.
 * The bytes go from the file straight into the request — no base64 round trip.
 * `contentType` should match the file; it is what the provider sees.
 */
export async function uploadFileToFal(
  filePath: string,
  contentType: string,
  apiKey: string | null,
): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const binaryData = await readFile(filePath);
  const ext = nodePath.extname(filePath).replace(/^\./, "") || "bin";
  return uploadBytesToFal(binaryData, contentType, ext, apiKey);
}

/**
 * Upload a base64 data URL (image or video) to the fal CDN and return its URL.
 * Anything that is not a base64 data URL is returned as-is.
 *
 * No size cap: by the time this runs the data URL is already in server memory,
 * and decoding it to a Buffer is cheap. The old 20 MB refusal was a guess at
 * fal's limit that was five times too low — see FAL_MULTIPART_THRESHOLD.
 */
export async function uploadImageToFal(base64DataUrl: string, apiKey: string | null): Promise<string> {
  if (!base64DataUrl.startsWith("data:")) return base64DataUrl;

  // Parse "data:<mime>;base64,<data>" with string ops, NOT a regex. A greedy
  // `(.+)` capture group overflows V8's regex stack on very large strings —
  // ~28 MB images threw "Maximum call stack size exceeded" here.
  const comma = base64DataUrl.indexOf(",");
  if (comma < 0) return base64DataUrl;
  const header = base64DataUrl.slice(0, comma);
  if (!/;base64$/i.test(header)) return base64DataUrl;
  const contentType = header.slice(5, header.indexOf(";")); // strip leading "data:"

  const binaryData = Buffer.from(base64DataUrl.slice(comma + 1), "base64");
  const ext = contentType.split("/")[1] || "png";
  return uploadBytesToFal(binaryData, contentType, ext, apiKey);
}

/**
 * Status callback shape — when present, the executor emits queue
 * position / phase updates on each poll iteration. See `utils/sse.ts`
 * for the wire format and the route's SSE branch for plumbing.
 */
export interface FalStatusUpdate {
  phase: "submitting" | "queued" | "running" | "downloading";
  queuePosition?: number | null;
}
export type FalStatusCallback = (update: FalStatusUpdate) => void;

/**
 * Generate using fal.ai Queue API
 * Uses async queue submission + polling (1s interval) instead of blocking fal.run.
 * Images are uploaded to fal CDN before submission to avoid payload size issues.
 * Optional `onStatus` is called on every status transition (phase change or
 * queue position update) so the route can stream SSE events back to the client.
 */
export async function generateWithFalQueue(
  requestId: string,
  apiKey: string | null,
  input: GenerationInput,
  onStatus?: FalStatusCallback
): Promise<GenerationOutput> {
  console.log(`[API:${requestId}] fal.ai queue generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);
  onStatus?.({ phase: "submitting" });

  const modelId = input.model.id;
  const hasDynamicInputs = input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0;
  console.log(`[API:${requestId}] Dynamic inputs: ${hasDynamicInputs ? Object.keys(input.dynamicInputs!).join(", ") : "none"}, API key: ${apiKey ? "yes" : "no"}`);

  // Fetch schema for type coercion and input mapping (cached)
  const { paramMap, arrayParams, schemaArrayParams, parameterTypes, schemaLoaded } = await getFalInputMapping(modelId, apiKey);

  // Build request body - parameters are applied per-path below to avoid double-spreading
  const requestBody: Record<string, unknown> = {};

  // Upload base64 images to fal CDN to avoid sending large payloads inline
  const uploadImage = async (value: string | string[]): Promise<string | string[]> => {
    if (Array.isArray(value)) {
      return Promise.all(value.map(v => typeof v === "string" && v.startsWith("data:") ? uploadImageToFal(v, apiKey) : Promise.resolve(v)));
    }
    if (typeof value === "string" && value.startsWith("data:")) {
      return uploadImageToFal(value, apiKey);
    }
    return value;
  };

  if (hasDynamicInputs) {
    // Apply coerced parameters first, then dynamic inputs override
    Object.assign(requestBody, coerceParameterTypes(input.parameters, parameterTypes));
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value === null || value === undefined || value === '') continue;
      let processedValue: unknown = value;
      // Upload base64 images to CDN
      if (typeof value === "string" || Array.isArray(value)) {
        processedValue = await uploadImage(value);
      }

      if (key.includes(".")) {
        // Dotted / nested field (e.g. "fill_image.fill_image_url"). The client
        // already shaped the value correctly based on ModelInput.isArray —
        // trust it and deep-set into the request body.
        setAtPath(requestBody, key, processedValue);
        continue;
      }

      // Top-level field: reshape according to the model's declared schema.
      if (schemaArrayParams.has(key) && !Array.isArray(processedValue)) {
        processedValue = [processedValue];
      } else if (schemaLoaded && !schemaArrayParams.has(key) && Array.isArray(processedValue)) {
        // Unwrap to a single value when the schema says this field is scalar
        // (e.g. image_url). Gated on schemaLoaded: without it, ANY failure to
        // fetch the schema — a 500, a network blip — left schemaArrayParams
        // empty and this branch threw away every array the client had
        // deliberately built from the model's own isArray. Unknown is not the
        // same as scalar; when we do not know, send what the client shaped.
        if (processedValue.length > 0) processedValue = processedValue[0];
        else continue;
      }
      requestBody[key] = processedValue;
    }

    // Ensure prompt is included even when using dynamic inputs.
    // nanoBananaExecutor removes prompt from dynamicInputs to avoid duplication,
    // but the top-level prompt must still be sent to the API when dynamic inputs
    // are present (e.g., inpaint models with mask + prompt).
    const promptKey = paramMap.prompt || "prompt";
    if (input.prompt && !requestBody[promptKey]) {
      requestBody[promptKey] = input.prompt;
    }
  } else {
    // Fallback: use schema to map generic input names to model-specific parameter names
    if (input.prompt) {
      const promptParam = paramMap.prompt || "prompt";
      requestBody[promptParam] = input.prompt;
    }

    if (input.images && input.images.length > 0) {
      // Upload images to CDN before sending
      const uploadedImages = await Promise.all(
        input.images.map(img => uploadImageToFal(img, apiKey))
      );
      const imageParam = paramMap.image || "image_url";
      if (arrayParams.has("image")) {
        requestBody[imageParam] = uploadedImages;
      } else {
        requestBody[imageParam] = uploadedImages[0];
      }
    }

    // Map any parameters that might need renaming (use coerced values)
    const coercedParams = coerceParameterTypes(input.parameters, parameterTypes);
    for (const [key, value] of Object.entries(coercedParams)) {
      const mappedKey = paramMap[key] || key;
      requestBody[mappedKey] = value;
    }
  }

  // Build headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Key ${apiKey}`;
  }

  // Submit to queue
  console.log(`[API:${requestId}] Submitting to fal.ai queue with inputs: ${Object.keys(requestBody).join(", ")}`, JSON.stringify(requestBody, null, 2).slice(0, 1000));
  const submitResponse = await fetch(`https://queue.fal.run/${modelId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    let errorDetail = errorText || `HTTP ${submitResponse.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      if (typeof errorJson.error === 'object' && errorJson.error?.message) {
        errorDetail = errorJson.error.message;
      } else if (errorJson.detail) {
        if (Array.isArray(errorJson.detail)) {
          errorDetail = errorJson.detail.map((d: { msg?: string; loc?: string[] }) =>
            d.msg || JSON.stringify(d)
          ).join('; ');
        } else {
          errorDetail = errorJson.detail;
        }
      } else if (errorJson.message) {
        errorDetail = errorJson.message;
      } else if (typeof errorJson.error === 'string') {
        errorDetail = errorJson.error;
      }
    } catch {
      // Keep original text if not JSON
    }

    if (submitResponse.status === 429) {
      return {
        success: false,
        error: `${input.model.name}: Rate limit exceeded. ${apiKey ? "Try again in a moment." : "Add an API key in settings for higher limits."}`,
      };
    }

    return {
      success: false,
      error: `${input.model.name}: ${errorDetail}`,
    };
  }

  const submitResult = await submitResponse.json();
  console.log(`[API:${requestId}] Queue submit response:`, JSON.stringify(submitResult).substring(0, 500));
  const falRequestId = submitResult.request_id;

  if (!falRequestId) {
    console.error(`[API:${requestId}] No request_id in queue submit response`);
    return {
      success: false,
      error: "No request_id in queue response",
    };
  }

  // Use URLs from response if provided, with SSRF validation; fall back to constructed URLs
  const fallbackStatusUrl = `https://queue.fal.run/${modelId}/requests/${falRequestId}/status`;
  const fallbackResponseUrl = `https://queue.fal.run/${modelId}/requests/${falRequestId}`;
  let statusUrl = fallbackStatusUrl;
  let responseUrl = fallbackResponseUrl;

  if (submitResult.status_url) {
    const statusCheck = validateMediaUrl(submitResult.status_url);
    if (statusCheck.valid && submitResult.status_url.startsWith('https://queue.fal.run/')) {
      statusUrl = submitResult.status_url;
    } else {
      console.warn(`[API:${requestId}] fal.ai provided invalid status URL: ${submitResult.status_url} — falling back to constructed URL`);
    }
  }
  if (submitResult.response_url) {
    const responseCheck = validateMediaUrl(submitResult.response_url);
    if (responseCheck.valid && submitResult.response_url.startsWith('https://queue.fal.run/')) {
      responseUrl = submitResult.response_url;
    } else {
      console.warn(`[API:${requestId}] fal.ai provided invalid response URL: ${submitResult.response_url} — falling back to constructed URL`);
    }
  }

  console.log(`[API:${requestId}] Queue request submitted: ${falRequestId}, status URL: ${statusUrl}`);

  // Poll for completion
  const maxWaitTime = GENERATION_MAX_WAIT_MS;
  const pollInterval = 1000; // 1 second (matches Replicate/WaveSpeed)
  const startTime = Date.now();
  let lastStatus = "";

  while (true) {
    if (Date.now() - startTime > maxWaitTime) {
      console.error(`[API:${requestId}] Queue request timed out after 10 minutes`);
      return {
        success: false,
        error: `${input.model.name}: Video generation timed out after 10 minutes`,
      };
    }

    if (await waitUnlessCancelled(pollInterval, input.signal)) {
      // fal doesn't bill a request canceled while queued; one already
      // running gets the cancel too, and fal stops it where the model allows.
      await cancelUpstream(requestId, "fal", () =>
        fetch(`${responseUrl}/cancel`, {
          method: "PUT",
          headers: apiKey ? { "Authorization": `Key ${apiKey}` } : {},
        }));
      return cancelledOutput(requestId, "fal", true);
    }

    const statusResponse = await fetch(
      statusUrl,
      { headers: apiKey ? { "Authorization": `Key ${apiKey}` } : {} }
    );

    if (!statusResponse.ok) {
      console.error(`[API:${requestId}] Failed to poll status: ${statusResponse.status}`);
      return {
        success: false,
        error: `Failed to poll status: ${statusResponse.status}`,
      };
    }

    const statusResult = await statusResponse.json();
    const status = statusResult.status;
    // fal.ai exposes `queue_position` on the status response when status
    // is IN_QUEUE; absent / undefined once the worker picks up the job.
    const queuePosition = typeof statusResult.queue_position === "number"
      ? statusResult.queue_position
      : null;

    if (status !== lastStatus) {
      console.log(`[API:${requestId}] Queue status: ${status}${queuePosition != null ? ` (position ${queuePosition})` : ""}`);
      lastStatus = status;
    }
    // Emit on every poll — clients can throttle on their side. We send
    // queuePosition even when it's null so the UI can flip from "Queued
    // #3" → "Running…" smoothly without a stale position lingering.
    if (status === "IN_QUEUE") {
      onStatus?.({ phase: "queued", queuePosition });
    } else if (status === "IN_PROGRESS") {
      onStatus?.({ phase: "running", queuePosition: null });
    }

    if (status === "COMPLETED") {
      onStatus?.({ phase: "downloading", queuePosition: null });
      // Fetch the result
      const resultResponse = await fetch(
        responseUrl,
        { headers: apiKey ? { "Authorization": `Key ${apiKey}` } : {} }
      );

      if (!resultResponse.ok) {
        const errBody = await resultResponse.text().catch(() => "");
        console.error(`[API:${requestId}] Failed to fetch result: ${resultResponse.status}`, errBody);
        return {
          success: false,
          error: `Failed to fetch result: ${resultResponse.status}${errBody ? ` - ${errBody.slice(0, 200)}` : ""}`,
        };
      }

      const result = await resultResponse.json();

      // Extract media URL from result
      let mediaUrl: string | null = null;

      // Check for 3D model output (GLB/OBJ mesh) — must check before images
      if (result.model_mesh?.url) {
        mediaUrl = result.model_mesh.url;
      } else if (result.mesh?.url) {
        mediaUrl = result.mesh.url;
      } else if (result.glb?.url) {
        mediaUrl = result.glb.url;
      } else if (result.model_glb?.url) {
        mediaUrl = result.model_glb.url;
      } else if (result.model_obj?.url) {
        // OBJ format fallback (e.g., Hunyuan 3D v3.1/rapid)
        mediaUrl = result.model_obj.url;
      } else if (result.model_urls?.glb?.url) {
        mediaUrl = result.model_urls.glb.url;
      } else if (result.model_urls?.obj?.url) {
        // OBJ nested under model_urls
        mediaUrl = result.model_urls.obj.url;
      } else if (result.model_urls?.url) {
        // Direct URL on model_urls
        mediaUrl = result.model_urls.url;
      } else if (result.video && result.video.url) {
        mediaUrl = result.video.url;
      } else if (result.audio && result.audio.url) {
        mediaUrl = result.audio.url;
      } else if (result.images && Array.isArray(result.images) && result.images.length > 0) {
        mediaUrl = result.images[0].url;
      } else if (result.image && result.image.url) {
        mediaUrl = result.image.url;
      } else if (result.output && typeof result.output === "string") {
        mediaUrl = result.output;
      }

      if (!mediaUrl) {
        console.error(`[API:${requestId}] No media URL found in queue result. Result keys: ${Object.keys(result).join(", ")}, model_urls: ${JSON.stringify(result.model_urls)?.substring(0, 200)}`);
        return {
          success: false,
          error: "No media URL in response",
        };
      }

      const is3DModel = input.model.capabilities.some(c => c.includes("3d"));
      const isVideoModel = input.model.capabilities.some(c => c.includes("video"));
      const isAudioModel = input.model.capabilities.some(c => c.includes("audio"));

      // For 3D models, return URL directly (GLB files are binary — don't base64 encode)
      if (is3DModel) {
        console.log(`[API:${requestId}] SUCCESS - Returning 3D model URL`);
        return {
          success: true,
          outputs: [
            {
              type: "3d",
              data: "",
              url: mediaUrl,
            },
          ],
        };
      }

      // Validate URL before fetching (SSRF protection)
      const mediaUrlCheck = validateMediaUrl(mediaUrl);
      if (!mediaUrlCheck.valid) {
        return { success: false, error: `Invalid media URL: ${mediaUrlCheck.error}` };
      }

      // Fetch the media and convert to base64
      console.log(`[API:${requestId}] Fetching output from: ${mediaUrl.substring(0, 80)}...`);
      const mediaResponse = await fetch(mediaUrl);

      if (!mediaResponse.ok) {
        return {
          success: false,
          error: `Failed to fetch output: ${mediaResponse.status}`,
        };
      }

      // Detect actual media type from response content-type, falling back to model hints
      const rawContentType = mediaResponse.headers.get("content-type") || "";
      const isAudioResponse = rawContentType.startsWith("audio/") || (!rawContentType.startsWith("video/") && !rawContentType.startsWith("image/") && isAudioModel);

      if (isAudioResponse) {
        const audioContentType = rawContentType.startsWith("audio/") ? rawContentType : "audio/mpeg";
        const audioBuffer = await mediaResponse.arrayBuffer();
        const audioBase64 = Buffer.from(audioBuffer).toString("base64");
        console.log(`[API:${requestId}] SUCCESS - Returning audio`);
        return {
          success: true,
          outputs: [{
            type: "audio",
            data: `data:${audioContentType};base64,${audioBase64}`,
            url: mediaUrl,
          }],
        };
      }

      const contentType = rawContentType || (isVideoModel ? "video/mp4" : "image/png");
      const isVideo = contentType.startsWith("video/");

      const mediaArrayBuffer = await mediaResponse.arrayBuffer();
      const mediaSizeBytes = mediaArrayBuffer.byteLength;
      const mediaSizeMB = mediaSizeBytes / (1024 * 1024);

      console.log(`[API:${requestId}] Output: ${contentType}, ${mediaSizeMB.toFixed(2)}MB`);

      // For very large videos (>20MB), return URL only (data left empty for consumers)
      if (isVideo && mediaSizeMB > 20) {
        console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
        return {
          success: true,
          outputs: [
            {
              type: "video",
              data: "",
              url: mediaUrl,
            },
          ],
        };
      }

      const mediaBase64 = Buffer.from(mediaArrayBuffer).toString("base64");

      // Build the first output (always present)
      const firstOutput = {
        type: (isVideo ? "video" : "image") as "video" | "image",
        data: `data:${contentType};base64,${mediaBase64}`,
        url: mediaUrl,
      };

      // If this is an image response AND the API returned multiple images, fetch them all
      const outputs: Array<{ type: "video" | "image" | "audio" | "3d"; data: string; url?: string }> = [firstOutput];
      if (!isVideo && !isAudioModel && Array.isArray(result.images) && result.images.length > 1) {
        console.log(`[API:${requestId}] Model returned ${result.images.length} images, fetching all...`);
        // Fetch remaining images in parallel (skip index 0 — already fetched)
        const additional = await Promise.all(
          (result.images as Array<{ url: string }>).slice(1).map(async (img) => {
            try {
              const check = validateMediaUrl(img.url);
              if (!check.valid) return null;
              const resp = await fetch(img.url);
              if (!resp.ok) return null;
              const ct = resp.headers.get("content-type") || "image/png";
              const buf = await resp.arrayBuffer();
              const b64 = Buffer.from(buf).toString("base64");
              return { type: "image" as const, data: `data:${ct};base64,${b64}`, url: img.url };
            } catch (e) {
              console.warn(`[API:${requestId}] Failed to fetch additional image:`, e);
              return null;
            }
          })
        );
        for (const out of additional) {
          if (out) outputs.push(out);
        }
      }

      console.log(`[API:${requestId}] SUCCESS - Returning ${outputs.length} ${isVideo ? "video" : "image"}${outputs.length > 1 ? "s" : ""}`);
      return { success: true, outputs };
    }

    if (status === "FAILED") {
      const errorMessage = statusResult.error || "Video generation failed";
      console.error(`[API:${requestId}] Queue request failed: ${errorMessage}`);
      return {
        success: false,
        error: `${input.model.name}: ${errorMessage}`,
      };
    }

    // Continue polling for IN_QUEUE, IN_PROGRESS, etc.
  }
}
