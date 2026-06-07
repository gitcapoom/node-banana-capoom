"use client";

import { useCallback, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";
import { reformatImage } from "@/utils/reformatImage";
import type { ReformatNodeData } from "@/types";

type ReformatNodeType = Node<ReformatNodeData, "reformat">;

const MODES: Array<{ v: ReformatNodeData["mode"]; label: string }> = [
  { v: "fill", label: "Fill" },
  { v: "fitH", label: "Fit Horizontal" },
  { v: "fitV", label: "Fit Vertical" },
];

export function ReformatNode({ id, data, selected }: NodeProps<ReformatNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  const incomingImage = useWorkflowStore((state) => {
    const ins = getConnectedInputsPure(id, state.nodes, state.edges, undefined, state.dimmedNodeIds);
    return ins.images[0] || null;
  });

  const fpRef = useRef<string>("");

  // Mirror the upstream image into sourceImage.
  useEffect(() => {
    if (incomingImage !== nodeData.sourceImage) updateNodeData(id, { sourceImage: incomingImage });
  }, [id, incomingImage, nodeData.sourceImage, updateNodeData]);

  // Reformat whenever source / resolution / mode change (debounced).
  useEffect(() => {
    const src = nodeData.sourceImage;
    const W = Math.max(1, Math.round(nodeData.width || 0));
    const H = Math.max(1, Math.round(nodeData.height || 0));
    const mode = nodeData.mode ?? "fill";
    if (!src) {
      if (nodeData.outputImage !== null) updateNodeData(id, { outputImage: null });
      fpRef.current = "";
      return;
    }
    const fp = `${src.length}|${W}x${H}|${mode}`;
    if (fpRef.current === fp) return;
    fpRef.current = fp;
    const t = setTimeout(() => {
      reformatImage(src, W, H, mode)
        .then((out) => { if (fpRef.current === fp) updateNodeData(id, { outputImage: out, outputImageRef: undefined }); })
        .catch((err) => { console.error("ReformatNode: reformat failed", err); if (fpRef.current === fp) updateNodeData(id, { outputImage: src }); });
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nodeData.sourceImage, nodeData.width, nodeData.height, nodeData.mode, updateNodeData]);

  const setNum = useCallback(
    (key: "width" | "height", v: number) => updateNodeData(id, { [key]: Math.max(1, Math.round(v || 0)) }),
    [id, updateNodeData],
  );

  const displayImage =
    nodeData.outputImage || nodeData.outputImageThumb || nodeData.sourceImage || nodeData.sourceImageThumb;

  return (
    <BaseNode id={id} selected={selected} contentClassName="flex-1 min-h-0 overflow-clip flex flex-col" aspectFitMedia={nodeData.outputImage || nodeData.outputImageThumb || nodeData.sourceImageThumb}>
      <Handle type="target" position={Position.Left} id="image" data-handletype="image" />
      <Handle type="source" position={Position.Right} id="image" data-handletype="image" />

      <div className="flex gap-1 mb-1 px-1 nodrag nopan">
        <label className="flex items-center gap-1 text-[10px] text-neutral-400 flex-1 min-w-0">
          H
          <input type="number" min={1} step={1} value={nodeData.width ?? 0} onChange={(e) => setNum("width", parseInt(e.target.value, 10))}
            className="w-full min-w-0 text-[10px] py-0.5 px-1 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700 focus:ring-1 focus:ring-neutral-600" title="Output width (horizontal resolution)" />
        </label>
        <label className="flex items-center gap-1 text-[10px] text-neutral-400 flex-1 min-w-0">
          V
          <input type="number" min={1} step={1} value={nodeData.height ?? 0} onChange={(e) => setNum("height", parseInt(e.target.value, 10))}
            className="w-full min-w-0 text-[10px] py-0.5 px-1 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700 focus:ring-1 focus:ring-neutral-600" title="Output height (vertical resolution)" />
        </label>
      </div>
      <div className="px-1 mb-1 nodrag nopan">
        <select value={nodeData.mode ?? "fill"} onChange={(e) => updateNodeData(id, { mode: e.target.value as ReformatNodeData["mode"] })}
          className="w-full text-[10px] py-0.5 px-1 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700">
          {MODES.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
        </select>
      </div>

      {displayImage ? (
        <div className="relative w-full flex-1 min-h-0">
          <img src={displayImage} alt="Reformatted" className="w-full h-full object-contain" />
          <div className="absolute bottom-1 left-1 right-1 text-center">
            <span className="text-[9px] text-white/60 bg-black/40 px-1.5 py-0.5 rounded">
              {Math.max(1, Math.round(nodeData.width || 0))}×{Math.max(1, Math.round(nodeData.height || 0))}
            </span>
          </div>
        </div>
      ) : (
        <div className="w-full flex-1 min-h-0 bg-neutral-900/40 flex items-center justify-center">
          <span className="text-[10px] text-neutral-500">Connect an image</span>
        </div>
      )}
    </BaseNode>
  );
}
