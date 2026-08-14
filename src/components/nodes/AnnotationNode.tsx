"use client";

import { useCallback, useEffect } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useAnnotationStore } from "@/store/annotationStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useFullResField } from "@/hooks/useFullResField";
import { AnnotationNodeData } from "@/types";
import { previewSrc } from "@/utils/nodePreview";

type AnnotationNodeType = Node<AnnotationNodeData, "annotation">;

export function AnnotationNode({ id, data, selected }: NodeProps<AnnotationNodeType>) {
  const nodeData = data;
  const openModal = useAnnotationStore((state) => state.openModal);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const getConnectedInputs = useWorkflowStore((state) => state.getConnectedInputs);
  const edges = useWorkflowStore((state) => state.edges);
  const { ensure } = useFullResField();

  // Reactively update sourceImage when an edge is connected
  useEffect(() => {
    const inputs = getConnectedInputs(id);
    if (inputs.images.length > 0 && inputs.images[0] !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: inputs.images[0], outputImage: inputs.images[0] });
    }
  }, [edges, id, getConnectedInputs, nodeData.sourceImage, updateNodeData]);

  const handleEdit = useCallback(async () => {
    // Load full-res on demand — source/output are lazily null after reopening.
    let imageToEdit = nodeData.sourceImage || nodeData.outputImage;
    if (!imageToEdit) {
      imageToEdit =
        (await ensure({ id, field: "sourceImage", ref: nodeData.sourceImageRef, current: nodeData.sourceImage, folder: "inputs" })) ||
        (await ensure({ id, field: "outputImage", ref: nodeData.outputImageRef, current: nodeData.outputImage, folder: "inputs" }));
    }
    if (!imageToEdit) {
      alert("No image available. Connect an image input.");
      return;
    }
    openModal(id, imageToEdit, nodeData.annotations);
  }, [id, ensure, nodeData.sourceImage, nodeData.sourceImageRef, nodeData.outputImage, nodeData.outputImageRef, nodeData.annotations, openModal]);

  const handleRemove = useCallback(() => {
    updateNodeData(id, {
      sourceImage: null,
      sourceImageRef: undefined,
      outputImage: null,
      outputImageRef: undefined,
      annotations: [],
    });
  }, [id, updateNodeData]);

  const displayImage =
    previewSrc(nodeData.outputImage, nodeData.outputImageThumb, nodeData.outputImageRef) ||
    previewSrc(nodeData.sourceImage, nodeData.sourceImageThumb, nodeData.sourceImageRef);

  return (
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip"
      aspectFitMedia={nodeData.outputImage || nodeData.outputImageThumb || nodeData.sourceImageThumb}
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
        <div className="relative group w-full h-full">
          <img
            src={displayImage}
            alt="Annotated"
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
          {/* Edit button — only way to open the annotation editor */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center pointer-events-none">
            <button
              onClick={handleEdit}
              className="nodrag nopan text-xs font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 px-3 py-1.5 rounded pointer-events-auto cursor-pointer hover:bg-black/80"
            >
              {nodeData.annotations.length > 0 ? `Edit (${nodeData.annotations.length})` : "Add annotations"}
            </button>
          </div>
        </div>
      ) : (
        <div className="w-full h-full bg-neutral-900/40 flex flex-col items-center justify-center">
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
