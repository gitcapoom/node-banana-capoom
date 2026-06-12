import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/utils/logger";

export const runtime = "nodejs";
// First call downloads the SHARP checkpoint (~minutes); steady-state ~4 s.
export const maxDuration = 300;

const SHARP_BACKEND_URL = process.env.SHARP_BACKEND_URL || "http://127.0.0.1:8765";

const unreachable = (err: unknown) =>
  NextResponse.json(
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

/**
 * POST /api/image2gs
 *
 * Proxies an RGB image + metric-depth EXR (multipart/form-data) to the local
 * SHARP FastAPI service's /generate endpoint and streams back the resulting
 * `.ply` Gaussian splat.
 *
 * Request fields (multipart):
 *   rgb           File   — RGB image (png/jpg)
 *   depth         File   — metric depth `.exr`
 *   depth_channel string — channel name to read as depth ("" = auto)
 *   focal_mm      string — focal length (mm)
 *   aperture_mm   string — horizontal film-back aperture (mm)
 *   f_px          string — optional explicit f_px override
 *   blend_alpha   string — metric anchor blend (0..1)
 *
 * Success: 200, application/octet-stream — the raw `.ply` bytes.
 * Failure: 502, JSON { success:false, error }.
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

  // Rebuild the form for the upstream request.
  const outForm = new FormData();
  for (const [key, value] of inForm.entries()) {
    outForm.append(key, value as string | Blob);
  }

  let backendRes: Response;
  try {
    backendRes = await fetch(`${SHARP_BACKEND_URL}/generate`, {
      method: "POST",
      body: outForm,
    });
  } catch (err) {
    logger.warn("api.error", "SHARP backend unreachable", {
      url: SHARP_BACKEND_URL,
      error: err instanceof Error ? err.message : String(err),
    });
    return unreachable(err);
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
    logger.warn("api.error", "SHARP backend returned error", { status: backendRes.status, msg });
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }

  const buf = Buffer.from(await backendRes.arrayBuffer());
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="splat.ply"',
    },
  });
}
