import type { WorkflowNode, WorkflowEdge } from "@/types";

/**
 * Fields that existed only to serve loopback mode and carry no meaning now.
 * `composeInput` is deliberately NOT here — it was a loopback field and is now
 * the compose box on every node, so its value is worth keeping.
 */
const DEAD_FIELDS = [
  "conversationMode",
  "loopbackMode",
  "outputPrompt",
  "lastLoopbackInput",
  "firstImagePrompt",
] as const;

/**
 * Handles that disappear with loopback.
 *
 * These have to be cleaned up here because the existing conformance pass covers
 * NEITHER of them: `conformEdgesToRenderablePins` only inspects TARGET handles,
 * so an edge whose source is the removed `prompt` output is outside its remit
 * entirely, and its own rules state that `image-feedback` handles "are
 * untouched". An edge left pointing at a handle that no longer renders is
 * invisible on the canvas yet still resolves into request bodies.
 */
/**
 * Source handles the LLM node no longer renders.
 *
 * `prompt` went with loopback. `text` went with the prompt-node buttons: the
 * node puts its reply on the canvas as a real prompt node now, which can be
 * wired, edited and re-used, rather than emitting straight into an edge.
 *
 * Dropping these loses real wiring — 9 edges across 4 saved projects fed
 * downstream from `text`. There is no honest way to keep them: the handle they
 * attach to does not exist, and an edge to a handle that never renders is
 * invisible on the canvas while still resolving into request bodies. Re-wire
 * with "Send to prompt node".
 */
const isDeadSourceHandle = (h: string | null | undefined): boolean =>
  h === "prompt" || h === "text";

/**
 * Target handles the LLM node no longer renders.
 *
 * `image-feedback` went with loopback. The text input went with the compose
 * box: the node is driven inline now, so a prompt node wired into it would be
 * an input the UI gives no way to see or clear. Dynamic-pin text slots are
 * `text-<n>`, so match the prefix as well as the bare id.
 */
const isDeadTargetHandle = (h: string | null | undefined): boolean =>
  h === "image-feedback" || h === "text" || (typeof h === "string" && h.startsWith("text-"));

/**
 * Collapse the LLM node's old three modes onto a single `rememberTurns` flag,
 * and drop the edges that belonged to loopback's handles.
 *
 *   conversationMode: false / absent  ->  rememberTurns: false
 *   conversationMode: true            ->  rememberTurns: true
 *   loopbackMode: true                ->  rememberTurns: true   (it implied conversation)
 *
 * Idempotent, because workflows are loaded, saved and reloaded repeatedly: a
 * node that has already been migrated has no dead fields and keeps whatever
 * `rememberTurns` the user has since chosen. Array identity is preserved when
 * nothing changed so callers can skip a state update entirely.
 */
export function migrateLlmNodes(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const llmIds = new Set<string>();
  let nodesChanged = false;

  const outNodes = nodes.map((n) => {
    if (n.type !== "llmGenerate") return n;
    llmIds.add(n.id);

    const d = n.data as Record<string, unknown>;
    const hasDead = DEAD_FIELDS.some((k) => k in d);
    // Already migrated and clean — leave the node object untouched.
    if (!hasDead && "rememberTurns" in d) return n;

    const next: Record<string, unknown> = { ...d };
    // Either old flag means "send the transcript"; loopback implied conversation.
    const remember = d.loopbackMode === true || d.conversationMode === true;
    for (const k of DEAD_FIELDS) delete next[k];
    // An explicit rememberTurns already on the node wins over the derived value,
    // so a re-run cannot overwrite a choice made after the first migration.
    next.rememberTurns = "rememberTurns" in d ? d.rememberTurns : remember;

    nodesChanged = true;
    return { ...n, data: next } as WorkflowNode;
  });

  const outEdges = edges.filter((e) => {
    if (e.target && llmIds.has(e.target) && isDeadTargetHandle(e.targetHandle)) return false;
    if (e.source && llmIds.has(e.source) && isDeadSourceHandle(e.sourceHandle)) return false;
    return true;
  });

  return {
    nodes: nodesChanged ? outNodes : nodes,
    edges: outEdges.length === edges.length ? edges : outEdges,
  };
}
