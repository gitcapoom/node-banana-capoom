import { WorkflowFile } from "@/store/workflowStore";
import { WorkflowEdge } from "@/types/workflow";
import {
  WorkflowNode,
  NanoBananaNodeData,
  GenerateVideoNodeData,
  GenerateAudioNodeData,
} from "@/types/nodes";

/**
 * Extract the upstream subgraph contributing to a given output node.
 * Returns a WorkflowFile with embedded=true, containing only the nodes
 * and edges upstream of the output node. Generation nodes are trimmed
 * to contain only the single image/video/audio that contributed to the output.
 */
export function extractUpstreamWorkflow(
  outputNodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  edgeStyle: "angular" | "curved",
  workflowName?: string
): WorkflowFile {
  // 1. BFS/DFS backward traversal to find all upstream node IDs
  const upstreamIds = new Set<string>();
  const visited = new Set<string>();

  function traverseUpstream(nodeId: string) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    upstreamIds.add(nodeId);

    // Find all edges targeting this node (incoming edges)
    const incomingEdges = edges.filter((e) => e.target === nodeId);
    for (const edge of incomingEdges) {
      traverseUpstream(edge.source);
    }
  }

  traverseUpstream(outputNodeId);

  // 2. Filter nodes and edges to only the upstream subgraph (exclude the output node itself)
  upstreamIds.delete(outputNodeId);

  const upstreamNodes = nodes
    .filter((n) => upstreamIds.has(n.id))
    .map((n) => structuredClone(n)); // Deep clone to avoid mutating original

  const upstreamEdges = edges.filter(
    (e) => upstreamIds.has(e.source) && upstreamIds.has(e.target)
  );

  // 3. Trim generation nodes to only the contributing output
  for (const node of upstreamNodes) {
    // Strip selection state
    (node as Record<string, unknown>).selected = false;

    if (node.type === "nanoBanana") {
      const data = node.data as NanoBananaNodeData;
      // Keep only the current outputImage, clear history
      data.imageHistory = [];
      data.selectedHistoryIndex = -1;
      // outputImage already contains the contributing image
      // Clear input image refs (they'll be inline base64)
      data.inputImageRefs = undefined;
      data.outputImageRef = undefined;
    } else if (node.type === "generateVideo") {
      const data = node.data as GenerateVideoNodeData;
      data.videoHistory = [];
      data.selectedVideoHistoryIndex = -1;
      data.outputVideoRef = undefined;
    } else if (node.type === "generateAudio") {
      const data = node.data as GenerateAudioNodeData;
      data.audioHistory = [];
      data.selectedAudioHistoryIndex = -1;
      data.outputAudioRef = undefined;
    }

    // For imageInput nodes, clear external refs (keep inline base64)
    if (node.type === "imageInput") {
      const data = node.data as Record<string, unknown>;
      data.imageRef = undefined;
    }

  }

  // 4. Build the embedded workflow file
  return {
    version: 1,
    name: workflowName || "output-sidecar",
    nodes: upstreamNodes,
    edges: upstreamEdges,
    edgeStyle,
    embedded: true,
  };
}
