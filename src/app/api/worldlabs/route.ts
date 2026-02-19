/**
 * WorldLabs API Route
 *
 * Handles 3D world generation via the WorldLabs Marble API.
 * Supports three actions:
 *   - "generate" — Submit a world generation request
 *   - "poll"     — Check operation status
 *   - "getWorld" — Retrieve completed world assets (SPZ URLs, thumbnail, etc.)
 *
 * Auth: Reads WORLDLABS_API_KEY from env or X-WorldLabs-Key header.
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

interface GenerateAction {
  action: "generate";
  /** "text_prompt", "image_source", or "text_and_image" */
  promptType: "text_prompt" | "image_source" | "text_and_image";
  textPrompt?: string;
  /** Public URL of the source image (must be accessible by WorldLabs) */
  imageUrl?: string;
  model: "wl-marble-0.1-plus" | "wl-marble-0.1-mini";
  seed?: number | null;
}

interface PollAction {
  action: "poll";
  operationId: string;
}

interface GetWorldAction {
  action: "getWorld";
  worldId: string;
}

type WorldLabsRequest = GenerateAction | PollAction | GetWorldAction;

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
    source?: { type: string; url: string };
  }

  const worldPrompt: WorldPrompt = {
    type: body.promptType,
  };

  if (body.textPrompt && (body.promptType === "text_prompt" || body.promptType === "text_and_image")) {
    worldPrompt.text_prompt = body.textPrompt;
  }

  if (body.imageUrl && (body.promptType === "image_source" || body.promptType === "text_and_image")) {
    worldPrompt.source = {
      type: "image_url",
      url: body.imageUrl,
    };
  }

  const requestBody: Record<string, unknown> = {
    world_prompt: worldPrompt,
    model: body.model,
  };

  if (body.seed != null) {
    requestBody.seed = body.seed;
  }

  console.log(`[WorldLabs:${requestId}] Generating world with model ${body.model}`);

  const response = await fetch(`${WORLDLABS_API_BASE}/worlds:generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
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
        Authorization: `Bearer ${apiKey}`,
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
        Authorization: `Bearer ${apiKey}`,
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
