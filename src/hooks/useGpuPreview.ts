"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import {
  renderShaderToCanvas,
  processImageWithShader,
  type UniformValue,
} from "@/utils/webglProcess";

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
