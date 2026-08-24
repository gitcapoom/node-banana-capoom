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
import { RUN_FULLRES_FIELDS, type RunImageField } from "@/utils/imageFieldMap";
import { loadMediaById } from "@/utils/mediaStorage";
import { __OUTPUT_REF_FIELD } from "@/utils/compSignature";

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

/**
 * Ref-backed VIDEO outputs, by producer type.
 *
 * Deliberately NOT folded into RUN_FULLRES_FIELDS. Those fields are loaded for
 * the whole transitive upstream of every run; a video is one to two orders of
 * magnitude larger than an image, and hydrating every clip in a graph on every
 * run is exactly what `hydrateNodeImages` avoids when it writes
 * `outputVideo: null` on open ("loaded on-demand in overlay"). So videos are
 * pulled back only by the ONE consumer that cannot work without them, and only
 * for the producers actually feeding it — see `ensureVideoInputs`.
 *
 * Only these two types persist a video: `videoStitch` / `easeCurve` /
 * `videoTrim` publish blob URLs and carry no ref, so a run recomputes them.
 */
const VIDEO_OUTPUT_FIELDS: Partial<Record<NodeType, RunImageField>> = {
  generateVideo: { raw: "outputVideo", ref: "outputVideoRef", folder: "generations" },
  videoInput: { raw: "videoFile", ref: "videoFileRef", folder: "inputs" },
};

/**
 * Node types that carry a video THROUGH rather than producing one.
 *
 * `getConnectedInputsPure` resolves straight past these to whatever feeds them,
 * so a frame grab behind a Dot reads the clip fine once it is loaded — but the
 * Dot itself has no video field, so a direct-sources-only walk stopped there and
 * loaded nothing. Dots are inserted by ctrl+clicking any edge, so this is the
 * ordinary case, not an exotic one. Kept to a fixed list rather than a general
 * upstream walk: tracing every branch would drag whole video chains back in,
 * which is what confining this to one consumer is meant to avoid.
 */
const VIDEO_REROUTE_TYPES = new Set<string>(["dot", "router", "switch", "conditionalSwitch"]);

/**
 * Load the full video for every producer feeding `nodeId`, through reroutes.
 *
 * `videoInput.videoFile` and `generateVideo.outputVideo` are both nulled on open
 * with only a ref left behind, and NO run pre-pass loads them back. A frame grab
 * on a reopened workflow therefore read `inputs.videos` as empty and failed with
 * "Connect a video input to extract a frame" on a graph that is visibly wired —
 * a Run repaired nothing, because the run pre-pass never touched video at all.
 */
export async function ensureVideoInputs(
  nodeId: string,
  nodes: WorkflowNode[],
  edges: MinimalEdge[],
  updateNodeData: (nodeId: string, data: Partial<WorkflowNodeData>) => void,
  saveDirectoryPath: string | null,
): Promise<void> {
  if (!saveDirectoryPath) return;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Direct sources, plus anything behind a chain of pure reroutes.
  const producerIds = new Set<string>();
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.target !== cur || seen.has(e.source)) continue;
      seen.add(e.source);
      const src = byId.get(e.source);
      if (src && VIDEO_REROUTE_TYPES.has(src.type as string)) queue.push(e.source);
      else producerIds.add(e.source);
    }
  }

  await Promise.all(
    [...producerIds].map(async (srcId) => {
      const src = byId.get(srcId);
      if (!src) return;
      const field = VIDEO_OUTPUT_FIELDS[src.type as NodeType];
      if (!field) return;
      const data = src.data as Record<string, unknown>;
      const raw = data[field.raw] as string | null | undefined;
      const ref = data[field.ref] as string | undefined;
      if (raw || !ref) return; // already loaded, or nothing to load from
      const url = await loadMediaById(ref, saveDirectoryPath, field.folder);
      if (url) updateNodeData(srcId, { [field.raw]: url } as Partial<WorkflowNodeData>);
    }),
  );
}

/**
 * The ref FIELD NAME holding this node's output, or null if it has no known
 * output. Mirrors `outputRefField` in compSignature (which returns the value)
 * and shares its table, so the two cannot drift.
 */
