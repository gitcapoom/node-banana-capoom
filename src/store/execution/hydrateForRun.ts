/**
 * Full-res pre-pass for workflow execution.
 *
 * With lazy loading, displayed image fields are NULL on open (only an inline
 * thumb is kept). Executors read connected inputs — i.e. upstream producers'
 * OUTPUT fields — and may fall back to a node's own stored SOURCE. So before a
 * run, load full-res from disk for the execution set ∪ its transitive upstream.
 *
 * No-ops on already-loaded fields and on missing refs. Runs in parallel
 * (browser caps concurrent fetches); executors then read the freshly populated
 * store via getConnectedInputs / getFreshNode.
 */

import type { WorkflowNode, WorkflowNodeData, NodeType } from "@/types";
import { RUN_FULLRES_FIELDS } from "@/utils/imageFieldMap";
import { loadMediaById } from "@/utils/mediaStorage";

interface MinimalEdge {
  source: string;
  target: string;
}

/** All nodes that feed (directly or transitively) any of `rootIds`, plus the roots. */
function collectWithUpstream(rootIds: string[], edges: MinimalEdge[]): Set<string> {
  const need = new Set<string>(rootIds);
  const queue = [...rootIds];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.target === cur && !need.has(e.source)) {
        need.add(e.source);
        queue.push(e.source);
      }
    }
  }
  return need;
}

export async function ensureFullResForNodes(
  rootIds: string[],
  nodes: WorkflowNode[],
  edges: MinimalEdge[],
  updateNodeData: (nodeId: string, data: Partial<WorkflowNodeData>) => void,
  saveDirectoryPath: string | null,
): Promise<void> {
  if (!saveDirectoryPath || rootIds.length === 0) return;

  const need = collectWithUpstream(rootIds, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const tasks: Promise<void>[] = [];
  for (const id of need) {
    const node = byId.get(id);
    if (!node) continue;
    const fields = RUN_FULLRES_FIELDS[node.type as NodeType];
    if (!fields) continue;
    const data = node.data as Record<string, unknown>;
    for (const f of fields) {
      const raw = data[f.raw] as string | null | undefined;
      const ref = data[f.ref] as string | undefined;
      if (raw || !ref) continue; // already loaded, or nothing to load from
      tasks.push(
        (async () => {
          const url = await loadMediaById(ref, saveDirectoryPath, f.folder);
          if (url) updateNodeData(id, { [f.raw]: url } as Partial<WorkflowNodeData>);
        })(),
      );
    }
  }

  await Promise.all(tasks);
}
