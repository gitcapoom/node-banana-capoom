/**
 * Per-node Run gating — supports running independent nodes in parallel.
 *
 * The workflow store tracks `currentNodeIds: string[]` (which nodes are
 * currently executing). For a Run / Regenerate button on node X to be
 * enabled, none of X's transitive upstream dependencies — and X itself
 * — may be in that set. Nodes that *don't* depend on anything currently
 * running are fair game and can be started concurrently.
 *
 * Old behaviour (single global `isRunning` boolean) refused all new
 * runs while anything was in flight, blocking unrelated work.
 */

import type { Edge, Node } from "@xyflow/react";

/**
 * Walk transitively backwards from `nodeId` along incoming edges and
 * return every ancestor node ID reachable. Cycles (shouldn't exist in a
 * DAG but we don't trust the upstream) are handled by the `visited` set.
 */
export function getTransitiveUpstream(
  nodeId: string,
  edges: Edge[],
): Set<string> {
  const result = new Set<string>();
  const stack = [nodeId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of edges) {
      if (edge.target === current && !result.has(edge.source)) {
        result.add(edge.source);
        stack.push(edge.source);
      }
    }
  }
  return result;
}

export interface RunBlocker {
  /** The currently-running node that's preventing the start. */
  id: string;
  /** Best-effort label for tooltips ("nanoBanana", "generateVideo", …). */
  type: string | undefined;
  /**  "self" → the node itself is running.
   *  "upstream" → one of its dependencies is running. */
  kind: "self" | "upstream";
}

/**
 * If `nodeId` can't be Run/Regenerated right now because of in-flight
 * work, return the blocker so the UI can show a useful tooltip; null if
 * the node is free to run.
 */
export function getRunBlocker(
  nodeId: string,
  currentNodeIds: string[],
  nodes: Node[],
  edges: Edge[],
): RunBlocker | null {
  if (currentNodeIds.length === 0) return null;
  const runningSet = new Set(currentNodeIds);
  if (runningSet.has(nodeId)) {
    return {
      id: nodeId,
      type: nodes.find((n) => n.id === nodeId)?.type,
      kind: "self",
    };
  }
  const upstream = getTransitiveUpstream(nodeId, edges);
  for (const runningId of currentNodeIds) {
    if (upstream.has(runningId)) {
      return {
        id: runningId,
        type: nodes.find((n) => n.id === runningId)?.type,
        kind: "upstream",
      };
    }
  }
  return null;
}
