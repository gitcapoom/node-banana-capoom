/**
 * API proxy for self-hosted Apple SHARP server (neosun/sharp Docker image).
 *
 * Converts base64 image data from the client to multipart form data
 * required by the SHARP REST API, and resolves relative file URLs
 * to absolute URLs on the SHARP server.
 *
 * Endpoints proxied:
 *   POST /api/predict   — image → 3D Gaussian Splat (.ply)
 *   GET  /health        — health check
 *   GET  /api/gpu/status — GPU info
 */

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300; // 5 minutes for generation
export const dynamic = "force-dynamic";

interface PredictAction {
  action: "predict";
  imageData: string; // base64 data URL
  serverUrl: string;
  renderVideo?: boolean;
}

interface HealthAction {
  action: "health";
  serverUrl: string;
}

interface StatusAction {
  action: "status";
  serverUrl: string;
}

type SharpRequest = PredictAction | HealthAction | StatusAction;

function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function handlePredict(body: PredictAction): Promise<NextResponse> {
  const serverUrl = normalizeServerUrl(body.serverUrl);

  // Strip data URL prefix to get raw base64
  const base64Match = body.imageData.match(
    /^data:image\/(\w+);base64,(.+)$/
  );
  if (!base64Match) {
    return NextResponse.json(
      { success: false, error: "Invalid image data format" },
      { status: 400 }
    );
  }

  const extension = base64Match[1]; // png, jpeg, etc.
  const rawBase64 = base64Match[2];
  const buffer = Buffer.from(rawBase64, "base64");

  // Build multipart form data
  const blob = new Blob([buffer], { type: `image/${extension}` });
  const formData = new FormData();
  formData.append("file", blob, `input.${extension}`);
  if (body.renderVideo) {
    formData.append("render_video", "true");
  }

  const response = await fetch(`${serverUrl}/api/predict`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    return NextResponse.json(
      {
        success: false,
        error: `SHARP server error (${response.status}): ${errorText}`,
      },
      { status: response.status }
    );
  }

  const result = await response.json();

  // Resolve relative URLs to absolute
  const plyUrl = result.ply_url
    ? result.ply_url.startsWith("http")
      ? result.ply_url
      : `${serverUrl}${result.ply_url}`
    : null;

  const videoUrl = result.video_url
    ? result.video_url.startsWith("http")
      ? result.video_url
      : `${serverUrl}${result.video_url}`
    : null;

  return NextResponse.json({
    success: true,
    plyUrl,
    videoUrl,
    taskId: result.task_id || null,
  });
}

async function handleHealth(body: HealthAction): Promise<NextResponse> {
  const serverUrl = normalizeServerUrl(body.serverUrl);
  try {
    const response = await fetch(`${serverUrl}/api/gpu/status`, {
      signal: AbortSignal.timeout(5000),
    });
    return NextResponse.json({ success: response.ok });
  } catch {
    return NextResponse.json({ success: false });
  }
}

async function handleStatus(body: StatusAction): Promise<NextResponse> {
  const serverUrl = normalizeServerUrl(body.serverUrl);
  try {
    const response = await fetch(`${serverUrl}/api/gpu/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return NextResponse.json({ success: false });
    }
    const data = await response.json();
    return NextResponse.json({ success: true, ...data });
  } catch {
    return NextResponse.json({ success: false });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: SharpRequest = await request.json();

    switch (body.action) {
      case "predict":
        return handlePredict(body);
      case "health":
        return handleHealth(body);
      case "status":
        return handleStatus(body);
      default:
        return NextResponse.json(
          { success: false, error: "Unknown action" },
          { status: 400 }
        );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
