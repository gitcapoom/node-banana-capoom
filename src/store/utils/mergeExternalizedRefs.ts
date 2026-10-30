import type { WorkflowNode, WorkflowNodeData } from "@/types";

/**
 * After a save, copy the refs that externalization assigned back onto the
 * live store nodes, keeping each node's current media data.
 *
 * Merges into the LATEST store nodes, not the snapshot taken when the save
 * started, so data updated during the async save (a generation finishing, say)
 * is not overwritten. Nodes are matched by id: some may have been added or
 * removed meanwhile, and an added node is kept as it is.
 *
 * Copies EVERY ref field. This used to be a hand-kept list of field names and
 * it drifted: videoFileRef, capturedImageRef and imageRefs were written to the
 * file but never to the live node. A clip dropped on the canvas therefore had
 * no ref until the workflow was reopened, so a Run could not send it from disk
 * and refused it as "over the 20 MB limit".
 */
export function mergeExternalizedRefs(
  liveNodes: WorkflowNode[],
  externalizedNodes: WorkflowNode[],
): WorkflowNode[] {
  const byId = new Map(externalizedNodes.map((n) => [n.id, n]));
  return liveNodes.map((node) => {
    const ext = byId.get(node.id);
    if (!ext) return node;
    const merged = { ...node.data } as Record<string, unknown>;
    for (const [key, value] of Object.entries(ext.data as Record<string, unknown>)) {
      if (key.endsWith("Ref") && typeof value === "string" && value) merged[key] = value;
      else if (key.endsWith("Refs") && Array.isArray(value)) merged[key] = value;
    }
    return { ...node, data: merged as WorkflowNodeData } as WorkflowNode;
  });
}
