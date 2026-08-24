import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useIncomingEdgeKey, useHydrateUnresolvedInputs } from "@/hooks/useUpstreamHydration";
import type { WorkflowEdge } from "@/types";

/**
 * The guard that fifteen nodes were each re-implementing (or getting wrong).
 *
 * Displayed image fields are lazily hydrated: on open they are null while the
 * full-res sits on disk behind a ref. "No edge" and "edge whose value has not
 * loaded" are therefore the same observation, and every consumer has to tell
 * them apart before it decides whether to clear its own committed output.
 */

const mockLoadNodeFullResInputs = vi.fn();

let edges: WorkflowEdge[] = [];

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (s: unknown) => unknown) => {
    const state = { edges, loadNodeFullResInputs: mockLoadNodeFullResInputs };
    return selector ? selector(state) : state;
  },
}));

function edge(source: string, target: string, targetHandle = "image"): WorkflowEdge {
  return { id: `${source}->${target}:${targetHandle}`, source, sourceHandle: "image", target, targetHandle } as WorkflowEdge;
}

describe("useIncomingEdgeKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edges = [];
  });

  it("is empty when nothing is wired", () => {
    const { result } = renderHook(() => useIncomingEdgeKey("n1"));
    expect(result.current).toBe("");
  });

  it("is non-empty for an incoming edge even when the upstream value is null", () => {
    edges = [edge("imageInput-1", "n1")];
    const { result } = renderHook(() => useIncomingEdgeKey("n1"));
    expect(result.current).not.toBe("");
  });

  it("ignores edges that target OTHER nodes", () => {
    edges = [edge("imageInput-1", "someone-else")];
    const { result } = renderHook(() => useIncomingEdgeKey("n1"));
    expect(result.current).toBe("");
  });

  it("changes when the wiring changes, so a rewire is not mistaken for the old one", () => {
    edges = [edge("a", "n1")];
    const { result, rerender } = renderHook(() => useIncomingEdgeKey("n1"));
    const before = result.current;
    edges = [edge("b", "n1")];
    rerender();
    expect(result.current).not.toBe(before);
  });

  it("scopes to one target handle when asked", () => {
    edges = [edge("a", "n1", "image-bg"), edge("b", "n1", "image")];
    const { result } = renderHook(() => useIncomingEdgeKey("n1", "image-bg"));
    expect(result.current).toContain("a|");
    expect(result.current).not.toContain("b|");
  });
});

describe("useHydrateUnresolvedInputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edges = [];
  });

  it("requests hydration when wired but unresolved", () => {
    renderHook(() => useHydrateUnresolvedInputs("n1", "a|image|image", false));
    expect(mockLoadNodeFullResInputs).toHaveBeenCalledWith("n1");
  });

  it("does not request when nothing is wired", () => {
    renderHook(() => useHydrateUnresolvedInputs("n1", "", false));
    expect(mockLoadNodeFullResInputs).not.toHaveBeenCalled();
  });

  it("does not request when the value already resolved", () => {
    renderHook(() => useHydrateUnresolvedInputs("n1", "a|image|image", true));
    expect(mockLoadNodeFullResInputs).not.toHaveBeenCalled();
  });

  it("requests once per wiring, so a load that FAILS is not a request loop", () => {
    const { rerender } = renderHook(
      ({ key }: { key: string }) => useHydrateUnresolvedInputs("n1", key, false),
      { initialProps: { key: "a|image|image" } },
    );
    // The load never resolves the value — exactly the failure case.
    rerender({ key: "a|image|image" });
    rerender({ key: "a|image|image" });
    expect(mockLoadNodeFullResInputs).toHaveBeenCalledTimes(1);
  });

  it("requests again after a rewire", () => {
    const { rerender } = renderHook(
      ({ key }: { key: string }) => useHydrateUnresolvedInputs("n1", key, false),
      { initialProps: { key: "a|image|image" } },
    );
    rerender({ key: "b|image|image" });
    expect(mockLoadNodeFullResInputs).toHaveBeenCalledTimes(2);
  });

  it("releases the guard once resolved, so a value that later disappears re-requests", () => {
    const { rerender } = renderHook(
      ({ resolved }: { resolved: boolean }) => useHydrateUnresolvedInputs("n1", "a|image|image", resolved),
      { initialProps: { resolved: false } },
    );
    expect(mockLoadNodeFullResInputs).toHaveBeenCalledTimes(1);
    rerender({ resolved: true });
    rerender({ resolved: false });
    expect(mockLoadNodeFullResInputs).toHaveBeenCalledTimes(2);
  });
});
