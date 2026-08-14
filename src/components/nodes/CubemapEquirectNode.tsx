"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";
import { applyCubemapEquirect } from "@/utils/cubemapEquirect";
import type { CubemapEquirectMode, CubemapEquirectNodeData } from "@/types";
import { previewSrc } from "@/utils/nodePreview";

type CubemapEquirectNodeType = Node<CubemapEquirectNodeData, "cubemapEquirect">;

/** Output sizes the user can pick. Cube→Pano interprets these as equirect
 *  width; Pano→Cube interprets them as face size (so the cross is 4× wide). */
const SIZE_OPTIONS = [256, 512, 1024, 2048, 4096] as const;

export function CubemapEquirectNode({ id, data, selected }: NodeProps<CubemapEquirectNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  // Subscribe to the live upstream image through a store selector so this
  // node re-renders when the upstream's outputImage changes — `edges` alone
  // doesn't catch that case, since data changes don't mutate the edge list.
  const incomingImage = useWorkflowStore((state) => {
    const ins = getConnectedInputsPure(id, state.nodes, state.edges, undefined, state.dimmedNodeIds);
    return ins.images[0] || null;
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks the last (src, mode, size) we kicked off a convert for. Used to
  // skip redundant work AND to know when a settled promise is still relevant.
  const lastFingerprintRef = useRef<string>("");

  // 1) Mirror the upstream image into sourceImage.
  useEffect(() => {
    if (incomingImage !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: incomingImage });
    }
  }, [id, incomingImage, nodeData.sourceImage, updateNodeData]);

  // 2) Re-run the conversion whenever source / mode / outputSize change.
  // NOTE: deliberately NOT including nodeData.outputImage in deps — writing
  // the converted output back would cancel the very effect that produced it.
  useEffect(() => {
    const src = nodeData.sourceImage;
    const mode = nodeData.mode;
    const size = nodeData.outputSize;

    if (!src) {
      if (nodeData.outputImage) updateNodeData(id, { outputImage: null });
      lastFingerprintRef.current = "";
      setError(null);
      setBusy(false);
      return;
    }

    const fingerprint = `${src.length}|${mode}|${size}`;
    if (lastFingerprintRef.current === fingerprint) return;
    lastFingerprintRef.current = fingerprint;

    setBusy(true);
    setError(null);
    applyCubemapEquirect(src, mode, size)
      .then((output) => {
        // Only commit if no newer convert has been kicked off in the meantime.
        if (lastFingerprintRef.current !== fingerprint) return;
        updateNodeData(id, { outputImage: output, outputImageRef: undefined });
        setBusy(false);
      })
      .catch((err) => {
        if (lastFingerprintRef.current !== fingerprint) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error("CubemapEquirectNode: conversion failed", err);
        setError(msg);
        updateNodeData(id, { outputImage: src });
        setBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nodeData.sourceImage, nodeData.mode, nodeData.outputSize, updateNodeData]);

  const setMode = useCallback(
    (mode: CubemapEquirectMode) => {
      if (mode !== nodeData.mode) updateNodeData(id, { mode });
    },
    [id, nodeData.mode, updateNodeData]
  );

  const setSize = useCallback(
    (size: number) => {
      if (size !== nodeData.outputSize) updateNodeData(id, { outputSize: size });
    },
    [id, nodeData.outputSize, updateNodeData]
  );

  const displayImage =
    previewSrc(nodeData.outputImage, nodeData.outputImageThumb, nodeData.outputImageRef) ||
    previewSrc(nodeData.sourceImage, nodeData.sourceImageThumb, nodeData.sourceImageRef);
  const sizeLabel = nodeData.mode === "cubeToEquirect" ? "Equirect width" : "Face size";

  return (
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip flex flex-col"
      aspectFitMedia={nodeData.outputImage || nodeData.outputImageThumb || nodeData.sourceImageThumb}
    >
      <Handle type="target" position={Position.Left} id="image" data-handletype="image" />
      <Handle type="source" position={Position.Right} id="image" data-handletype="image" />

      {/* Mode toggle */}
      <div className="flex gap-1 mb-1 px-1 nodrag">
        <button
          onClick={() => setMode("cubeToEquirect")}
          className={`flex-1 text-[10px] font-medium py-1 rounded transition-colors ${
            nodeData.mode === "cubeToEquirect"
              ? "bg-blue-600 text-white"
              : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
          }`}
          title="Cubemap cross → Equirectangular"
        >
          Cube → Pano
        </button>
        <button
          onClick={() => setMode("equirectToCube")}
          className={`flex-1 text-[10px] font-medium py-1 rounded transition-colors ${
            nodeData.mode === "equirectToCube"
              ? "bg-blue-600 text-white"
              : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
          }`}
          title="Equirectangular → Cubemap cross"
        >
          Pano → Cube
        </button>
      </div>

      {/* Output size selector */}
      <div className="flex items-center gap-1 mb-1 px-1 nodrag">
        <label className="text-[10px] text-neutral-400 shrink-0" title={sizeLabel}>
          {sizeLabel}
        </label>
        <select
          value={nodeData.outputSize}
          onChange={(e) => setSize(Number(e.target.value))}
          className="nodrag nopan flex-1 min-w-0 text-[10px] py-0.5 px-1 rounded bg-[#1a1a1a] focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white"
        >
          {SIZE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {/* Preview area */}
      {displayImage ? (
        <div className="relative w-full flex-1 min-h-0">
          <img data-node-media="outputImage"
            src={displayImage}
            alt="Conversion result"
            className="w-full h-full object-contain"
          />
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <span className="text-[10px] text-white/80 bg-black/60 px-2 py-1 rounded">
                converting…
              </span>
            </div>
          )}
          {error && !busy && (
            <div className="absolute bottom-1 left-1 right-1 text-center">
              <span className="text-[9px] text-red-300 bg-red-900/70 px-1.5 py-0.5 rounded">
                {error}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="w-full flex-1 min-h-0 bg-neutral-900/40 flex flex-col items-center justify-center">
          <svg className="w-6 h-6 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5L12 3l9 4.5M3 7.5L12 12m-9-4.5v9L12 21m0-9l9-4.5m-9 4.5v9m9-13.5v9L12 21" />
          </svg>
          <span className="text-[10px] text-neutral-500 mt-1">
            Connect an image
          </span>
        </div>
      )}
    </BaseNode>
  );
}
