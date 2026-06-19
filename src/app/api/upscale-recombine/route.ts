import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Upscale-recombine route.
 *
 * Takes four generated quadrant images (upper-left, upper-right, lower-left,
 * lower-right) — each an enlarged 10%-overlap crop of the original — and blends
 * them back into a single high-resolution image with feathered seams.
 *
 * Geometry (all derived from the 10% overlap rule):
 *   - Final canvas preserves the input aspect ratio, long edge = finalLongEdge.
 *   - Each quadrant is Lanczos-resized to 55% × 55% of the canvas
 *     (= (finalEdge / 2) × 1.10).
 *   - Horizontal blend band = 2·qw − finalW = 10% of finalW.
 *   - Vertical   blend band = 2·qh − finalH = 10% of finalH.
 *
 * Blend procedure (matches the requested algorithm):
 *   1. Bottom half: composite LL (opaque), then LR with a left→right alpha ramp
 *      across the horizontal band → smooth L/R seam.
 *   2. Top half: same with UL / UR.
 *   3. Final: composite the bottom half (opaque), then the top half with a
 *      top→bottom alpha ramp across the vertical band → smooth top/bottom seam.
 */

type Quadrants = { ul: string; ur: string; ll: string; lr: string };

interface RecombineRequest {
  quadrants: Quadrants;
  inputWidth: number;
  inputHeight: number;
  overlapPercent?: number;   // default 10
  finalLongEdge?: number;    // default 8192
  generationsPath?: string;  // when set, the full-res PNG is baked here and only an imageId + thumbnail returned
}

