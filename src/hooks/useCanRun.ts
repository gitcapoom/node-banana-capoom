"use client";

import { useShallow } from "zustand/react/shallow";
import { useWorkflowStore } from "@/store/workflowStore";
import { getRunBlocker } from "@/store/utils/runGating";

export interface CanRunResult {
  /** True if the Run/Regenerate button for this node should be enabled. */
  canRun: boolean;
  /** Friendly tooltip — empty string when canRun is true. */
  blockedReason: string;
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
 * Wrapped in `useShallow` so React sees a stable snapshot when the
 * underlying booleans / strings haven't changed. Without it, the
 * selector would return a fresh object reference on every store update
 * and React would loop with "Maximum update depth exceeded".
 *
 * Use in place of `useWorkflowStore(s => s.isRunning)` for per-node Run
 * gating. Keep `isRunning` only for whole-workflow gating (FloatingActionBar
 * Run-Workflow button, etc.).
 */
export function useCanRun(nodeId: string): CanRunResult {
  return useWorkflowStore(
    useShallow((state) => {
      const isExecuting = state.currentNodeIds.includes(nodeId);
      const blocker = getRunBlocker(nodeId, state.currentNodeIds, state.nodes, state.edges);
      if (!blocker) {
        return { canRun: true, blockedReason: "", isExecuting };
      }
      const blockedReason = blocker.kind === "self"
        ? "Already running"
        : `Waiting on ${blocker.type ?? "an upstream node"}`;
      return { canRun: false, blockedReason, isExecuting };
    }),
  );
}
