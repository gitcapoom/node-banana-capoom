/**
 * WorldLabs API Route
 *
 * Handles 3D world generation via the WorldLabs Marble API.
 * Supports four actions:
 *   - "uploadImage" — Upload an image via media-assets:prepare_upload
 *   - "generate"    — Submit a world generation request
 *   - "poll"        — Check operation status
 *   - "getWorld"    — Retrieve completed world assets (SPZ URLs, thumbnail, etc.)
 *
 * Auth: Uses WLT-Api-Key header per WorldLabs API spec.
 * Key source: X-WorldLabs-Key header from client, or WORLDLABS_API_KEY env var.
 */
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300; // 5 minute timeout for long generation
export const dynamic = "force-dynamic";

const WORLDLABS_API_BASE = "https://api.worldlabs.ai/marble/v1";

/**
 * Get API key from header (browser-side override) or environment variable.
 */
function getApiKey(request: NextRequest): string | null {
  return (
    request.headers.get("X-WorldLabs-Key") ||
    process.env.WORLDLABS_API_KEY ||
    null
  );
}

// ─── Request Types ──────────────────────────────────────────────

interface UploadImageAction {
  action: "uploadImage";
  /** Base64-encoded image data (with or without data URL prefix) */
  imageData: string;
  /** File extension without dot, e.g. "png", "jpg" */
  extension?: string;
}

interface GenerateAction {
  action: "generate";
  /** "text" or "image" */
  promptType: "text" | "image";
  textPrompt?: string;
  /** media_asset_id from uploadImage action */
  mediaAssetId?: string;
  model: string;
  seed?: number | null;
  worldName?: string;
}

interface PollAction {
  action: "poll";
  operationId: string;
}

interface GetWorldAction {
  action: "getWorld";
  worldId: string;
}

type WorldLabsRequest = UploadImageAction | GenerateAction | PollAction | GetWorldAction;

