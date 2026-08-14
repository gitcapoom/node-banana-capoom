"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import {
  renderShaderToCanvas,
  processImageWithShader,
  type UniformValue,
} from "@/utils/webglProcess";
import {
  floatSupported,
  hasFloat,
  releaseColorNode,
  renderColorNodeToCanvas,
  renderColorNodeToFloat,
  commitColorNode,
  type ShaderInput,
} from "@/utils/colorChain";

import { cheapUrlKey, RenderSignatureCache } from "@/utils/renderSignature";
import { createImageThumbnailWithMeta } from "@/utils/createImageThumbnail";

/** Last committed render per color node — see RenderSignatureCache. */
const committedSignatures = new RenderSignatureCache();

/**
 * Live GPU preview into a visible <canvas>.
 *
 * Re-renders the shader straight into `canvasRef` whenever the source
 * image or any uniform changes. This path skips `toDataURL` and never
 * touches the Zustand store, so it stays at 60 fps while the user drags
 * sliders — the store write (which recreates the whole nodes array and
 * re-decodes a multi-MB <img>) is what made the old img-based preview
 * lag.
 *
 * `enabled` lets callers gate the overlay canvas so it only renders
 * while the full-screen editor is open.
 */
export function useGpuLivePreview(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  sourceImage: string | null,
  shaderSource: string,
  uniforms: Record<string, UniformValue>,
  enabled: boolean = true,
): void {
  const uniformsKey = JSON.stringify(uniforms);
  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas || !sourceImage) return;
    let cancelled = false;
    renderShaderToCanvas(sourceImage, shaderSource, uniforms, canvas).catch((err) => {
      if (!cancelled) console.error("useGpuLivePreview: render failed", err);
    });
    return () => { cancelled = true; };
    // uniforms is intentionally keyed via uniformsKey (stable string).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef, sourceImage, shaderSource, uniformsKey, enabled]);
}

/**
 * Debounced commit of the processed image to the node's `outputImage`,
 * so downstream nodes + workflow runs + saved state get the result.
 *
 * Runs the full `toDataURL` encode only AFTER the uniforms stop changing
 * for `delay` ms — i.e. once per slider settle, not per tick. Identity
 * params commit the source straight through (no encode).
 */
export function useGpuCommit(
  nodeId: string,
  sourceImage: string | null,
  shaderSource: string,
  uniforms: Record<string, UniformValue>,
  isIdentity: boolean,
  delay: number = 220,
): void {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const uniformsKey = JSON.stringify(uniforms);
  // Keep latest uniforms in a ref so the timer callback reads fresh
  // values without re-arming the effect on every keystroke.
  const uniformsRef = useRef(uniforms);
  uniformsRef.current = uniforms;

  useEffect(() => {
    if (!sourceImage) {
      updateNodeData(nodeId, { outputImage: null });
      return;
    }
    if (isIdentity) {
      updateNodeData(nodeId, { outputImage: sourceImage, outputImageRef: undefined });
      return;
    }
    const handle = setTimeout(() => {
      processImageWithShader(sourceImage, shaderSource, uniformsRef.current)
        .then((output) => updateNodeData(nodeId, { outputImage: output, outputImageRef: undefined }))
        .catch((err) => {
          console.error("useGpuCommit: shader failed", err);
          updateNodeData(nodeId, { outputImage: sourceImage, outputImageRef: undefined });
        });
    }, delay);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, sourceImage, shaderSource, uniformsKey, isIdentity, delay]);
}

// ─── Chainable color node (float pipeline) ────────────────────────

export interface UseColorNodeArgs {
  id: string;
  /** 8-bit display URL of the upstream output (fallback input + the
   *  change-signal that re-fires effects when upstream recomputes). */
  sourceImage: string | null;
  /** Upstream node id IF it is another color node (so we can read its
   *  float texture as input); null otherwise. */
  upstreamColorNodeId: string | null;
  shaderSource: string;
  /** Node-specific uniforms (clamp uniforms are added automatically). */
  uniforms: Record<string, UniformValue>;
  clampBlacks: boolean;
  clampWhites: boolean;
  isIdentity: boolean;
  nodeCanvasRef: RefObject<HTMLCanvasElement | null>;
  overlayCanvasRef: RefObject<HTMLCanvasElement | null>;
  overlayOpen: boolean;
  commitDelay?: number;
}

/**
 * Drives a chainable color node end-to-end:
 *  - LIVE PREVIEW into the in-node canvas (+ overlay when open), reading
 *    the upstream node's float texture when available so the preview
 *    reflects un-clamped chain input.
 *  - DEBOUNCED COMMIT that renders this node's float texture (for the
 *    next color node) and writes an 8-bit display URL to `outputImage`
 *    (for the thumbnail + any non-color downstream consumer).
 *  - Falls back to the clamped 8-bit webglProcess path when GPU float
 *    support is unavailable, so behaviour degrades to today's.
 *  - Releases the node's float texture on unmount.
 */
