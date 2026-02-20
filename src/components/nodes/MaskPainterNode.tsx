"use client";

import { useCallback } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useMaskPainterStore } from "@/store/maskPainterStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { MaskPainterNodeData } from "@/types";

type MaskPainterNodeType = Node<MaskPainterNodeData, "maskPainter">;

export function MaskPainterNode({ id, data, selected }: NodeProps<MaskPainterNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const openModal = useMaskPainterStore((state) => state.openModal);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  const handleEdit = useCallback(() => {
    const imageToEdit = nodeData.sourceImage;
    if (!imageToEdit) {
      alert("No image available. Connect an image source to the input handle.");
      return;
    }
    openModal(id, imageToEdit, nodeData.strokes);
  }, [id, nodeData, openModal]);

  const handleRemove = useCallback(() => {
    updateNodeData(id, {
      sourceImage: null,
      strokes: [],
      outputMask: null,
    });
  }, [id, updateNodeData]);

  // Show mask output if available, otherwise show source image
  const displayImage = nodeData.outputMask || nodeData.sourceImage;

  return (
    <BaseNode
      id={id}
      title="Mask Painter"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      selected={selected}
      commentNavigation={commentNavigation ?? undefined}
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
          className="relative group cursor-pointer flex-1 flex flex-col min-h-0"
          onClick={handleEdit}
        >
          <img
            src={displayImage}
            alt={nodeData.outputMask ? "Mask" : "Source"}
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
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded flex items-center justify-center pointer-events-none">
            <span className="text-[10px] font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 px-2 py-1 rounded">
              {nodeData.strokes.length > 0 ? `Edit mask (${nodeData.strokes.length} strokes)` : "Paint mask"}
            </span>
          </div>
        </div>
      ) : (
        <div className="w-full flex-1 min-h-[80px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center">
          <svg className="w-5 h-5 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42" />
          </svg>
          <span className="text-[10px] text-neutral-400 mt-1">
            Connect image source
          </span>
        </div>
      )}

      {/* Controls: Brush Size, Blur, Invert */}
      <div className="flex flex-col gap-1.5 mt-1.5">
        {/* Brush Size */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-neutral-500 w-10 shrink-0">Brush</span>
          <input
            type="range"
            min={10}
            max={100}
            value={nodeData.brushSize}
            onChange={(e) => updateNodeData(id, { brushSize: Number(e.target.value) })}
            className="flex-1 accent-white h-1"
          />
          <span className="text-[10px] text-neutral-400 w-7 text-right">{nodeData.brushSize}</span>
        </div>

        {/* Blur Radius */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-neutral-500 w-10 shrink-0">Blur</span>
          <input
            type="range"
            min={0}
            max={20}
            value={nodeData.blurRadius}
            onChange={(e) => updateNodeData(id, { blurRadius: Number(e.target.value) })}
            className="flex-1 accent-white h-1"
          />
          <span className="text-[10px] text-neutral-400 w-7 text-right">{nodeData.blurRadius}px</span>
        </div>

        {/* Invert Mask */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={nodeData.invertMask}
            onChange={(e) => updateNodeData(id, { invertMask: e.target.checked })}
            className="w-3 h-3 rounded border-neutral-600 accent-white"
          />
          <span className="text-[10px] text-neutral-400">Invert mask</span>
        </label>
      </div>
    </BaseNode>
  );
}
