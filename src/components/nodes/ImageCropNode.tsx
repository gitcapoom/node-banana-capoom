"use client";

import { useCallback, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useImageCropStore } from "@/store/imageCropStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { cropImageToDataUrl } from "@/utils/cropImage";
import type { ImageCropNodeData } from "@/types";

type ImageCropNodeType = Node<ImageCropNodeData, "imageCrop">;

export function ImageCropNode({ id, data, selected }: NodeProps<ImageCropNodeType>) {
  const nodeData = data;
  const openModal = useImageCropStore((state) => state.openModal);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const getConnectedInputs = useWorkflowStore((state) => state.getConnectedInputs);
  const edges = useWorkflowStore((state) => state.edges);

  // Track the last applied (sourceImage + region) so we don't re-crop redundantly
  const lastApplied = useRef<string>("");

  // 1) Reactively update sourceImage when an edge is connected
  useEffect(() => {
    const inputs = getConnectedInputs(id);
    const incoming = inputs.images[0] || null;
    if (incoming !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: incoming });
    }
  }, [edges, id, getConnectedInputs, nodeData.sourceImage, updateNodeData]);

  // 2) Auto-apply crop whenever sourceImage or cropRegion changes
  useEffect(() => {
    const src = nodeData.sourceImage;
    const region = nodeData.cropRegion;

    if (!src) {
      if (nodeData.outputImage !== null) updateNodeData(id, { outputImage: null });
      lastApplied.current = "";
      return;
    }

    // No region → passthrough
    if (!region) {
      if (nodeData.outputImage !== src) updateNodeData(id, { outputImage: src });
      lastApplied.current = `passthrough:${src.length}`;
      return;
    }

    const fingerprint = `${src.length}|${region.x}|${region.y}|${region.width}|${region.height}`;
    if (lastApplied.current === fingerprint) return;
    lastApplied.current = fingerprint;

    let cancelled = false;
    cropImageToDataUrl(src, region)
      .then((cropped) => {
        if (!cancelled) updateNodeData(id, { outputImage: cropped });
      })
      .catch((err) => {
        console.error("ImageCropNode: crop failed", err);
        if (!cancelled) updateNodeData(id, { outputImage: src });
      });

    return () => {
      cancelled = true;
    };
  }, [id, nodeData.sourceImage, nodeData.cropRegion, nodeData.outputImage, updateNodeData]);

  const handleEdit = useCallback(() => {
    if (!nodeData.sourceImage) {
      alert("No image available. Connect an image input.");
      return;
    }
    openModal(id, nodeData.sourceImage, nodeData.cropRegion ?? null, nodeData.aspectLock ?? "free");
  }, [id, nodeData.sourceImage, nodeData.cropRegion, nodeData.aspectLock, openModal]);

  const handleReset = useCallback(() => {
    updateNodeData(id, {
      cropRegion: null,
      outputImage: nodeData.sourceImage,
    });
  }, [id, nodeData.sourceImage, updateNodeData]);

  const handleRemove = useCallback(() => {
    updateNodeData(id, {
      sourceImage: null,
      sourceImageRef: undefined,
      outputImage: null,
      outputImageRef: undefined,
      cropRegion: null,
    });
  }, [id, updateNodeData]);

  const displayImage = nodeData.outputImage || nodeData.sourceImage;

  return (
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip"
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

      {displayImage ? (
        <div className="relative group w-full h-full" onDoubleClick={handleEdit}>
          <img
            src={displayImage}
            alt="Cropped"
            className="w-full h-full object-contain"
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRemove();
            }}
            className="absolute top-2 right-2 w-6 h-6 bg-black/60 hover:bg-black/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center pointer-events-none gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); handleEdit(); }}
              className="nodrag nopan text-xs font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 px-3 py-1.5 rounded pointer-events-auto cursor-pointer hover:bg-black/80"
            >
              {nodeData.cropRegion ? "Edit crop" : "Define crop"}
            </button>
            {nodeData.cropRegion && (
              <button
                onClick={(e) => { e.stopPropagation(); handleReset(); }}
                className="nodrag nopan text-xs font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 px-3 py-1.5 rounded pointer-events-auto cursor-pointer hover:bg-black/80"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="w-full h-full bg-neutral-900/40 flex flex-col items-center justify-center">
          <svg className="w-6 h-6 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 4.5v15m6-15v15m-10.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125Z" />
          </svg>
          <span className="text-[10px] text-neutral-500 mt-1">
            Connect an image
          </span>
        </div>
      )}
    </BaseNode>
  );
}
