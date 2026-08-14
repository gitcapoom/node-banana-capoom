"use client";

import { useNodeConnections, useNodesData } from "@xyflow/react";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import type { WorkflowNode } from "@/types";

export interface UpstreamImage {
  /** Resolved image URL from the connected node, or null when nothing is wired. */
  image: string | null;
  /** Id of the node feeding this handle — null when unconnected. */
  sourceId: string | null;
  /** Type of that node, for callers that care (e.g. float-chain detection). */
  sourceType: string | null;
  /** True when an edge exists, even if its value hasn't loaded yet. */
  connected: boolean;
}

/**
 * Resolve the image arriving on one input handle — through React Flow's indexes.
 *
 * The obvious implementation is a zustand selector that scans `state.edges` for
 * the edge and `state.nodes` for its source. That is O(edges + nodes) per node,
 * and zustand re-runs every subscriber's selector on every store write — so on a
 * canvas full of GPU nodes (each writing on every commit) the cost is quadratic
 * and shows up as sluggish panning.
 *
 * `useNodeConnections` and `useNodesData` read React Flow's maintained
 * connection/node indexes instead, and only re-render when *this* handle's
 * connection or *that* node's data actually changes.
 */
export function useUpstreamImage(handleId: string = "image"): UpstreamImage {
  const connections = useNodeConnections({ handleType: "target", handleId });
  const sourceId = connections[0]?.source ?? null;
  const sourceNode = useNodesData(sourceId ?? "");

  if (!sourceId || !sourceNode) {
    return { image: null, sourceId: null, sourceType: null, connected: connections.length > 0 };
  }

  const out = getSourceOutput(
    sourceNode as unknown as WorkflowNode,
    connections[0]?.sourceHandle ?? null,
  );

  return {
    image: out.type === "image" ? out.value : null,
    sourceId,
    sourceType: sourceNode.type ?? null,
    connected: true,
  };
}
