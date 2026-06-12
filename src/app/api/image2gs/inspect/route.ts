import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/utils/logger";

export const runtime = "nodejs";
export const maxDuration = 120;

const SHARP_BACKEND_URL = process.env.SHARP_BACKEND_URL || "http://127.0.0.1:8765";

/**
 * POST /api/image2gs/inspect
 *
 * Proxies a depth `.exr` (multipart field `depth`) to the SHARP service's
 * /inspect endpoint, which enumerates the EXR's channels, picks a default
 * depth channel, and renders an 8-bit grayscale preview.
 *
 * Returns: { success, channels[], defaultChannel, width, height, preview_png }.
 */
export async function POST(request: NextRequest) {
  let inForm: FormData;
  try {
    inForm = await request.formData();
  } catch {
    return NextResponse.json(
      { success: false, error: "Expected multipart/form-data" },
      { status: 400 },
    );
  }

  const outForm = new FormData();
  for (const [key, value] of inForm.entries()) {
    outForm.append(key, value as string | Blob);
  }

  let backendRes: Response;
  try {
    backendRes = await fetch(`${SHARP_BACKEND_URL}/inspect`, {
      method: "POST",
      body: outForm,
    });
  } catch (err) {
    logger.warn("api.error", "SHARP backend unreachable (inspect)", {
      url: SHARP_BACKEND_URL,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        success: false,
        error:
          `SHARP backend unreachable at ${SHARP_BACKEND_URL}. ` +
          `Check the SHARP service is running on the assigned machine and reachable from this server ` +
          `(set SHARP_BACKEND_URL to its host:port). ` +
          `(${err instanceof Error ? err.message : "connection failed"})`,
      },
      { status: 502 },
    );
  }

  if (!backendRes.ok) {
    let msg = `SHARP backend error (HTTP ${backendRes.status})`;
    try {
      const j = await backendRes.json();
      msg = j.error || j.detail || msg;
    } catch {
      const t = await backendRes.text().catch(() => "");
      if (t) msg += ` - ${t.slice(0, 300)}`;
    }
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }

  const data = await backendRes.json();
  return NextResponse.json({ success: true, ...data });
}