function outputRefFieldName(node: WorkflowNode): string | null {
  if (node.type === "imageInput") {
    const d = node.data as Record<string, unknown>;
    return d.flipHorizontal || d.flipVertical ? "outputImageRef" : "imageRef";
  }
  return __OUTPUT_REF_FIELD[node.type as NodeType] ?? null;
}

/**
 * Nodes needed to SHOW `rootIds` their inputs — as opposed to running them.
 *
 * Walks upstream like `collectWithUpstream`, but stops at any producer that can
 * already serve its own output from disk: if a crop has an `outputImageRef`,
 * loading that one file is everything a consumer needs, and the crop's own
 * source is irrelevant. Only a producer with NO committed output has to be
 * traced further back, because it would have to recompute to produce anything.
 *
 * Why this exists: opening one comp editor hydrated the whole transitive
 * closure — measured at 31 full-res images and ~45s for a single node — because
 * the run pre-pass was reused verbatim for a job that never runs anything.
 */
function collectForConsumer(
  rootIds: string[],
  edges: MinimalEdge[],
  byId: Map<string, WorkflowNode>,
): { need: Set<string>; satisfied: Set<string> } {
  const need = new Set<string>(rootIds);
  // Producers we STOPPED at because their output is already on disk. Only these
  // may have their field list narrowed to the output — a node we traced PAST has
  // to recompute, and needs its source to do it.
  const satisfied = new Set<string>();
  const queue = [...rootIds];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.target !== cur || need.has(e.source)) continue;
      need.add(e.source);
      const src = byId.get(e.source);
      const refField = src ? outputRefFieldName(src) : null;
      const hasCommittedOutput =
        !!src && !!refField && typeof (src.data as Record<string, unknown>)[refField] === "string";
      // Committed output on disk -> its inputs buy us nothing. Unknown node type
      // (no entry in the table) falls through and is traced, which is the
      // conservative direction: extra loads, never a missing one.
      if (hasCommittedOutput) {
        satisfied.add(e.source);
        continue;
      }
      queue.push(e.source);
    }
  }
  return { need, satisfied };
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
  /**
   * "run" (default) loads the whole transitive upstream and every full-res field
   * on it, because an executor may re-run any of those nodes and fall back to
   * their stored sources.
   *
   * "consumer" is for a node that only needs to DISPLAY its inputs (an editor
   * opening, a GPU node rendering). It stops at producers with a committed
   * output, and for those loads only the output field — not the `sourceImage`
   * beside it, which no consumer ever reads.
   */
  mode: "run" | "consumer" = "run",
): Promise<void> {
  if (!saveDirectoryPath || rootIds.length === 0) return;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const consumer = mode === "consumer";
  const collected = consumer ? collectForConsumer(rootIds, edges, byId) : null;
  const need = collected ? collected.need : collectWithUpstream(rootIds, edges);
  const satisfied = collected ? collected.satisfied : new Set<string>();
  const rootSet = new Set(rootIds);

  const tasks: Promise<void>[] = [];
  for (const id of need) {
    const node = byId.get(id);
    if (!node) continue;
    const data = node.data as Record<string, unknown>;

    // Generator input mirrors are an execution-only fallback — nothing displays
    // them, so a consumer never needs an upstream's copy.
    const arrayFields =
      consumer && !rootSet.has(id) ? [] : RUN_FULLRES_ARRAY_FIELDS[node.type as NodeType] ?? [];
    for (const af of arrayFields) {
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

    let fields = RUN_FULLRES_FIELDS[node.type as NodeType];
    if (!fields) continue;
    if (consumer && satisfied.has(id)) {
      // A SATISFIED upstream is only ever read through its output. Loading its
      // source too doubled the traffic for every crop/roto/colour node in a
      // chain, each of which lists both. Deliberately keyed on `satisfied` and
      // not merely "not a root": a node traced past has no committed output, so
      // filtering to that output would load NOTHING and leave it unable to
      // recompute — a blank editor. A test pins exactly this.
      const outRef = outputRefFieldName(node);
      if (outRef) fields = fields.filter((f) => f.ref === outRef);
    }
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
