/**
 * Comp orchestration — shared by the headless executor, the CompNode live
 * preview, and the CompModal. Resolves each of the 4 inputs to a float texture
 * (when the upstream produced one) or an 8-bit URL, drives the GPU compositor
 * in colorChain.ts, and flattens to an 8-bit PNG for `outputImage`.
 *
 * Falls back to a Canvas2D "over"+transform path when GPU float rendering is
 * unavailable, so the node still works (without exotic ops / external alpha).
 */

import type { CompNodeData } from "@/types";
import { COMP_OP_INDEX, defaultCompTransform } from "@/types/comp";
import {
  renderComp,
  floatNodeToDataUrl,
  floatSupported,
  hasFloat,
  type CompRenderInputs,
  type CompRenderParams,
  type CompResolvable,
} from "./colorChain";
import { getImageDimensions } from "./nodeDimensions";
import { computePieces, forwardCorners } from "./compTransform";

/** url + producing node id → float texture if available, else the url. */
export function resolveInputRef(url: string | null, srcNodeId: string | null): CompResolvable | null {
  if (srcNodeId && hasFloat(srcNodeId)) return { floatNodeId: srcNodeId };
  if (url) return { url };
  return null;
}

export interface CompInputUrls { bg: string | null; bgAlpha: string | null; fg: string | null; fgAlpha: string | null; matte: string | null }
export interface CompInputSrcs { bgSrc: string | null; baSrc: string | null; fgSrc: string | null; faSrc: string | null; mtSrc: string | null }

export function buildCompInputs(urls: CompInputUrls, srcs: CompInputSrcs): CompRenderInputs {
  return {
    bg: resolveInputRef(urls.bg, srcs.bgSrc),
    bgAlpha: resolveInputRef(urls.bgAlpha, srcs.baSrc),
    fg: resolveInputRef(urls.fg, srcs.fgSrc),
    fgAlpha: resolveInputRef(urls.fgAlpha, srcs.faSrc),
    matte: resolveInputRef(urls.matte, srcs.mtSrc),
  };
}

export function buildCompParams(data: CompNodeData): CompRenderParams {
  const idt = defaultCompTransform();
  // Merge against defaults so a legacy/partial transform can't reach the shader
  // with undefined fields (which would become NaN uniforms).
  const T = (t?: Partial<import("@/types/comp").CompTransform>) => ({ ...idt, ...(t ?? {}) });
  return {
    op: COMP_OP_INDEX[data.mergeOp] ?? 0,
    bgTransform: T(data.bgTransform),
    bgAlphaTransform: T(data.bgAlphaTransform),
    fgTransform: T(data.fgTransform),
    fgAlphaTransform: T(data.fgAlphaTransform),
    matteTransform: T(data.matteTransform),
    bgAlphaReformat: data.bgAlphaReformat ?? "none",
    fgAlphaReformat: data.fgAlphaReformat ?? "none",
    matteReformat: data.matteReformat ?? "none",
    premultFg: data.premultiplyFg ?? false,
    premultBg: data.premultiplyBg ?? false,
    bgBlackOutside: data.bgBlackOutside ?? true,
    fgBlackOutside: data.fgBlackOutside ?? true,
    swapBgFg: data.swapBgFg ?? false,
    outputResolution: data.outputResolution ?? "bg",
    bgOpacity: data.bgOpacity ?? 1,
    fgOpacity: data.fgOpacity ?? 1,
  };
}

/**
 * Commit path for the executor / node: composite at BG resolution, publish the
 * float texture under `nodeId`, and return the 8-bit PNG + output dims.
 */
export async function compositeCompForExecutor(
  urls: CompInputUrls,
  srcs: CompInputSrcs,
  data: CompNodeData,
  nodeId: string,
): Promise<{ dataUrl: string; outW: number; outH: number }> {
  if (!urls.bg) return { dataUrl: "", outW: 0, outH: 0 };

  if (floatSupported()) {
    const inputs = buildCompInputs(urls, srcs);
    const res = await renderComp(inputs, buildCompParams(data), nodeId);
    if (res) {
      const dataUrl = (await floatNodeToDataUrl(nodeId)) ?? urls.bg;
      return { dataUrl, outW: res.w, outH: res.h };
    }
  }
  // Canvas2D fallback: now honours matte + alpha pins, but transforms/ops are
  // approximate. Warn so we can tell when the GPU path didn't run.
  console.warn("[comp] GPU float render unavailable — using Canvas2D fallback", { nodeId });
  return compositeFallback(urls, data);
}

// ── Canvas2D fallback (float unsupported): BG + optional FG "over" w/ transform ──

