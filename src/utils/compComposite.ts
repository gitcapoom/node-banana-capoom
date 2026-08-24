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
import {
  COMP_OP_INDEX, defaultCompTransform, defaultCompFilter, defaultCompResample,
  normalizeCompLayerColor, type CompInputFilter, type CompLayerColor,
} from "@/types/comp";
import { GRADE_SHADER, HSV_SHADER } from "./imageShaders";
import { processImageWithShader } from "./webglProcess";
import { isIdentityGrade } from "./colorGrade";
import {
  renderComp,
  floatNodeToDataUrl,
  floatSupported,
  hasFloat,
  isCompColorIdentity,
  isIdentityHsv,
  type CompRenderInputs,
  type CompRenderParams,
  type CompResolvable,
} from "./colorChain";
import { getImageDimensions } from "./nodeDimensions";
import { computePieces, computeAlignedPieces, deriveAlignBase, forwardCorners, type CompAlignSpec } from "./compTransform";
import { parseCropMetadata, type CropMetadata } from "./cropMetadata";

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

/**
 * What the FG auto-align resolves to for this comp — the single answer every
 * consumer asks for, so the render, the editor's handles and the Canvas2D
 * fallback cannot disagree about where the patch goes.
 *
 * `spec` is what the compositor needs; `meta` and `blocked` exist for the
 * editor, which has to explain itself: a disabled checkbox with no stated reason
 * is the thing this feature is not allowed to ship.
 */
export interface FgAlignResolution {
  /** Non-null only when align can actually run. */
  spec: CompAlignSpec | null;
  /** Parsed pin payload, whether or not align is on. */
  meta: CropMetadata | null;
  /** Why align CANNOT run, for the UI. Null when it can — including when the
   *  user has simply switched it off, which is a choice, not a blockage. */
  blocked: string | null;
}

export function resolveFgAlign(data: CompNodeData): FgAlignResolution {
  const meta = parseCropMetadata(data.fgAlignMeta);
  // Output-from-FG makes the output frame the FG's OWN size, so there is no
  // BG-space rect to align into — the placement would be meaningless rather
  // than merely wrong. Blocked, never silently coerced: the user's
  // `outputResolution` is theirs to set.
  const blocked =
    (data.outputResolution ?? "bg") === "fg"
      ? "Output res is FG — the frame is the FG's own size, so there is no BG region to align into."
      : !meta
        ? "No crop metadata on the Align pin — connect an Image Crop node's text output."
        : null;
  if (blocked || !meta || (data.fgAlign ?? "auto") === "off") return { spec: null, meta, blocked };
  return {
    spec: {
      crop: meta.crop,
      region: meta.region,
      srcW: meta.sourceWidth,
      srcH: meta.sourceHeight,
      fit: data.fgAlignFit ?? "fit",
    },
    meta,
    blocked: null,
  };
}

