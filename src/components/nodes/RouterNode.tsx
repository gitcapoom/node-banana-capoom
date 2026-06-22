"use client";

import { memo, useMemo, useEffect, useState } from "react";
import { Handle, Position, useUpdateNodeInternals, useReactFlow, NodeProps, useNodes } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode, RouterNodeData } from "@/types";
import { useDynamicPinsEnabled } from "@/lib/dynamicPins";
import { parseDynPin, dynPinId } from "@/lib/dynamicPinId";
import { slotToLetter } from "@/lib/refTokens";

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

const IMG_FIELD = "primary";

export const RouterNode = memo(({ id, data, selected }: NodeProps<WorkflowNode>) => {
  const nodeData = data as RouterNodeData;
  const edges = useWorkflowStore((state) => state.edges);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  // useNodes() is reactive — re-renders when any node changes (including selection)
  const allNodes = useNodes() as WorkflowNode[];
  const dynamicPinsOn = useDynamicPinsEnabled();
  const [editing, setEditing] = useState<{ slot: number; draft: string } | null>(null);

  // Build per-type routing info (classic mode)
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
    const outEdge = edges.find(e => e.source === id && e.sourceHandle === "image");
    if (!outEdge) return 0;

    const targetId = outEdge.target;
    let count = 0;
    for (const e of edges) {
      if (e.target === targetId && e.id === outEdge.id) break;
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

  // Connected image-input slots for dynamic-pins (image-bundle) mode, sorted.
  const imageSlots = useMemo(() => {
    const slots: number[] = [];
    for (const e of edges) {
      if (e.target !== id) continue;
      const d = parseDynPin(e.targetHandle);
      if (d && d.type === "image" && d.field === IMG_FIELD) slots.push(d.slot);
    }
    return slots.sort((a, b) => a - b);
  }, [edges, id]);

  const refNames = nodeData.refNames || {};
  const tokenFor = (slot: number) => refNames[String(slot)] || slotToLetter(slot);

  const showGenericHandles = activeTypes.length < ALL_HANDLE_TYPES.length;

  const handleSpacing = 24;
  const baseOffset = 38;

  // Height: in dynamic mode, account for the image pins (+ trailing add + generic).
  const inputRowCount = dynamicPinsOn
    ? imageSlots.length + 1 /* add pin */ + 1 /* generic */
    : activeTypes.length + (showGenericHandles ? 1 : 0);
  const lastHandleTop = baseOffset + (Math.max(inputRowCount, 1) - 1) * handleSpacing;
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
  }, [inputRowCount, id, minHeight, setNodes, updateNodeInternals]);

  const commitRename = (slot: number, draft: string) => {
    const next = { ...(nodeData.refNames || {}) };
    const trimmed = draft.trim();
    // Empty or equal to the default letter → clear the custom name.
    if (!trimmed || trimmed === slotToLetter(slot)) delete next[String(slot)];
    else next[String(slot)] = trimmed.replace(/^@/, ""); // store without leading @
    updateNodeData(id, { refNames: next });
    setEditing(null);
  };

  // ─── Dynamic-pins image-bundle mode ──────────────────────────────────────
  if (dynamicPinsOn) {
    const nextSlot = imageSlots.length ? imageSlots[imageSlots.length - 1] + 1 : 0;
    const rows: Array<{ slot: number; empty: boolean }> = [
      ...imageSlots.map((slot) => ({ slot, empty: false })),
      { slot: nextSlot, empty: true },
    ];

    return (
      <BaseNode
        id={id}
        selected={selected}
        minWidth={220}
        minHeight={minHeight}
        className="bg-neutral-800/80 border-neutral-600"
      >
        {/* Image input pins (left) — stable token per slot */}
        {rows.map((row, idx) => {
          const top = baseOffset + idx * handleSpacing;
          const token = tokenFor(row.slot);
          const isEditing = editing?.slot === row.slot;
          return (
            <div key={`in-${row.slot}`}>
              <Handle
                type="target"
                position={Position.Left}
                id={dynPinId("image", IMG_FIELD, row.slot)}
                data-handletype="image"
                isConnectable={true}
                style={{
                  top,
                  backgroundColor: HANDLE_COLORS.image,
                  opacity: row.empty ? 0.4 : 1,
                  width: 12,
                  height: 12,
                  border: "2px solid #1e1e1e",
                }}
              />
              {isEditing ? (
                <input
                  autoFocus
                  defaultValue={editing!.draft}
                  onBlur={(e) => commitRename(row.slot, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(row.slot, (e.target as HTMLInputElement).value);
                    if (e.key === "Escape") setEditing(null);
                  }}
                  className="nodrag nopan absolute text-[10px] bg-[#1a1a1a] text-white rounded px-1 py-0.5 w-24 outline-none ring-1 ring-emerald-500"
                  style={{ right: "calc(100% + 8px)", top: `calc(${top}px - 18px)` }}
                />
              ) : (
                <div
                  className="absolute text-[10px] font-medium whitespace-nowrap text-right cursor-text select-none"
                  style={{
                    right: "calc(100% + 8px)",
                    top: `calc(${top}px - 18px)`,
                    color: HANDLE_COLORS.image,
                    opacity: row.empty ? 0.5 : 1,
                  }}
                  title={row.empty ? "Connect an image" : "Double-click to rename this reference"}
                  onDoubleClick={() => !row.empty && setEditing({ slot: row.slot, draft: token })}
                >
                  {row.empty ? "+ image" : `@${token}`}
                </div>
              )}
            </div>
          );
        })}

        {/* Generic input (other types still pass through) */}
        <Handle
          type="target"
          position={Position.Left}
          id="generic-input"
          isConnectable={true}
          style={{
            top: baseOffset + rows.length * handleSpacing,
            backgroundColor: "#6b7280",
            width: 12,
            height: 12,
            border: "2px solid #1e1e1e",
          }}
        />

        {/* Outputs (right): image bundle + generic */}
        <Handle
          type="source"
          position={Position.Right}
          id="image"
          data-handletype="image"
          isConnectable={true}
          style={{ top: baseOffset, backgroundColor: HANDLE_COLORS.image, width: 12, height: 12, border: "2px solid #1e1e1e" }}
        />
        <Handle
          type="source"
          position={Position.Right}
          id="generic-output"
          isConnectable={true}
          style={{ top: baseOffset + handleSpacing, backgroundColor: "#6b7280", width: 12, height: 12, border: "2px solid #1e1e1e" }}
        />

        <div className="text-[9px] text-neutral-500 py-1 px-2">
          {imageSlots.length > 0 ? (
            <span>Image group · reference as <span className="text-emerald-400 font-mono">@{tokenFor(imageSlots[0])}</span>…</span>
          ) : (
            <span className="text-center block">Connect images to group</span>
          )}
        </div>
      </BaseNode>
    );
  }

  // ─── Classic mode (unchanged) ────────────────────────────────────────────
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

            return (
              <div key={type} className="space-y-px">
                {routes.map((route, idx) => {
                  const isSourceSelected = !!route.sourceNode?.selected;
                  const globalIndex = offset + idx + 1;
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