/** Solve the 2×3 affine (setTransform a,b,c,d,e,f) mapping 3 src→dst points. */
function solveAffine(
  src: Array<{ x: number; y: number }>,
  dst: Array<{ x: number; y: number }>,
): [number, number, number, number, number, number] | null {
  const [s0, s1, s2] = src;
  const det = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  // Barycentric-style solve for the linear part + translation.
  const A = ((dst[1].x - dst[0].x) * (s2.y - s0.y) - (dst[2].x - dst[0].x) * (s1.y - s0.y)) * inv;
  const C = ((dst[2].x - dst[0].x) * (s1.x - s0.x) - (dst[1].x - dst[0].x) * (s2.x - s0.x)) * inv;
  const B = ((dst[1].y - dst[0].y) * (s2.y - s0.y) - (dst[2].y - dst[0].y) * (s1.y - s0.y)) * inv;
  const D = ((dst[2].y - dst[0].y) * (s1.x - s0.x) - (dst[1].y - dst[0].y) * (s2.x - s0.x)) * inv;
  const E = dst[0].x - A * s0.x - C * s0.y;
  const F = dst[0].y - B * s0.x - D * s0.y;
  return [A, B, C, D, E, F];
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("comp fallback loadImage failed"));
    img.src = src;
  });
}

/**
 * Build a canvas whose ALPHA equals the luminance of `url` (rgb set to white),
 * sized W×H (stretched to fit). Used to apply an external alpha (Matte /
 * BG_Alpha / FG_Alpha pin) to a layer via "destination-in".
 */
async function lumToAlphaCanvas(url: string, W: number, H: number): Promise<HTMLCanvasElement | null> {
  try {
    const img = await loadImg(url);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const cx = c.getContext("2d", { willReadFrequently: true });
    if (!cx) return null;
    cx.drawImage(img, 0, 0, W, H);
    const id = cx.getImageData(0, 0, W, H);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.round((lum * d[i + 3]) / 255);
    }
    cx.putImageData(id, 0, 0);
    return c;
  } catch {
    return null;
  }
}

/** Multiply a canvas's alpha by a luminance mask (Matte / Alpha pin). */
function applyAlphaMask(ctx: CanvasRenderingContext2D, mask: HTMLCanvasElement | null) {
  if (!mask) return;
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
}

async function compositeFallback(urls: CompInputUrls, data: CompNodeData): Promise<{ dataUrl: string; outW: number; outH: number }> {
  const bgDims = await getImageDimensions(urls.bg!);
  if (!bgDims) return { dataUrl: urls.bg!, outW: 0, outH: 0 };
  const { width: W, height: H } = bgDims;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { dataUrl: urls.bg!, outW: W, outH: H };

  // BG (faded by BG opacity), then its external alpha pin (BG_Alpha) if present.
  const bg = await loadImg(urls.bg!);
  ctx.globalAlpha = data.bgOpacity ?? 1;
  ctx.drawImage(bg, 0, 0, W, H);
  ctx.globalAlpha = 1;
  if (urls.bgAlpha) applyAlphaMask(ctx, await lumToAlphaCanvas(urls.bgAlpha, W, H));

  // FG composited at its own size (with FG_Alpha applied), then drawn transformed.
  if (urls.fg) {
    try {
      const fg = await loadImg(urls.fg);
      const iw = fg.naturalWidth, ih = fg.naturalHeight;
      const fgCanvas = document.createElement("canvas");
      fgCanvas.width = iw; fgCanvas.height = ih;
      const fctx = fgCanvas.getContext("2d");
      if (fctx) {
        fctx.drawImage(fg, 0, 0);
        if (urls.fgAlpha) applyAlphaMask(fctx, await lumToAlphaCanvas(urls.fgAlpha, iw, ih));
        const p = computePieces(data.fgTransform, "none", iw, ih, iw, ih);
        // Forward corners (output bottom-left) → canvas top-left (y = H - y).
        const c = forwardCorners(p).map((o) => ({ x: o.x, y: H - o.y }));
        const srcTL = [{ x: 0, y: ih }, { x: iw, y: ih }, { x: iw, y: 0 }];
        const m = solveAffine(srcTL, [c[0], c[1], c[2]]);
        if (m) {
          ctx.save();
          ctx.globalAlpha = data.fgOpacity ?? 1;
          ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
          ctx.drawImage(fgCanvas, 0, 0);
          ctx.restore();
        }
      }
    } catch { /* ignore FG fallback errors — keep BG */ }
  }

  // Matte limits the whole result's alpha by its luminance.
  if (urls.matte) applyAlphaMask(ctx, await lumToAlphaCanvas(urls.matte, W, H));

  return { dataUrl: canvas.toDataURL("image/png"), outW: W, outH: H };
}