export function buildCompParams(data: CompNodeData): CompRenderParams {
  const idt = defaultCompTransform();
  // Merge against defaults so a legacy/partial transform can't reach the shader
  // with undefined fields (which would become NaN uniforms).
  const T = (t?: Partial<import("@/types/comp").CompTransform>) => ({ ...idt, ...(t ?? {}) });
  const idf: CompInputFilter = { ...defaultCompFilter(), filter: "none" };
  const Fm = (f?: Partial<CompInputFilter>) => ({ ...idf, ...(f ?? {}) });
  const { spec: fgAlign } = resolveFgAlign(data);
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
    // Description only — this function has no image access, so the scale cannot
    // be computed here. compUniforms holds the decoded sizes and finishes it.
    // Absent (not null) when align is off/blocked, so the field never reaches a
    // consumer half-built.
    ...(fgAlign ? { fgAlign } : {}),
    bgOpacity: data.bgOpacity ?? 1,
    fgOpacity: data.fgOpacity ?? 1,
    // Passed through unconditionally. The "an FG_Alpha pin makes this inert"
    // gate is compUniforms' job — it holds the resolved textures; this function
    // only has the lazily-null image mirrors. See the u_fg_soft comment there.
    fgSoftness: Math.max(0, data.fgSoftness ?? 0),
    // Per-layer colour. Completed here (so a partial block out of a hand-edited
    // file cannot reach the shader as NaN) but never MANUFACTURED: a comp with no
    // block keeps `undefined`, and colorIntoUnlocked's identity check then costs
    // nothing at all — no pass, no texture.
    bgColor: normalizeCompLayerColor(data.bgColor),
    fgColor: normalizeCompLayerColor(data.fgColor),
    filters: {
      bg: Fm(data.bgFilter),
      bgAlpha: Fm(data.bgAlphaFilter),
      fg: Fm(data.fgFilter),
      fgAlpha: Fm(data.fgAlphaFilter),
      matte: Fm(data.matteFilter),
    },
    resample: {
      bg: data.bgResample ?? defaultCompResample(),
      bgAlpha: data.bgAlphaResample ?? defaultCompResample(),
      fg: data.fgResample ?? defaultCompResample(),
      fgAlpha: data.fgAlphaResample ?? defaultCompResample(),
      matte: data.matteResample ?? defaultCompResample(),
    },
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
 * Ramp a canvas's ALPHA in from its own edges, over `softX` / `softY` SOURCE px.
 *
 * The same ramp the shader's u_fg_soft branch computes — `min(s, size - s)`
 * divided by the per-axis softness, floored at the two nearest edges — so the
 * fallback feathers the same footprint the GPU path does. The caller converts
 * the knob (output px) into source px with the per-axis scale, which is what
 * makes both axes come out the same width in the OUTPUT.
 *
 * `min(s, size - s)` is symmetric about the centre, so the source's bottom-up y
 * convention makes no difference here and no flip is needed.
 *
 * Whole-canvas getImageData rather than gradient fills: destination-in with four
 * gradients MULTIPLIES the ramps where they overlap, which would darken every
 * corner relative to the shader's min().
 */
function featherCanvasAlpha(canvas: HTMLCanvasElement, softX: number, softY: number): void {
  const cx = canvas.getContext("2d", { willReadFrequently: true });
  if (!cx) return;
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return;
  const sx = Math.max(softX, 1e-6), sy = Math.max(softY, 1e-6);
  // getImageData allocates w*h*4 bytes in one go — 96 MB on a 24MP plate — and
  // the caller's catch would drop the WHOLE FG layer if it threw. Losing the
  // feather is a far better failure than losing the plate, so it is caught here.
  let id: ImageData;
  try {
    id = cx.getImageData(0, 0, w, h);
  } catch {
    return;
  }
  const d = id.data;
  for (let y = 0; y < h; y++) {
    const ey = Math.min(y + 0.5, h - y - 0.5) / sy;
    for (let x = 0; x < w; x++) {
      const ex = Math.min(x + 0.5, w - x - 0.5) / sx;
      const f = Math.min(ex, ey);
      if (f >= 1) continue;
      const i = (y * w + x) * 4 + 3;
      d[i] = Math.round(d[i] * Math.max(0, f));
    }
  }
  cx.putImageData(id, 0, 0);
}

/**
 * Apply a layer's colour block on the 8-BIT fallback path, by running the very
 * same shader strings the GPU pre-pass runs.
 *
 * webglProcess is WebGL1 and is available even when this fallback is in play:
 * `floatSupported()` reports on WebGL2 + EXT_color_buffer_float specifically, not
 * on WebGL at all. So the fallback can reuse the shipped shaders rather than
 * grow a hand-written CPU grade that would drift from them — one copy of the
 * maths here too.
 *
 * What DOES differ is precision: each pass round-trips through an 8-bit PNG, so
 * negatives and super-whites are clamped between Grade and HSV and again before
 * the merge. That is already true of everything this fallback draws.
 *
 * Never throws: a colour block failing to apply must not be the reason a comp
 * loses its BG entirely.
 */
async function applyLayerColorUrl(url: string, col: CompLayerColor | undefined): Promise<string> {
  // The SAME predicates the GPU pre-pass gates on, not the enable flags alone.
  // Gating on `gradeEnabled` here would round-trip a full-size PNG for a block
  // that is switched on at identity values — and, worse, would apply that
  // block's clamps, which the GPU path skips because it runs no pass at all.
  if (!col || isCompColorIdentity(col)) return url;
  const clamps = { u_clampLow: col.clampLow ? 1 : 0, u_clampHigh: col.clampHigh ? 1 : 0 };
  let out = url;
  try {
    if (col.gradeEnabled && !isIdentityGrade(col.grade)) {
      const g = col.grade;
      out = await processImageWithShader(out, GRADE_SHADER, {
        u_blackpoint: [g.blackpoint.r, g.blackpoint.g, g.blackpoint.b],
        u_whitepoint: [g.whitepoint.r, g.whitepoint.g, g.whitepoint.b],
        u_lift: [g.lift.r, g.lift.g, g.lift.b],
        u_gain: [g.gain.r, g.gain.g, g.gain.b],
        u_multiply: [g.multiply.r, g.multiply.g, g.multiply.b],
        u_offset: [g.offset.r, g.offset.g, g.offset.b],
        u_gamma: [g.gamma.r, g.gamma.g, g.gamma.b],
        ...clamps,
      });
    }
    if (col.hsvEnabled && !isIdentityHsv(col)) {
      out = await processImageWithShader(out, HSV_SHADER, {
        u_hueShift: col.hueShift, u_saturation: col.saturation, u_value: col.value, ...clamps,
      });
    }
  } catch {
    return url;
  }
  return out;
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
  // Colour first, on the plate's own pixels, exactly as the GPU path orders it.
  const bg = await loadImg(await applyLayerColorUrl(urls.bg!, normalizeCompLayerColor(data.bgColor)));
  ctx.globalAlpha = data.bgOpacity ?? 1;
  ctx.drawImage(bg, 0, 0, W, H);
  ctx.globalAlpha = 1;
  if (urls.bgAlpha) applyAlphaMask(ctx, await lumToAlphaCanvas(urls.bgAlpha, W, H));

  // FG composited at its own size (with FG_Alpha applied), then drawn transformed.
  if (urls.fg) {
    try {
      const fg = await loadImg(await applyLayerColorUrl(urls.fg, normalizeCompLayerColor(data.fgColor)));
      const iw = fg.naturalWidth, ih = fg.naturalHeight;
      const fgCanvas = document.createElement("canvas");
      fgCanvas.width = iw; fgCanvas.height = ih;
      const fctx = fgCanvas.getContext("2d");
      if (fctx) {
        fctx.drawImage(fg, 0, 0);
        if (urls.fgAlpha) applyAlphaMask(fctx, await lumToAlphaCanvas(urls.fgAlpha, iw, ih));
        // Same aligned placement the GPU path uses — this fallback has to agree
        // with the render, or the patch lands somewhere else the moment float
        // support drops out.
        const spec = resolveFgAlign(data).spec;
        const alignBase = spec ? deriveAlignBase({ ...spec, fgW: iw, fgH: ih, outW: W, outH: H }) : null;
        const p = alignBase
          ? computeAlignedPieces(data.fgTransform, alignBase, iw, ih)
          : computePieces(data.fgTransform, "none", iw, ih, iw, ih);
        // FG edge softness. Gated exactly as the GPU path is: no footprint edge
        // without black-outside, and an FG_Alpha pin replaces the coverage this
        // would feather. `urls.fgAlpha` is this path's honest signal — it is the
        // URL the render is actually using, not a lazily-null mirror.
        const soft = Math.max(0, data.fgSoftness ?? 0);
        if (soft > 0 && (data.fgBlackOutside ?? true) && !urls.fgAlpha) {
          // Output px → source px, per axis, so a stretched FG still feathers
          // the same width on all four edges of the OUTPUT.
          featherCanvasAlpha(fgCanvas, soft / Math.abs(p.sX || 1), soft / Math.abs(p.sY || 1));
        }
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
