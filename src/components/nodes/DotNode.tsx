"use client";

import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import type { DotNodeData } from "@/types";

type DotNodeType = Node<DotNodeData, "dot">;

/**
 * Dot — a reroute point, in the spirit of Nuke's Dot.
 *
 * Purely visual: it carries whatever arrives straight through (see
 * getSourceOutput), and exists so long edges can be bent around the graph
 * instead of cutting across it. Ctrl+click an edge to drop one in place; it
 * selects and deletes like any other node.
 *
 * Deliberately tiny and chrome-free — no BaseNode wrapper, no resizer, no
 * header — because a reroute point that draws attention defeats the purpose.
 */
export function DotNode({ selected }: NodeProps<DotNodeType>) {
  return (
    <div
      className={`relative rounded-full transition-colors ${
        selected ? "bg-blue-400 ring-2 ring-blue-400/40" : "bg-neutral-400 hover:bg-neutral-200"
      }`}
      style={{ width: DOT_SIZE, height: DOT_SIZE }}
      title="Dot — reroute point"
    >
      {/* Both handles sit dead centre so edges meet at the dot itself. */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        data-handletype="image"
        style={{ left: "50%", top: "50%", width: DOT_SIZE, height: DOT_SIZE, opacity: 0, transform: "translate(-50%, -50%)" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        data-handletype="image"
        style={{ left: "50%", top: "50%", width: DOT_SIZE, height: DOT_SIZE, opacity: 0, transform: "translate(-50%, -50%)" }}
      />
    </div>
  );
}

export const DOT_SIZE = 14;
