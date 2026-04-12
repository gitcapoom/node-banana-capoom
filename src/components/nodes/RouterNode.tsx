"use client";

import { memo, useMemo, useEffect } from "react";
import { Handle, Position, useUpdateNodeInternals, useReactFlow, NodeProps, useNodes } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode, RouterNodeData } from "@/types";

const ALL_HANDLE_TYPES = ["image", "text", "video", "audio", "3d", "easeCurve"] as const;
type HandleType = (typeof ALL_HANDLE_TYPES)[number];

const HANDLE_COLORS: Record<HandleType, string> = {
  image: "#10b981",
  text: "#3b82f6",
  video: "#ffffff",
  audio: "rgb(167, 139, 250)",
  "3d": "#f97316",
  easeCurve: "#ffffff",
};

const HANDLE_LABELS: Record<HandleType, string> = {
  image: "Img",
  text: "Txt",
  video: "Vid",
  audio: "Aud",
  "3d": "3D",
  easeCurve: "Ease",
};

/** Get a short display name for a node */
function getNodeLabel(node: WorkflowNode): string {
  const d = node.data as Record<string, unknown>;
  const name = d.label || d.filename || d.worldName || d.text;
  if (typeof name === "string" && name.length > 0) return name.slice(0, 18);
  const model = d.selectedModel as { displayName?: string } | undefined;
  if (model?.displayName) return model.displayName.slice(0, 18);
  return node.type?.replace(/([A-Z])/g, " $1").trim().slice(0, 18) || "Node";
}

