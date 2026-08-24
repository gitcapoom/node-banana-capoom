"use client";

import { useCallback, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useRotoStore } from "@/store/rotoStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useFullResField } from "@/hooks/useFullResField";
import { ensureFullResForNodes } from "@/store/execution/hydrateForRun";
import { useHydrateUnresolvedInputs, useIncomingEdgeKey } from "@/hooks/useUpstreamHydration";
import { rasterizeRoto } from "@/utils/rasterizeRoto";
import { RotoNodeData } from "@/types";
import { previewSrc } from "@/utils/nodePreview";

type RotoNodeType = Node<RotoNodeData, "roto">;

export function RotoNode({ id, data, selected }: NodeProps<RotoNodeType>) {
  const nodeData = data;
  const openModal = useRotoStore((state) => state.openModal);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const getConnectedInputs = useWorkflowStore((state) => state.getConnectedInputs);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);
  const saveDirectoryPath = useWorkflowStore((state) => state.saveDirectoryPath);
  const { ensure } = useFullResField();

  // Wired vs resolved — the same dead end MaskPainterNode had, for the same
  // reason. `sourceImage` is ref-backed and lazy (imageStorage's `roto` case),
  // so a roto with no shapes yet has neither a matte thumb nor a source on
  // open: it fell through to the bare "Connect an image" placeholder, which has
  // no way to open the editor, and nothing here ever asked for the pixels. The
  // request restores this node's OWN sourceImage from its ref as well as the
  // upstream's output (roto is a root in `ensureFullResForNodes`).
  const incomingEdgeKey = useIncomingEdgeKey(id);
  useHydrateUnresolvedInputs(id, incomingEdgeKey, !!nodeData.sourceImage);
  const connected = !!incomingEdgeKey;

  // Reactively mirror the upstream image into sourceImage.
  useEffect(() => {
    const inputs = getConnectedInputs(id);
    if (inputs.images.length > 0 && inputs.images[0] !== nodeData.sourceImage) {
      // Clear the stale full-res ref too: it still points at the PREVIOUS input's
      // file. Left set, the next externalize pass sees a valid existing ref,
      // discards this new base64, and reloads the old image (matches executeRoto).
      updateNodeData(id, { sourceImage: inputs.images[0], sourceImageRef: undefined });
    }
  }, [edges, id, getConnectedInputs, nodeData.sourceImage, updateNodeData]);

  // Safety net: if the matte is genuinely lost (no full-res AND no inline thumb,
  // e.g. a stale/lost ref on reload) but the shapes are intact, regenerate it —
  // the shapes are the source of truth. A present thumb means the matte is just
  // lazily unloaded (not lost), so we leave it alone and let the thumb preview.
  const regenRef = useRef(false);
  useEffect(() => {
    if (regenRef.current) return;
    if (nodeData.outputMask || nodeData.outputMaskThumb) return;
    const shapes = nodeData.shapes;
    const w = nodeData.imageWidth ?? 0;
    const h = nodeData.imageHeight ?? 0;
    if (!shapes || shapes.length === 0 || w <= 0 || h <= 0) return;
    regenRef.current = true;
    try {
      const mask = rasterizeRoto(shapes, w, h, { invert: nodeData.invert });
      updateNodeData(id, { outputMask: mask, outputMaskRef: undefined });
    } catch (e) {
      console.error("RotoNode: failed to regenerate matte from shapes", e);
    }
  }, [id, nodeData.outputMask, nodeData.outputMaskThumb, nodeData.shapes, nodeData.imageWidth, nodeData.imageHeight, nodeData.invert, updateNodeData]);

  const handleEdit = useCallback(async () => {
    // Resolve the LIVE upstream image at edit time. The cached sourceImage can
    // lag the current input: the reactive mirror above only fires on edge
    // changes, not when the upstream's own image content changes, so trusting
    // the cache is what surfaces the "old input" inside the editor. Hydrate the
    // node's inputs first so a lazily-externalized upstream resolves to full-res.
    await ensureFullResForNodes([id], nodes, edges, updateNodeData, saveDirectoryPath);
    const liveInput = getConnectedInputs(id).images[0] ?? null;
    let imageToEdit: string | null = liveInput;
    if (liveInput) {
      // Live upstream wins; sync node data and drop the stale ref so a later
      // externalize pass can't resurrect the previous input.
      if (liveInput !== nodeData.sourceImage) {
        updateNodeData(id, { sourceImage: liveInput, sourceImageRef: undefined });
      }
    } else {
      // No connected input (disconnected / manually cached): load on demand.
      imageToEdit = await ensure({ id, field: "sourceImage", ref: nodeData.sourceImageRef, current: nodeData.sourceImage, folder: "inputs" });
    }
    if (!imageToEdit) {
      alert("No image available. Connect an image input.");
      return;
    }
    openModal(id, imageToEdit, nodeData.shapes);
  }, [id, ensure, nodes, edges, getConnectedInputs, updateNodeData, saveDirectoryPath, nodeData.sourceImage, nodeData.sourceImageRef, nodeData.shapes, openModal]);

  const handleRemove = useCallback(() => {
    updateNodeData(id, { sourceImage: null, shapes: [], outputMask: null });
  }, [id, updateNodeData]);

  const displayImage = previewSrc(nodeData.outputMask, nodeData.outputMaskThumb, nodeData.outputMaskRef);
  const shapeCount = nodeData.shapes?.length ?? 0;

  return (
    <BaseNode id={id} selected={selected} aspectFitMedia={displayImage}>
      <Handle type="target" position={Position.Left} id="image" data-handletype="image" />
      <Handle type="source" position={Position.Right} id="image" data-handletype="image" />

      {displayImage ? (
        <div
          className="relative group flex-1 flex flex-col min-h-0 cursor-pointer"
          onDoubleClick={handleEdit}
          title="Double-click to open the roto editor"
        >
          <img src={displayImage} alt="Roto matte" className="w-full flex-1 min-h-0 object-contain rounded" />
          <button
            onClick={(e) => { e.stopPropagation(); handleRemove(); }}
            className="absolute top-1 right-1 w-5 h-5 bg-black/60 text-white rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded flex items-center justify-center pointer-events-none">
            <button
              onClick={handleEdit}
              className="nodrag nopan text-[10px] font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 px-2 py-1 rounded pointer-events-auto cursor-pointer hover:bg-black/70"
            >
              {shapeCount > 0 ? `Edit roto (${shapeCount} shape${shapeCount === 1 ? "" : "s"})` : "Draw roto"}
            </button>
          </div>
        </div>
      ) : nodeData.sourceImage ? (
        <div className="relative group flex-1 flex flex-col min-h-0">
          <div className="w-full flex-1 min-h-[112px] bg-black rounded flex flex-col items-center justify-center">
            <svg className="w-5 h-5 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 7.5l.415-.207a.75.75 0 011.085.67V10.5m0 0v5.043c0 .527.4.967.925 1.01.55.045 1.1.082 1.65.11M9.75 10.5h2.25m0 0V7.5m0 3v.75m0 8.25a3 3 0 003-3v-1.5a3 3 0 00-3-3m0 7.5h-2.25" />
            </svg>
            <button
              onClick={handleEdit}
              className="nodrag nopan text-[10px] text-neutral-400 mt-1 hover:text-white transition-colors cursor-pointer"
            >
              Click to draw roto
            </button>
          </div>
        </div>
      ) : (
        <div
          className="w-full flex-1 min-h-[112px] rounded flex flex-col items-center justify-center bg-neutral-900/40"
          onDoubleClick={connected ? handleEdit : undefined}
          title={connected ? "Double-click to open the roto editor" : "Connect an image"}
        >
          <svg className="w-6 h-6 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42" />
          </svg>
          {connected ? (
            // The editor is the only way to author shapes, so this branch must
            // never be a dead end just because the source is still on disk.
            <button
              onClick={handleEdit}
              className="nodrag nopan text-[10px] text-neutral-400 mt-1 hover:text-white transition-colors cursor-pointer"
            >
              Draw roto
            </button>
          ) : (
            <span className="text-[10px] text-neutral-500 mt-1">Connect an image</span>
          )}
        </div>
      )}
    </BaseNode>
  );
}
