import type { WorkflowNode, WorkflowEdge } from "@/types";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { mediaRefOf } from "@/lib/mediaRefs";

/**
 * Find the on-disk id behind a resolved input value.
 *
 * `getConnectedInputs` flattens everything to bare URLs, so by the time a value
 * reaches the executor its origin is gone. To send it by reference instead of
 * inline we need the ref — which lives on the node that produced it — so this
 * walks the consumer's incoming edges and asks each source what it emits,
 * matching on the value itself.
 *
 * Matching by value rather than by handle is deliberate: a dynamic pin's field
 * name does not tell you which edge filled it, and the same clip may arrive on
 * several pins. The comparison is cheap despite the size of these strings —
 * `dynamicInputs` holds the very string instance `getSourceOutput` returned, so
 * `===` settles on identity without comparing contents.
 */
export function findMediaRefForValue(
  value: string,
  consumerNodeId: string,
  edges: WorkflowEdge[],
  nodes: WorkflowNode[],
): string | null {
  for (const edge of edges) {
    if (edge.target !== consumerNodeId) continue;
    const source = nodes.find((n) => n.id === edge.source);
    if (!source) continue;
    const out = getSourceOutput(
      source,
      edge.sourceHandle,
      edge.data as Record<string, unknown> | undefined,
    );
    if (out.value !== value) continue;
    const ref = mediaRefOf(source);
    if (ref) return ref;
  }
  return null;
}
