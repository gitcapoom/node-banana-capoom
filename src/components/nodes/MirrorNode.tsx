"use client";

import { useCallback, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";
import { mirrorImage } from "@/utils/mirrorImage";
import type { MirrorNodeData } from "@/types";

type MirrorNodeType = Node<MirrorNodeData, "mirror">;

export function MirrorNode({ id, data, selected }: NodeProps<MirrorNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  // Subscribe to the live upstream image via a store selector — re-renders
  // when the upstream's outputImage changes (which doesn't mutate `edges`).
  const incomingImage = useWorkflowStore((state) => {
    const ins = getConnectedInputsPure(id, state.nodes, state.edges, undefined, state.dimmedNodeIds);
    return ins.images[0] || null;
  });

  // Tracks the last (src, flips) we kicked off a mirror op for. Also acts
  // as the "is this settled promise still relevant" check so writing back
  // outputImage doesn't cancel ourselves through dep changes.
  const lastFingerprintRef = useRef<string>("");

  // 1) Mirror upstream image into sourceImage.
  useEffect(() => {
    if (incomingImage !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: incomingImage });
    }
  }, [id, incomingImage, nodeData.sourceImage, updateNodeData]);

  // 2) Auto-apply whenever source or flip toggles change.
  // Deliberately does NOT depend on nodeData.outputImage — writing back
  // would otherwise tear down the in-flight mirror op via dep change.
  useEffect(() => {
    const src = nodeData.sourceImage;
    const h = !!nodeData.flipHorizontal;
    const v = !!nodeData.flipVertical;

    if (!src) {
      if (nodeData.outputImage !== null) updateNodeData(id, { outputImage: null });
      lastFingerprintRef.current = "";
      return;
    }

    if (!h && !v) {
      if (nodeData.outputImage !== src) updateNodeData(id, { outputImage: src });
      lastFingerprintRef.current = `passthrough:${src.length}`;
      return;
    }

    const fingerprint = `${src.length}|${h ? "H" : ""}${v ? "V" : ""}`;
    if (lastFingerprintRef.current === fingerprint) return;
    lastFingerprintRef.current = fingerprint;

    mirrorImage(src, h, v)
      .then((flipped) => {
        if (lastFingerprintRef.current !== fingerprint) return;
        updateNodeData(id, { outputImage: flipped, outputImageRef: undefined });
      })
      .catch((err) => {
        console.error("MirrorNode: mirror failed", err);
        if (lastFingerprintRef.current !== fingerprint) return;
        updateNodeData(id, { outputImage: src });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nodeData.sourceImage, nodeData.flipHorizontal, nodeData.flipVertical, updateNodeData]);

  const toggleH = useCallback(() => {
    updateNodeData(id, { flipHorizontal: !nodeData.flipHorizontal });
  }, [id, nodeData.flipHorizontal, updateNodeData]);

  const toggleV = useCallback(() => {
    updateNodeData(id, { flipVertical: !nodeData.flipVertical });
  }, [id, nodeData.flipVertical, updateNodeData]);

  const displayImage = nodeData.outputImage || nodeData.sourceImage;
  const activeLabel =
    nodeData.flipHorizontal && nodeData.flipVertical
      ? "Horizontal + Vertical"
      : nodeData.flipHorizontal
      ? "Horizontal"
      : nodeData.flipVertical
      ? "Vertical"
      : "None";

  return (
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip flex flex-col"
      aspectFitMedia={nodeData.outputImage}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        data-handletype="image"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        data-handletype="image"
      />

      {/* Toggle buttons */}
      <div className="flex gap-1 mb-1 px-1 nodrag">
        <button
          onClick={toggleH}
          className={`flex-1 text-[10px] font-medium py-1 rounded transition-colors flex items-center justify-center gap-1 ${
            nodeData.flipHorizontal
              ? "bg-blue-600 text-white"
              : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
          }`}
          title="Flip horizontally (mirror left ⇆ right)"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7l-5 5 5 5" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7l5 5-5 5" />
          </svg>
          Horizontal
        </button>
        <button
          onClick={toggleV}
          className={`flex-1 text-[10px] font-medium py-1 rounded transition-colors flex items-center justify-center gap-1 ${
            nodeData.flipVertical
              ? "bg-blue-600 text-white"
              : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
          }`}
          title="Flip vertically (mirror top ⇅ bottom)"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h18" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 8l5-5 5 5" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 16l5 5 5-5" />
          </svg>
          Vertical
        </button>
      </div>

      {displayImage ? (
        <div className="relative w-full flex-1 min-h-0">
          <img
            src={displayImage}
            alt="Mirrored"
            className="w-full h-full object-contain"
          />
          <div className="absolute bottom-1 left-1 right-1 text-center">
            <span className="text-[9px] text-white/60 bg-black/40 px-1.5 py-0.5 rounded">
              {activeLabel}
            </span>
          </div>
        </div>
      ) : (
        <div className="w-full flex-1 min-h-0 bg-neutral-900/40 flex flex-col items-center justify-center">
          <svg className="w-6 h-6 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18M8 7l-5 5 5 5m8-10l5 5-5 5" />
          </svg>
          <span className="text-[10px] text-neutral-500 mt-1">
            Connect an image
          </span>
        </div>
      )}
    </BaseNode>
  );
}
