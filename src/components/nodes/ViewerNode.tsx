"use client";

import { useCallback, useEffect, type CSSProperties } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import type { ViewerNodeData } from "@/types";

type ViewerNodeType = Node<ViewerNodeData, "viewer">;

const CHECKER_STYLE: CSSProperties = {
  backgroundColor: "#454545",
  backgroundImage:
    "linear-gradient(45deg, #5e5e5e 25%, transparent 25%, transparent 75%, #5e5e5e 75%, #5e5e5e), linear-gradient(45deg, #5e5e5e 25%, transparent 25%, transparent 75%, #5e5e5e 75%, #5e5e5e)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
};

/**
 * Viewer — a live tap on the graph.
 *
 * The distinction from Output is *when* it reflects its input. Output mirrors
 * on execution; the Viewer resolves its upstream in a store selector, so it
 * repaints whenever any node feeding it writes a new result — including edits
 * made inside an editor modal, which commit their output as you work. Park one
 * at the end of a chain and it behaves like a Nuke viewer: change a roto matte
 * three nodes upstream and the composite lands here without a run.
 */
export function ViewerNode({ id, data, selected }: NodeProps<ViewerNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);

  // Resolve the upstream image reactively — this is what makes the node live.
  const incoming = useWorkflowStore((state): string | null => {
    const edge = state.edges.find((e) => e.target === id && (e.targetHandle === "image" || e.targetHandle == null));
    if (!edge) return null;
    const src = state.nodes.find((n) => n.id === edge.source);
    if (!src) return null;
    const out = getSourceOutput(src, edge.sourceHandle, edge.data as Record<string, unknown> | undefined);
    return out.type === "image" ? out.value : null;
  });

  // Mirror into node data so the shared full-screen viewer (which reads a node
  // field, not a URL) shows this — and keeps showing it live while open.
  useEffect(() => {
    if (incoming !== nodeData.image) {
      updateNodeData(id, { image: incoming, imageRef: undefined });
    }
  }, [id, incoming, nodeData.image, updateNodeData]);

  const toggleChecker = useCallback(
    () => updateNodeData(id, { checkerboard: !nodeData.checkerboard }),
    [id, nodeData.checkerboard, updateNodeData],
  );

  const display = nodeData.image ?? nodeData.imageThumb ?? null;

  return (
    <BaseNode id={id} selected={selected} fullBleed aspectFitMedia={display}>
      <Handle type="target" position={Position.Left} id="image" data-handletype="image" />

      <div
        data-node-media="image"
        className="group absolute inset-0 overflow-hidden rounded-lg cursor-pointer"
        style={nodeData.checkerboard ? CHECKER_STYLE : { backgroundColor: "#000" }}
        title={display ? "Double-click to view full screen (stays live)" : "Connect an image"}
      >
        {display ? (
          <>
            <img src={display} alt="Viewer" className="w-full h-full object-contain" draggable={false} />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/15 transition-colors flex items-center justify-center pointer-events-none">
              <span className="text-[10px] font-medium text-white opacity-0 group-hover:opacity-100 bg-black/50 px-2 py-1 rounded">
                Double-click to view
              </span>
            </div>
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-neutral-500">
            Connect an image
          </div>
        )}

        <button
          onClick={(e) => { e.stopPropagation(); toggleChecker(); }}
          onDoubleClick={(e) => e.stopPropagation()}
          className={`nodrag nopan absolute top-1 right-1 px-1.5 py-0.5 rounded text-[9px] transition-opacity opacity-0 group-hover:opacity-100 ${
            nodeData.checkerboard ? "bg-teal-600 text-white" : "bg-black/60 text-white/80"
          }`}
          title="Show transparency as a checkerboard"
        >
          Alpha
        </button>
      </div>
    </BaseNode>
  );
}
