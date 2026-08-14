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

/**
 * ARRAY-valued image fields, which RUN_FULLRES_FIELDS cannot express.
 *
 * `inputImages` is a generator's stored copy of what was fed to it, used by the
 * executors ONLY as a fallback when nothing is connected (generateVideoExecutor
 * :48, generate3dExecutor:48, image2gsExecutor:56, connectedInputs:585). No
 * component renders it, so hydrating it at open bought nothing and cost
 * hundreds of MB of resident base64 for the whole session — it is now loaded
 * here, right before a run, like every other full-res field.
 */
const RUN_FULLRES_ARRAY_FIELDS: Partial<
  Record<NodeType, Array<{ raw: string; refs: string; folder: "inputs" | "generations" }>>
> = {
  nanoBanana: [{ raw: "inputImages", refs: "inputImageRefs", folder: "inputs" }],
  llmGenerate: [{ raw: "inputImages", refs: "inputImageRefs", folder: "inputs" }],
  generateVideo: [{ raw: "inputImages", refs: "inputImageRefs", folder: "inputs" }],
};

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
    const data = node.data as Record<string, unknown>;

    for (const af of RUN_FULLRES_ARRAY_FIELDS[node.type as NodeType] ?? []) {
      const refs = data[af.refs] as Array<string | null | undefined> | undefined;
      if (!Array.isArray(refs) || refs.length === 0) continue;
      const cur = (data[af.raw] as Array<string | null | undefined> | undefined) ?? [];
      // Nothing to do if every ref already has a loaded value beside it.
      if (refs.every((r, i) => !r || cur[i])) continue;
      tasks.push(
        (async () => {
          const next = [...cur];
          await Promise.all(
            refs.map(async (r, i) => {
              if (!r || next[i]) return;
              const url = await loadMediaById(r, saveDirectoryPath, af.folder);
              if (url) next[i] = url;
            }),
          );
          updateNodeData(id, { [af.raw]: next } as Partial<WorkflowNodeData>);
        })(),
      );
    }

    const fields = RUN_FULLRES_FIELDS[node.type as NodeType];
    if (!fields) continue;
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
