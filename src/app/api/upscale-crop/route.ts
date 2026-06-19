import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Upscale-crop route.
 *
 * Splits an input image into 4 corner quadrants — each the input's aspect
 * ratio, enlarged by `overlapPercent` (default 10%) and anchored to its corner
 * extending inward. Cropping is done with sharp (server-side) so it is exact
 * and free of browser canvas / CORS quirks.
 *
 * Returns the 4 crops as PNG data URLs plus the input dimensions (the executor
 * needs W/H to drive the recombine geometry).
 */

async function toBuffer(src: string): Promise<Buffer> {
  if (src.startsWith("data:")) {
    return Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
  }
  const resp = await fetch(src);
  if (!resp.ok) throw new Error(`Failed to fetch input image: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { image: string; overlapPercent?: number };
    if (!body.image) {
      return NextResponse.json({ success: false, error: "Missing input image" }, { status: 400 });
    }
    const overlapPercent = body.overlapPercent ?? 10;

    const buf = await toBuffer(body.image);
    const meta = await sharp(buf).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) {
      return NextResponse.json({ success: false, error: "Could not read image dimensions" }, { status: 400 });
    }

    const f = 1 + overlapPercent / 100;
    const cw = Math.min(W, Math.round((W / 2) * f));
    const ch = Math.min(H, Math.round((H / 2) * f));

    // Corner-anchored regions: UL, UR, LL, LR
    const regions = [
      { left: 0, top: 0 },                 // UL
      { left: W - cw, top: 0 },            // UR
      { left: 0, top: H - ch },            // LL
      { left: W - cw, top: H - ch },       // LR
    ];

    const crops = await Promise.all(
      regions.map(async (r) => {
        const out = await sharp(buf)
          .extract({ left: r.left, top: r.top, width: cw, height: ch })
          .png()
          .toBuffer();
        return `data:image/png;base64,${out.toString("base64")}`;
      })
    );

    return NextResponse.json({
      success: true,
      quadrants: { ul: crops[0], ur: crops[1], ll: crops[2], lr: crops[3] },
      width: W,
      height: H,
      cropWidth: cw,
      cropHeight: ch,
    });
  } catch (error) {
    console.error("[upscale-crop] failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Crop failed" },
      { status: 500 }
    );
  }
}