// ─── POST Handler ───────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const requestId = Math.random().toString(36).substring(7);

  try {
    const apiKey = getApiKey(request);
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "WorldLabs API key not configured. Set WORLDLABS_API_KEY in .env.local or provide it in Project Settings." },
        { status: 401 }
      );
    }

    const body: WorldLabsRequest = await request.json();
    console.log(`[WorldLabs:${requestId}] Action: ${body.action}`);

    switch (body.action) {
      case "uploadImage":
        return handleUploadImage(apiKey, body, requestId);
      case "generate":
        return handleGenerate(apiKey, body, requestId);
      case "poll":
        return handlePoll(apiKey, body, requestId);
      case "getWorld":
        return handleGetWorld(apiKey, body, requestId);
      default:
        return NextResponse.json(
          { success: false, error: `Unknown action: ${(body as { action: string }).action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error(`[WorldLabs:${requestId}] Error:`, error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// ─── Upload Image via Media Assets ──────────────────────────────

async function handleUploadImage(
  apiKey: string,
  body: UploadImageAction,
  requestId: string
) {
  const { imageData, extension = "png" } = body;

  // Strip data URL prefix if present
  const base64 = imageData.includes(",") ? imageData.split(",")[1] : imageData;
  const buffer = Buffer.from(base64, "base64");

  // Determine content type from extension
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  };
  const contentType = mimeMap[extension] || "image/png";

  // Step 1: Prepare upload — get media_asset_id and signed upload URL
  console.log(`[WorldLabs:${requestId}] Preparing media asset upload (${(buffer.length / 1024).toFixed(1)}KB, ${extension})`);

  const prepareResponse = await fetch(`${WORLDLABS_API_BASE}/media-assets:prepare_upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "WLT-Api-Key": apiKey,
    },
    body: JSON.stringify({
      file_name: `input.${extension}`,
      extension,
      kind: "image",
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!prepareResponse.ok) {
    const errorText = await prepareResponse.text();
    console.error(`[WorldLabs:${requestId}] Prepare upload failed (${prepareResponse.status}):`, errorText);
    return NextResponse.json(
      { success: false, error: `Prepare upload failed (${prepareResponse.status}): ${errorText}` },
      { status: prepareResponse.status }
    );
  }

  const prepareData = await prepareResponse.json();

  // Response is nested: { media_asset: { media_asset_id, ... }, upload_info: { upload_url, required_headers, ... } }
  const mediaAssetId = prepareData.media_asset?.media_asset_id;
  const uploadUrl = prepareData.upload_info?.upload_url;
  const requiredHeaders = prepareData.upload_info?.required_headers;

  if (!mediaAssetId || !uploadUrl) {
    console.error(`[WorldLabs:${requestId}] Prepare upload returned incomplete data:`, JSON.stringify(prepareData, null, 2));
    return NextResponse.json(
      { success: false, error: "Prepare upload returned incomplete data" },
      { status: 500 }
    );
  }

  console.log(`[WorldLabs:${requestId}] Media asset prepared: ${mediaAssetId}`);

  // Step 2: Upload the file to the signed URL
  const uploadHeaders: Record<string, string> = {
    "Content-Type": contentType,
  };

  // Merge required headers from the prepare endpoint (e.g. x-goog-content-length-range)
  if (requiredHeaders && typeof requiredHeaders === "object") {
    for (const [key, value] of Object.entries(requiredHeaders)) {
      if (typeof value === "string") {
        uploadHeaders[key] = value;
      }
    }
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: uploadHeaders,
    body: buffer,
    signal: AbortSignal.timeout(60_000),
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    console.error(`[WorldLabs:${requestId}] File upload failed (${uploadResponse.status}):`, errorText);
    return NextResponse.json(
      { success: false, error: `File upload failed (${uploadResponse.status}): ${errorText}` },
      { status: uploadResponse.status }
    );
  }

  console.log(`[WorldLabs:${requestId}] Image uploaded to media asset ${mediaAssetId}`);

  return NextResponse.json({
    success: true,
    mediaAssetId,
  });
}

// ─── Generate ───────────────────────────────────────────────────

async function handleGenerate(
  apiKey: string,
  body: GenerateAction,
  requestId: string
) {
  // Build the world_prompt based on prompt type
  interface WorldPrompt {
    type: string;
    text_prompt?: string;
    image_prompt?: {
      source: string;
      media_asset_id: string;
    };
  }

  const worldPrompt: WorldPrompt = {
    type: body.promptType,
  };

  // Text prompt (works for both "text" and "image" types — optional caption for images)
  if (body.textPrompt) {
    worldPrompt.text_prompt = body.textPrompt;
  }

  // Image prompt via media asset
  if (body.mediaAssetId && body.promptType === "image") {
    worldPrompt.image_prompt = {
      source: "media_asset",
      media_asset_id: body.mediaAssetId,
    };
  }

  const requestBody: Record<string, unknown> = {
    display_name: body.worldName || "",
    model: body.model,
    world_prompt: worldPrompt,
  };

  if (body.seed != null) {
    requestBody.seed = body.seed;
  }

  console.log(`[WorldLabs:${requestId}] Generating world with model ${body.model}`);

  const response = await fetch(`${WORLDLABS_API_BASE}/worlds:generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "WLT-Api-Key": apiKey,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(60_000), // 60s for the initial submission
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[WorldLabs:${requestId}] Generate failed (${response.status}):`, errorText);
    return NextResponse.json(
      { success: false, error: `WorldLabs API error (${response.status}): ${errorText}` },
      { status: response.status }
    );
  }

  const data = await response.json();
  console.log(`[WorldLabs:${requestId}] Generation submitted, operationId:`, data.name);

  return NextResponse.json({
    success: true,
    operationId: data.name, // The operation ID for polling
  });
}

// ─── Poll ───────────────────────────────────────────────────────

async function handlePoll(
  apiKey: string,
  body: PollAction,
  requestId: string
) {
  const response = await fetch(
    `${WORLDLABS_API_BASE}/operations/${body.operationId}`,
    {
      method: "GET",
      headers: {
        "WLT-Api-Key": apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[WorldLabs:${requestId}] Poll failed (${response.status}):`, errorText);
    return NextResponse.json(
      { success: false, error: `Poll error (${response.status}): ${errorText}` },
      { status: response.status }
    );
  }

  const data = await response.json();

  // Extract world ID from the response if done
  let worldId: string | null = null;
  if (data.done && data.response?.world_id) {
    worldId = data.response.world_id;
  }

  console.log(
    `[WorldLabs:${requestId}] Poll: done=${data.done}${worldId ? `, worldId=${worldId}` : ""}`
  );

  return NextResponse.json({
    success: true,
    done: !!data.done,
    worldId,
    error: data.error ? JSON.stringify(data.error) : null,
  });
}

// ─── Get World ──────────────────────────────────────────────────

async function handleGetWorld(
  apiKey: string,
  body: GetWorldAction,
  requestId: string
) {
  const response = await fetch(
    `${WORLDLABS_API_BASE}/worlds/${body.worldId}`,
    {
      method: "GET",
      headers: {
        "WLT-Api-Key": apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[WorldLabs:${requestId}] GetWorld failed (${response.status}):`, errorText);
    return NextResponse.json(
      { success: false, error: `GetWorld error (${response.status}): ${errorText}` },
      { status: response.status }
    );
  }

  const data = await response.json();
  console.log(`[WorldLabs:${requestId}] World data retrieved:`, data.world_id);

  // Extract SPZ URLs from different quality levels
  const spzUrls = {
    full: data.spz_urls?.full || null,
    medium: data.spz_urls?.medium || null,
    low: data.spz_urls?.low || null,
  };

  return NextResponse.json({
    success: true,
    worldId: data.world_id,
    spzUrls,
    thumbnailUrl: data.thumbnail_url || null,
    marbleViewerUrl: data.marble_viewer_url || null,
    caption: data.caption || null,
  });
}
