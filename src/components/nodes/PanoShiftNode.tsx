"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { shiftImageX } from "@/utils/panoShift";
import type { PanoShiftNodeData } from "@/types";

type PanoShiftNodeType = Node<PanoShiftNodeData, "panoShift">;

const SLIDER_RANGE = 2048;

export function PanoShiftNode({ id, data, selected }: NodeProps<PanoShiftNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);

  const incomingImage = useMemo<string | null>(() => {
    for (const edge of edges) {
      if (edge.target !== id) continue;
      if (edge.targetHandle !== "image" && edge.targetHandle != null) continue;
      const src = nodes.find((n) => n.id === edge.source);
      if (!src) continue;
      const out = getSourceOutput(
        src,
        edge.sourceHandle,
        edge.data as Record<string, unknown> | undefined
      );
      if (out.type === "image" && out.value) return out.value;
    }
    return null;
  }, [edges, nodes, id]);

  useEffect(() => {
    if (incomingImage !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: incomingImage });
    }
  }, [id, incomingImage, nodeData.sourceImage, updateNodeData]);

  const shiftX = nodeData.shiftX ?? 0;

  const setShiftX = useCallback(
    (v: number) => {
      if (Number.isFinite(v) && v !== nodeData.shiftX) {
        updateNodeData(id, { shiftX: Math.round(v) });
      }
    },
    [id, nodeData.shiftX, updateNodeData]
  );

  const reset = useCallback(() => {
    updateNodeData(id, { shiftX: 0 });
  }, [id, updateNodeData]);

  // Re-shift on source/parameter change. Fingerprint-guarded so a
  // stale promise from a superseded shift doesn't overwrite a newer one.
  const lastFingerprintRef = useRef<string>("");
  const [busy, setBusy] = useState(false);
  const fingerprint = useMemo(() => {
    const src = nodeData.sourceImage;
    if (!src) return "";
    return `${src.length}|${shiftX}`;
  }, [nodeData.sourceImage, shiftX]);

  useEffect(() => {
    const src = nodeData.sourceImage;
    if (!src) {
      if (nodeData.outputImage) updateNodeData(id, { outputImage: null });
      lastFingerprintRef.current = "";
      setBusy(false);
      return;
    }

    if (shiftX === 0) {
      if (nodeData.outputImage !== src) updateNodeData(id, { outputImage: src });
      lastFingerprintRef.current = fingerprint;
      setBusy(false);
      return;
    }

    if (lastFingerprintRef.current === fingerprint) return;
    lastFingerprintRef.current = fingerprint;

    setBusy(true);
    shiftImageX(src, shiftX)
      .then((output) => {
        if (lastFingerprintRef.current !== fingerprint) return;
        updateNodeData(id, { outputImage: output, outputImageRef: undefined });
        setBusy(false);
      })
      .catch((err) => {
        if (lastFingerprintRef.current !== fingerprint) return;
        console.error("PanoShiftNode: shift failed", err);
        updateNodeData(id, { outputImage: src });
        setBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fingerprint, updateNodeData]);

  const displayImage =
    nodeData.outputImage || nodeData.outputImageThumb || nodeData.sourceImage || nodeData.sourceImageThumb;
  const isIdentity = shiftX === 0;

  return (
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip flex flex-col"
      aspectFitMedia={nodeData.outputImage || nodeData.outputImageThumb || nodeData.sourceImageThumb}
    >
      <Handle type="target" position={Position.Left} id="image" data-handletype="image" />
      <Handle type="source" position={Position.Right} id="image" data-handletype="image" />

      {/* Shift slider row */}
      <div className="flex items-center gap-1 mb-1 px-1 nodrag">
        <label
          className="text-[10px] text-neutral-300 w-[44px] shrink-0 cursor-pointer"
          title="Shift X — double-click to reset"
          onDoubleClick={reset}
        >
          Shift X
        </label>
        <input
          type="range"
          min={-SLIDER_RANGE}
          max={SLIDER_RANGE}
          step={1}
          value={Math.max(-SLIDER_RANGE, Math.min(SLIDER_RANGE, shiftX))}
          onChange={(e) => setShiftX(parseFloat(e.target.value))}
          className="flex-1 h-1 accent-orange-500 cursor-pointer min-w-0"
        />
        <input
          type="number"
          step={1}
          value={shiftX}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) setShiftX(v);
          }}
          className="w-[60px] shrink-0 text-[10px] py-0.5 px-1 rounded bg-[#1a1a1a] focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white tabular-nums"
        />
        <button
          onClick={reset}
          disabled={isIdentity}
          className={`w-4 h-4 shrink-0 rounded text-[9px] flex items-center justify-center ${
            isIdentity
              ? "bg-neutral-800 text-neutral-700"
              : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
          }`}
          title="Reset to 0"
        >
          ↺
        </button>
      </div>

      {/* Hint */}
      <div className="text-[9px] text-neutral-500 px-1 mb-1 leading-tight">
        +pixels → shift right (wraps left). −pixels → opposite.
      </div>

      {/* Preview */}
      {displayImage ? (
        <div className="relative w-full flex-1 min-h-0">
          <img
            src={displayImage}
            alt="Shifted"
            className="w-full h-full object-contain"
          />
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
              <span className="text-[10px] text-white/80 bg-black/60 px-2 py-0.5 rounded">
                shifting…
              </span>
            </div>
          )}
          {isIdentity && (
            <div className="absolute bottom-1 right-1 pointer-events-none">
              <span className="text-[9px] text-white/40 italic">passthrough</span>
            </div>
          )}
        </div>
      ) : (
        <div className="w-full flex-1 min-h-0 bg-neutral-900/40 flex flex-col items-center justify-center">
          <svg className="w-6 h-6 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h18m0 0l-6-6m6 6l-6 6" />
          </svg>
          <span className="text-[10px] text-neutral-500 mt-1">
            Connect an image
          </span>
        </div>
      )}
    </BaseNode>
  );
}
