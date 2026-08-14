"use client";

import { useCallback, useEffect } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useMaskPainterStore } from "@/store/maskPainterStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useFullResField } from "@/hooks/useFullResField";
import { MaskPainterNodeData } from "@/types";

type MaskPainterNodeType = Node<MaskPainterNodeData, "maskPainter">;

export function MaskPainterNode({ id, data, selected }: NodeProps<MaskPainterNodeType>) {
  const nodeData = data;
  const openModal = useMaskPainterStore((state) => state.openModal);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const getConnectedInputs = useWorkflowStore((state) => state.getConnectedInputs);
  const edges = useWorkflowStore((state) => state.edges);
  const { ensure } = useFullResField();

  // Reactively update sourceImage when an edge is connected
  useEffect(() => {
    const inputs = getConnectedInputs(id);
    if (inputs.images.length > 0 && inputs.images[0] !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: inputs.images[0] });
    }
  }, [edges, id, getConnectedInputs, nodeData.sourceImage, updateNodeData]);

  const handleEdit = useCallback(async () => {
    // Load full-res source on demand — it's lazily null after reopening.
    const imageToEdit = await ensure({ id, field: "sourceImage", ref: nodeData.sourceImageRef, current: nodeData.sourceImage, folder: "inputs" });
    if (!imageToEdit) {
      alert("No image available. Connect an image input.");
      return;
    }
    openModal(id, imageToEdit, nodeData.strokes);
  }, [id, ensure, nodeData.sourceImage, nodeData.sourceImageRef, nodeData.strokes, openModal]);

  const handleRemove = useCallback(() => {
    updateNodeData(id, {
      sourceImage: null,
      strokes: [],
      outputMask: null,
    });
  }, [id, updateNodeData]);

  // Only show the painted mask output — sourceImage is the reference for the modal, not the node preview.
  // Falls back to the inline thumb when full-res isn't loaded (lazy on open).
  const displayImage = nodeData.outputMask ?? nodeData.outputMaskThumb;

  return (
    <BaseNode
      id={id}
      selected={selected}
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
        <div
          className="relative group flex-1 flex flex-col min-h-0 cursor-pointer"
          onDoubleClick={handleEdit}
          title="Double-click to open the mask editor"
        >
          <img
            src={displayImage}
            alt="Mask"
            className="w-full flex-1 min-h-0 object-contain rounded"
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRemove();
            }}
            className="absolute top-1 right-1 w-5 h-5 bg-black/60 text-white rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          {/* Edit button — only way to open the mask painter editor */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded flex items-center justify-center pointer-events-none">
            <button
              onClick={handleEdit}
              className="nodrag nopan text-[10px] font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 px-2 py-1 rounded pointer-events-auto cursor-pointer hover:bg-black/70"
            >
              {nodeData.strokes.length > 0 ? `Edit mask (${nodeData.strokes.length} elements)` : "Paint mask"}
            </button>
          </div>
        </div>
      ) : nodeData.sourceImage ? (
        <div className="relative group flex-1 flex flex-col min-h-0">
          <div className="w-full flex-1 min-h-[112px] bg-black rounded flex flex-col items-center justify-center">
            <svg className="w-5 h-5 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
            </svg>
            <button
              onClick={handleEdit}
              className="nodrag nopan text-[10px] text-neutral-400 mt-1 hover:text-white transition-colors cursor-pointer"
            >
              Click to paint mask
            </button>
          </div>
        </div>
      ) : (
        <div className="w-full flex-1 min-h-[112px] rounded flex flex-col items-center justify-center bg-neutral-900/40">
          <svg className="w-6 h-6 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
          </svg>
          <span className="text-[10px] text-neutral-500 mt-1">
            Connect an image
          </span>
        </div>
      )}

    </BaseNode>
  );
}