export const RouterNode = memo(({ id, data, selected }: NodeProps<WorkflowNode>) => {
  const nodeData = data as RouterNodeData;
  const edges = useWorkflowStore((state) => state.edges);
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  // useNodes() is reactive — re-renders when any node changes (including selection)
  const allNodes = useNodes() as WorkflowNode[];

  // Build per-type routing info
  const typeRoutes = useMemo(() => {
    const map = new Map<HandleType, Array<{ sourceId: string; sourceNode: WorkflowNode | undefined }>>();
    const nodeMap = new Map(allNodes.map(n => [n.id, n]));

    edges
      .filter((edge) => edge.target === id)
      .forEach((edge) => {
        const handleType = edge.targetHandle as HandleType;
        if (handleType && ALL_HANDLE_TYPES.includes(handleType)) {
          const list = map.get(handleType) || [];
          list.push({
            sourceId: edge.source,
            sourceNode: nodeMap.get(edge.source),
          });
          map.set(handleType, list);
        }
      });

    return map;
  }, [edges, id, allNodes]);

  // Calculate the image index offset: how many images does the downstream node
  // already have connected (not through this router)?
  const imageOffset = useMemo(() => {
    // Find the downstream node connected to this router's image output
    const outEdge = edges.find(e => e.source === id && e.sourceHandle === "image");
    if (!outEdge) return 0;

    const targetId = outEdge.target;
    // Count image edges to the target that come BEFORE the router's edge
    // (i.e., edges from other sources, not from this router)
    let count = 0;
    for (const e of edges) {
      if (e.target === targetId && e.id === outEdge.id) break; // stop when we reach our edge
      if (e.target === targetId &&
          (e.targetHandle === "image" || e.targetHandle?.startsWith("image-"))) {
        count++;
      }
    }
    return count;
  }, [edges, id]);

  const activeTypes = useMemo(() =>
    Array.from(typeRoutes.keys()).sort(),
    [typeRoutes]
  );

  const showGenericHandles = activeTypes.length < ALL_HANDLE_TYPES.length;

  const handleSpacing = 24;
  const baseOffset = 38;

  const totalSlots = activeTypes.length + (showGenericHandles ? 1 : 0);
  const lastHandleTop = baseOffset + (Math.max(totalSlots, 1) - 1) * handleSpacing;
  const minHeight = lastHandleTop + 20;

  useEffect(() => {
    setNodes((nodes) =>
      nodes.map((node) => {
        if (node.id === id) {
          const currentHeight = (node.style?.height as number) || 0;
          if (currentHeight < minHeight) {
            return { ...node, style: { ...node.style, height: minHeight } };
          }
        }
        return node;
      })
    );
    updateNodeInternals(id);
  }, [activeTypes.length, id, minHeight, setNodes, updateNodeInternals]);

  return (
    <BaseNode
      id={id}
      selected={selected}
      minWidth={220}
      minHeight={minHeight}
      className="bg-neutral-800/80 border-neutral-600"
    >
      {/* Input handles (left) */}
      {activeTypes.map((type, index) => (
        <Handle
          key={`input-${type}`}
          type="target"
          position={Position.Left}
          id={type}
          data-handletype={type}
          isConnectable={true}
          style={{
            top: baseOffset + index * handleSpacing,
            backgroundColor: HANDLE_COLORS[type],
            width: 12,
            height: 12,
            border: "2px solid #1e1e1e",
          }}
        />
      ))}
      {showGenericHandles && (
        <Handle
          type="target"
          position={Position.Left}
          id="generic-input"
          isConnectable={true}
          style={{
            top: baseOffset + activeTypes.length * handleSpacing,
            backgroundColor: "#6b7280",
            width: 12,
            height: 12,
            border: "2px solid #1e1e1e",
          }}
        />
      )}

      {/* Output handles (right) */}
      {activeTypes.map((type, index) => (
        <Handle
          key={`output-${type}`}
          type="source"
          position={Position.Right}
          id={type}
          data-handletype={type}
          isConnectable={true}
          style={{
            top: baseOffset + index * handleSpacing,
            backgroundColor: HANDLE_COLORS[type],
            width: 12,
            height: 12,
            border: "2px solid #1e1e1e",
          }}
        />
      ))}
      {showGenericHandles && (
        <Handle
          type="source"
          position={Position.Right}
          id="generic-output"
          isConnectable={true}
          style={{
            top: baseOffset + activeTypes.length * handleSpacing,
            backgroundColor: "#6b7280",
            width: 12,
            height: 12,
            border: "2px solid #1e1e1e",
          }}
        />
      )}

      {/* Body — routing table */}
      <div className="text-[9px] text-neutral-500 py-1 px-2 space-y-0.5">
        {activeTypes.length > 0 ? (
          activeTypes.map((type) => {
            const routes = typeRoutes.get(type) || [];
            const offset = type === "image" ? imageOffset : 0;

            if (routes.length <= 1 && offset === 0) {
              // Single connection, no offset: compact display
              return (
                <div key={type} className="flex items-center gap-1">
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: HANDLE_COLORS[type] }}
                  />
                  <span className="text-neutral-400">{HANDLE_LABELS[type]}</span>
                  {routes[0]?.sourceNode && (
                    <span className={`truncate ${routes[0].sourceNode.selected ? "text-white font-medium" : "text-neutral-500"}`}>
                      ← {getNodeLabel(routes[0].sourceNode)}
                    </span>
                  )}
                </div>
              );
            }

            // Multiple connections or offset: numbered routing table
            return (
              <div key={type} className="space-y-px">
                {routes.map((route, idx) => {
                  const isSourceSelected = !!route.sourceNode?.selected;
                  const globalIndex = offset + idx + 1; // 1-based
                  return (
                    <div
                      key={`${type}-${idx}`}
                      className={`flex items-center gap-1 rounded px-0.5 transition-colors ${
                        isSourceSelected ? "bg-neutral-700/80" : ""
                      }`}
                    >
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: HANDLE_COLORS[type] }}
                      />
                      <span className={`truncate flex-1 ${isSourceSelected ? "text-white font-medium" : "text-neutral-500"}`}>
                        {route.sourceNode ? getNodeLabel(route.sourceNode) : "?"}
                      </span>
                      <span className="text-neutral-600">→</span>
                      <span className={`font-mono shrink-0 ${isSourceSelected ? "text-emerald-400 font-bold" : "text-neutral-400"}`}>
                        {HANDLE_LABELS[type]}:{globalIndex}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })
        ) : (
          <span className="text-center block">Drop connections here</span>
        )}
      </div>
    </BaseNode>
  );
});

RouterNode.displayName = "RouterNode";
