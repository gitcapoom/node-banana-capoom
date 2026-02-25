import type { WorkflowNode, WorkflowEdge, SwitchNodeData } from "@/types";

/**
 * Compute set of node IDs that should be visually dimmed.
 * A node is dimmed if ALL its input paths trace back to disabled Switch outputs.
 * Smart cascade: if a node has at least one active input from a non-disabled source, it stays active.
 */
export function computeDimmedNodes(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): Set<string> {
  // Step 1: Find all nodes that are downstream of disabled Switch outputs
  const potentiallyDimmed = new Set<string>();

  nodes.forEach(node => {
    if (node.type !== "switch") return;
    const switchData = node.data as SwitchNodeData;
    if (!switchData.switches) return;

    switchData.switches.forEach(sw => {
      if (sw.enabled) return; // Only process disabled switches

      // Find edges from this disabled output handle
      const disabledEdges = edges.filter(
        e => e.source === node.id && e.sourceHandle === sw.id
      );

      // DFS traverse downstream from each disabled edge target
      disabledEdges.forEach(edge => {
        traverseDownstream(edge.target, edges, potentiallyDimmed);
      });
    });
  });

  // Step 2: Smart cascade — remove nodes that have at least one active input
  // A node stays active if any incoming edge comes from a source NOT in potentiallyDimmed
  // AND that source is not a Switch with a disabled output pointing to this node
  const finalDimmed = new Set<string>();

  potentiallyDimmed.forEach(nodeId => {
    const incomingEdges = edges.filter(e => e.target === nodeId);

    // Check if any incoming edge provides an active path
    const hasActiveInput = incomingEdges.some(edge => {
      // Source is not potentially dimmed — it's an active source
      if (!potentiallyDimmed.has(edge.source)) {
        // But also check: is this edge coming from a disabled Switch output?
        const sourceNode = nodes.find(n => n.id === edge.source);
        if (sourceNode?.type === "switch") {
          const switchData = sourceNode.data as SwitchNodeData;
          const switchEntry = switchData.switches?.find(s => s.id === edge.sourceHandle);
          // If this specific switch output is disabled, it's not an active path
          if (switchEntry && !switchEntry.enabled) return false;
        }
        return true; // Active source, not dimmed
      }
      return false; // Source is also dimmed
    });

    if (!hasActiveInput) {
      finalDimmed.add(nodeId);
    }
  });

  return finalDimmed;
}

/**
 * DFS traversal to find all downstream nodes from a starting node.
 * Uses visited set for cycle detection.
 */
function traverseDownstream(
  nodeId: string,
  edges: WorkflowEdge[],
  visited: Set<string>
): void {
  if (visited.has(nodeId)) return; // Cycle detection
  visited.add(nodeId);

  edges
    .filter(e => e.source === nodeId)
    .forEach(edge => traverseDownstream(edge.target, edges, visited));
}
