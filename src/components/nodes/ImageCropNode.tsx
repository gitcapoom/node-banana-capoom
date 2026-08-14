"use client";

import { useCallback, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useImageCropStore } from "@/store/imageCropStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";
import { cropImageToDataUrl } from "@/utils/cropImage";
import type { ImageCropNodeData } from "@/types";
import { previewSrc } from "@/utils/nodePreview";
import { cheapUrlKey } from "@/utils/renderSignature";

type ImageCropNodeType = Node<ImageCropNodeData, "imageCrop">;

export function ImageCropNode({ id, data, selected }: NodeProps<ImageCropNodeType>) {
  const nodeData = data;
  const openModal = useImageCropStore((state) => state.openModal);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const loadNodeFullResInputs = useWorkflowStore((state) => state.loadNodeFullResInputs);

  // Subscribe to live upstream output via a store selector so this node
  // re-renders when the upstream's outputImage changes — `edges` alone
  // doesn't catch that case.
  const incomingImage = useWorkflowStore((state) => {
    const ins = getConnectedInputsPure(id, state.nodes, state.edges, undefined, state.dimmedNodeIds);
    return ins.images[0] || null;
  });

  // Track the last applied (sourceImage + region) so we don't re-crop redundantly.
  // Also doubles as a "is this settled promise still relevant" check.
  const lastFingerprintRef = useRef<string>("");

  // 1) Mirror upstream image into sourceImage.
  useEffect(() => {
    if (incomingImage !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: incomingImage });
    }
  }, [id, incomingImage, nodeData.sourceImage, updateNodeData]);

  // 2) Auto-apply crop whenever sourceImage or cropRegion changes.
  // Deliberately does NOT depend on nodeData.outputImage — writing it back
  // would otherwise tear down the in-flight crop via dep change.
  useEffect(() => {
    const src = nodeData.sourceImage;
    const region = nodeData.cropRegion;

    if (!src) {
      if (nodeData.outputImage !== null) updateNodeData(id, { outputImage: null });
      lastFingerprintRef.current = "";
      return;
    }

    // No region → passthrough
    if (!region) {
      if (nodeData.outputImage !== src) updateNodeData(id, { outputImage: src });
      lastFingerprintRef.current = `passthrough:${src.length}`;
      return;
    }

    const fingerprint = `${src.length}|${region.x}|${region.y}|${region.width}|${region.height}`;
    if (lastFingerprintRef.current === fingerprint) return;
    lastFingerprintRef.current = fingerprint;

    cropImageToDataUrl(src, region)
      .then((cropped) => {
        if (lastFingerprintRef.current !== fingerprint) return;
        // Clear the stale ref so the new crop is (re)saved + re-thumbed on save.
        updateNodeData(id, { outputImage: cropped, outputImageRef: undefined });
      })
      .catch((err) => {
        console.error("ImageCropNode: crop failed", err);
        if (lastFingerprintRef.current !== fingerprint) return;
        updateNodeData(id, { outputImage: src });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nodeData.sourceImage, nodeData.cropRegion, updateNodeData]);

  const handleEdit = useCallback(async () => {
    // The source mirrors upstream; on reopen it's lazily null. Load the
    // upstream full-res, then read the freshly-mirrored input. (We can't just
    // load this node's own stored sourceImage — the mirror effect would null it
    // back when the upstream is empty.)
    await loadNodeFullResInputs(id);
    const s = useWorkflowStore.getState();
    const ins = getConnectedInputsPure(id, s.nodes, s.edges, undefined, s.dimmedNodeIds);
    const src = ins.images[0] || nodeData.sourceImage || null;
    if (!src) {
      alert("No image available. Connect an image input.");
      return;
    }
    openModal(id, src, nodeData.cropRegion ?? null, nodeData.aspectLock ?? "free");
  }, [id, loadNodeFullResInputs, nodeData.sourceImage, nodeData.cropRegion, nodeData.aspectLock, openModal]);

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

  // The output thumb is trustworthy the moment its key matches the output it
  // was made from — the ref is cleared on every crop by design, so without this
  // the node painted the full-res crop (up to ~10MP) into a ~90px box from the
  // first edit until the next save.
  const outThumbCurrent =
    !!nodeData.outputImage && nodeData.outputImageThumbKey === cheapUrlKey(nodeData.outputImage);
  const displayImage =
    previewSrc(nodeData.outputImage, nodeData.outputImageThumb, nodeData.outputImageRef, outThumbCurrent) ||
    previewSrc(nodeData.sourceImage, nodeData.sourceImageThumb, nodeData.sourceImageRef);

  return (
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip"
      // Thumb first: this only needs an ASPECT RATIO (and feeds the resolution
      // badge, which reads the persisted *Dims anyway), so referencing the
      // full-res image here just kept it alive on the render path.
      aspectFitMedia={displayImage}
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
