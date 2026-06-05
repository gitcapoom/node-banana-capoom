"use client";

import { useWorkflowStore } from "@/store/workflowStore";
import { getRunBlocker, type RunBlocker } from "@/store/utils/runGating";

export interface CanRunResult {
  /** True if the Run/Regenerate button for this node should be enabled. */
  canRun: boolean;
  /** Friendly tooltip — empty string when canRun is true. */
  blockedReason: string;
  /** Raw blocker details (for callers that want them). */
  blocker: RunBlocker | null;
  /** True when *this specific node* is currently executing — use for the
   *  "Running..." button label and the BaseNode executing border, NOT
   *  the global `isRunning` flag (which lights up unrelated nodes). */
  isExecuting: boolean;
}

/**
 * Per-node "is this node free to run right now?" selector.
 *
 * Returns canRun=false when:
 *   - this node itself is currently executing
 *   - any transitive upstream dependency is currently executing
 * Returns canRun=true when this node is independent of all in-flight work,
 * which is the whole point — you can Run unrelated nodes in parallel.
 *
 * Use in place of `useWorkflowStore(s => s.isRunning)` for per-node Run
 * gating. Keep `isRunning` only for whole-workflow gating (the FloatingActionBar
 * Run-Workflow button, etc.).
 */
export function useCanRun(nodeId: string): CanRunResult {
  return useWorkflowStore((state) => {
    const isExecuting = state.currentNodeIds.includes(nodeId);
    const blocker = getRunBlocker(nodeId, state.currentNodeIds, state.nodes, state.edges);
    if (!blocker) {
      return { canRun: true, blockedReason: "", blocker: null, isExecuting };
    }
    const reason = blocker.kind === "self"
      ? "Already running"
      : `Waiting on ${blocker.type ?? "an upstream node"}`;
    return { canRun: false, blockedReason: reason, blocker, isExecuting };
  });
}