export function useColorNode(args: UseColorNodeArgs): void {
  const {
    id, sourceImage, upstreamColorNodeId, shaderSource, uniforms,
    clampBlacks, clampWhites, isIdentity,
    nodeCanvasRef, overlayCanvasRef, overlayOpen, commitDelay = 220,
  } = args;
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);

  // Fold the clamp toggles into the uniform set the shaders expect.
  const effUniforms: Record<string, UniformValue> = useMemo(
    () => ({ ...uniforms, u_clampLow: clampBlacks ? 1 : 0, u_clampHigh: clampWhites ? 1 : 0 }),
    [uniforms, clampBlacks, clampWhites],
  );
  const uniformsKey = JSON.stringify(effUniforms);

  const effUniformsRef = useRef(effUniforms);
  effUniformsRef.current = effUniforms;

  // Resolve the shader input: upstream float texture when present, else
  // the 8-bit display URL.
  const resolveInput = (): ShaderInput | null => {
    if (!sourceImage) return null;
    if (upstreamColorNodeId && hasFloat(upstreamColorNodeId)) {
      return { floatNodeId: upstreamColorNodeId };
    }
    return { url: sourceImage };
  };

  // ── Live preview — EDITOR ONLY ──
  //
  // The node body deliberately shows the committed thumbnail instead of a live
  // canvas. A per-node WebGL canvas has to be re-rendered every time the node
  // mounts, and React Flow's viewport culling remounts nodes constantly while
  // you navigate — so a canvas-bodied node re-runs a full-res shader pass just
  // for having scrolled past, on top of any real edit. Only the full-screen
  // editor, where the pixels are actually being judged, gets the live canvas.
  useEffect(() => {
    if (!overlayOpen) return;
    const input = resolveInput();
    if (!input) return;
    let cancelled = false;
    const drawTo = async (canvas: HTMLCanvasElement | null) => {
      if (!canvas || cancelled) return;
      const ok = floatSupported()
        ? await renderColorNodeToCanvas(input, shaderSource, effUniforms, canvas)
        : false;
      if (!ok && !cancelled && sourceImage) {
        // 8-bit fallback (also handles the "upstream float not ready" case).
        await renderShaderToCanvas(sourceImage, shaderSource, effUniforms, canvas)
          .catch((e) => console.error("useColorNode preview fallback:", e));
      }
    };
    drawTo(overlayCanvasRef.current);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sourceImage, upstreamColorNodeId, shaderSource, uniformsKey, overlayOpen]);

  // ── Debounced commit (float texture + display URL) ──
  useEffect(() => {
    if (!sourceImage) {
      // Only write when there's something to clear — an unconditional write
      // re-renders the whole node tree every time an unconnected node mounts.
      const cur = useWorkflowStore.getState().nodes.find((n) => n.id === id);
      if ((cur?.data as { outputImage?: string | null } | undefined)?.outputImage != null) {
        updateNodeData(id, { outputImage: null });
      }
      committedSignatures.forget(id);
      return;
    }

    const signature = `${cheapUrlKey(sourceImage)}|${upstreamColorNodeId ?? "-"}|${uniformsKey}|${isIdentity ? 1 : 0}|${shaderSource.length}`;

    // Already committed exactly this render (typically: the node just scrolled
    // back into view). Re-publish the float texture so downstream color nodes
    // keep chaining in float, but skip the PNG encode and the store write —
    // the stored `outputImage` is already this exact result.
    if (committedSignatures.matches(id, signature)) {
      const stored = useWorkflowStore.getState().nodes.find((n) => n.id === id);
      const hasOutput = !!(stored?.data as { outputImage?: string | null } | undefined)?.outputImage;
      if (hasOutput) {
        if (!isIdentity && floatSupported() && !hasFloat(id)) {
          const input = resolveInput();
          if (input) {
            void renderColorNodeToFloat(input, shaderSource, effUniformsRef.current, id)
              .catch((e) => console.error("useColorNode float refresh:", e));
          }
        }
        return;
      }
    }

    const handle = setTimeout(async () => {
      const input = resolveInput();
      if (!input || !sourceImage) return;
      const displayUrl = await commitColorNode(
        input, shaderSource, effUniformsRef.current, id, isIdentity, sourceImage,
      );
      committedSignatures.set(id, signature);
      // The node body shows this thumb, not the full-res result: a constant
      // small image keeps the canvas cheap however large the source is.
      const meta = await createImageThumbnailWithMeta(displayUrl).catch(() => null);
      updateNodeData(id, {
        outputImage: displayUrl,
        outputImageRef: undefined,
        ...(meta
          ? { outputImageThumb: meta.thumb, outputImageDims: { width: meta.width, height: meta.height } }
          : {}),
      });
    }, commitDelay);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sourceImage, upstreamColorNodeId, shaderSource, uniformsKey, isIdentity, commitDelay]);

  // ── Release the float texture on unmount ──
  // The commit signature deliberately OUTLIVES the unmount: it is what lets a
  // node scroll back into view without re-encoding an identical PNG.
  useEffect(() => {
    return () => releaseColorNode(id);
  }, [id]);
}