// Decode a data URL or fetch an http(s) URL into a Buffer.
async function toBuffer(src: string): Promise<Buffer> {
  if (src.startsWith("data:")) {
    const comma = src.indexOf(",");
    const b64 = src.slice(comma + 1);
    return Buffer.from(b64, "base64");
  }
  const resp = await fetch(src);
  if (!resp.ok) throw new Error(`Failed to fetch quadrant image: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// A single row of alpha that ramps 0→255 across the first `ramp` pixels, then 255.
function rampRowLeft(w: number, ramp: number): Buffer {
  const row = Buffer.alloc(w);
  for (let x = 0; x < w; x++) {
    row[x] = x < ramp ? Math.round((x / ramp) * 255) : 255;
  }
  return row;
}

// Tile a single alpha row down `h` rows → full (w×h) single-channel buffer.
function tileRow(row: Buffer, w: number, h: number): Buffer {
  const a = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) row.copy(a, y * w);
  return a;
}

// Per-row alpha column: 255 until (h − ramp), then ramps 255→0 across the last
// `ramp` rows. Used to fade the top half into the bottom half.
function rampColTop(h: number, ramp: number): Buffer {
  const col = Buffer.alloc(h);
  for (let y = 0; y < h; y++) {
    col[y] = y < h - ramp ? 255 : Math.round(((h - y) / ramp) * 255);
  }
  return col;
}

// Expand a per-row alpha column into a full (w×h) single-channel buffer.
function colToBuffer(col: Buffer, w: number, h: number): Buffer {
  const a = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) a.fill(col[y], y * w, (y + 1) * w);
  return a;
}

// Resize a source image to w×h (Lanczos) → opaque PNG buffer.
async function resizedPng(src: string, w: number, h: number): Promise<Buffer> {
  const buf = await toBuffer(src);
  return sharp(buf)
    .resize(w, h, { fit: "fill", kernel: "lanczos3" })
    .removeAlpha()
    .png()
    .toBuffer();
}

// Resize a source image to w×h (Lanczos), then attach a left→right alpha ramp.
async function resizedWithLeftRamp(src: string, w: number, h: number, ramp: number): Promise<Buffer> {
  const buf = await toBuffer(src);
  const rgb = await sharp(buf)
    .resize(w, h, { fit: "fill", kernel: "lanczos3" })
    .removeAlpha()
    .raw()
    .toBuffer();
  const alpha = tileRow(rampRowLeft(w, ramp), w, h);
  return sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
    .joinChannel(alpha, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toBuffer();
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RecombineRequest;
    const { quadrants, inputWidth, inputHeight, generationsPath } = body;
    const overlapPercent = body.overlapPercent ?? 10;
    const finalLongEdge = body.finalLongEdge ?? 8192;

    if (!quadrants?.ul || !quadrants?.ur || !quadrants?.ll || !quadrants?.lr) {
      return NextResponse.json({ success: false, error: "Missing one or more quadrant images" }, { status: 400 });
    }
    if (!inputWidth || !inputHeight) {
      return NextResponse.json({ success: false, error: "Missing input dimensions" }, { status: 400 });
    }

    const f = 1 + overlapPercent / 100;

    // Final canvas: preserve aspect, long edge = finalLongEdge.
    let finalW: number;
    let finalH: number;
    if (inputWidth >= inputHeight) {
      finalW = finalLongEdge;
      finalH = Math.round((finalLongEdge * inputHeight) / inputWidth);
    } else {
      finalH = finalLongEdge;
      finalW = Math.round((finalLongEdge * inputWidth) / inputHeight);
    }

    // Quadrant target size = half-canvas × overlap factor.
    const qw = Math.round((finalW / 2) * f);
    const qh = Math.round((finalH / 2) * f);

    // Blend bands (clamp to ≥1 to avoid divide-by-zero on degenerate sizes).
    const ovX = Math.max(1, 2 * qw - finalW);
    const ovY = Math.max(1, 2 * qh - finalH);

    // ── Bottom half: LL (opaque) + LR (left ramp) ──
    const [llPng, lrPng] = await Promise.all([
      resizedPng(quadrants.ll, qw, qh),
      resizedWithLeftRamp(quadrants.lr, qw, qh, ovX),
    ]);
    const bottomHalf = await sharp({
      create: { width: finalW, height: qh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        { input: llPng, left: 0, top: 0 },
        { input: lrPng, left: finalW - qw, top: 0 },
      ])
      .png()
      .toBuffer();

    // ── Top half: UL (opaque) + UR (left ramp) ──
    const [ulPng, urPng] = await Promise.all([
      resizedPng(quadrants.ul, qw, qh),
      resizedWithLeftRamp(quadrants.ur, qw, qh, ovX),
    ]);
    const topHalfOpaque = await sharp({
      create: { width: finalW, height: qh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        { input: ulPng, left: 0, top: 0 },
        { input: urPng, left: finalW - qw, top: 0 },
      ])
      .png()
      .toBuffer();

    // Attach a top→bottom vertical ramp to the top half so it fades into the
    // bottom half across the vertical band.
    const topRgb = await sharp(topHalfOpaque).removeAlpha().raw().toBuffer();
    const topAlpha = colToBuffer(rampColTop(qh, ovY), finalW, qh);
    const topRampPng = await sharp(topRgb, { raw: { width: finalW, height: qh, channels: 3 } })
      .joinChannel(topAlpha, { raw: { width: finalW, height: qh, channels: 1 } })
      .png()
      .toBuffer();

    // ── Final composite ──
    const finalBuf = await sharp({
      create: { width: finalW, height: finalH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .composite([
        { input: bottomHalf, left: 0, top: finalH - qh },
        { input: topRampPng, left: 0, top: 0 },
      ])
      .png()
      .toBuffer();

    // Small thumbnail for the node preview (full-res only loads on double-click).
    const thumbBuf = await sharp(finalBuf)
      .resize(768, 768, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    const thumbnail = `data:image/jpeg;base64,${thumbBuf.toString("base64")}`;

    // Bake the full-res PNG into the generations folder (same as other generator
    // nodes) and return only a lightweight imageId + thumbnail — so the heavy
    // 8K data URL never travels back through the browser or lives in node state.
    if (generationsPath) {
      try {
        const hash = crypto.createHash("md5").update(finalBuf).digest("hex");
        const filename = `upscale_${hash}.png`;
        const imageId = `upscale_${hash}`;
        await fs.mkdir(generationsPath, { recursive: true });
        const filePath = path.join(generationsPath, filename);
        try {
          await fs.access(filePath); // dedup: identical content already saved
        } catch {
          await fs.writeFile(filePath, finalBuf);
        }
        return NextResponse.json({
          success: true,
          imageId,
          filename,
          thumbnail,
          width: finalW,
          height: finalH,
          baked: true,
        });
      } catch (saveErr) {
        // Fall through to returning the data URL if the save fails.
        console.warn("[upscale-recombine] generations save failed, returning data URL:", saveErr);
      }
    }

    const dataUrl = `data:image/png;base64,${finalBuf.toString("base64")}`;
    return NextResponse.json({
      success: true,
      image: dataUrl,
      thumbnail,
      width: finalW,
      height: finalH,
      baked: false,
    });
  } catch (error) {
    console.error("[upscale-recombine] failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Recombine failed" },
      { status: 500 }
    );
  }
}
