/**
 * Per-node cancellation.
 *
 * Before this existed, `regenerateNode` built its execution context with NO
 * signal at all, so a generation started from a node's own Run button could not
 * be stopped by anything short of a page reload — the global Stop only reached
 * runs started by `executeWorkflow`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import { useWorkflowStore } from "../workflowStore";
import type { WorkflowNode } from "@/types";

vi.mock("@/components/Toast", () => ({
  useToast: { getState: () => ({ show: vi.fn() }) },
}));

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
  saveLogSession: vi.fn(),
}));

function genNode(id: string): WorkflowNode {
  return {
    id,
    type: "nanoBanana",
    position: { x: 0, y: 0 },
    data: { status: "loading", error: null },
  } as WorkflowNode;
}

/** Put a node in the in-flight state the UI keys off, with a live controller. */
function markInFlight(node: WorkflowNode): AbortController {
  const controller = new AbortController();
  const s = useWorkflowStore.getState();
  s._nodeAbortControllers.set(node.id, controller);
  useWorkflowStore.setState({
    nodes: [...useWorkflowStore.getState().nodes, node],
    currentNodeIds: [...useWorkflowStore.getState().currentNodeIds, node.id],
    isRunning: true,
  });
  return controller;
}

beforeEach(() => {
  useWorkflowStore.getState()._nodeAbortControllers.clear();
  useWorkflowStore.setState({
    nodes: [],
    edges: [],
    currentNodeIds: [],
    isRunning: false,
    _abortController: null,
  });
});

describe("cancelNode", () => {
  it("aborts that node's in-flight request", () => {
    const node = genNode("gen-1");
    const controller = markInFlight(node);

    act(() => useWorkflowStore.getState().cancelNode("gen-1"));

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("user-cancelled");
  });

  it("leaves the node idle rather than errored", () => {
    // A cancel is a choice, not a failure — painting the node red for it is
    // noise, and an error status also blocks the next Run in some nodes.
    const node = genNode("gen-1");
    markInFlight(node);

    act(() => useWorkflowStore.getState().cancelNode("gen-1"));

    const after = useWorkflowStore.getState().nodes.find((n) => n.id === "gen-1");
    expect((after?.data as { status?: string }).status).toBe("idle");
    expect((after?.data as { error?: string | null }).error).toBeNull();
  });

  it("cancels only the requested node", () => {
    const a = markInFlight(genNode("gen-a"));
    const b = markInFlight(genNode("gen-b"));

    act(() => useWorkflowStore.getState().cancelNode("gen-a"));

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });

  it("is a no-op for a node that is not running", () => {
    // The button only renders while in flight, but a stale click (or a cancel
    // racing the run's own completion) must not throw.
    expect(() =>
      act(() => useWorkflowStore.getState().cancelNode("never-started")),
    ).not.toThrow();
  });
});

describe("stopWorkflow", () => {
  it("also aborts per-node controllers", () => {
    // Regression: nodes started by regenerateNode register their own
    // controller and are not covered by the run-level one, so a global Stop
    // used to leave them polling the provider until the request finished.
    const a = markInFlight(genNode("gen-a"));
    const b = markInFlight(genNode("gen-b"));

    act(() => useWorkflowStore.getState().stopWorkflow());

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(useWorkflowStore.getState()._nodeAbortControllers.size).toBe(0);
    expect(useWorkflowStore.getState().isRunning).toBe(false);
  });
});
