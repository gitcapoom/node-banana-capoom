import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { CubemapFacesNode } from "@/components/nodes/CubemapFacesNode";
import { makeNodeProps } from "@/test/nodeProps";
import type { CubemapFacesNodeData, WorkflowEdge } from "@/types";

/**
 * The bug this pins, and why this node was the worst case of it.
 *
 * `cubemapFaces` is the one node whose OUTPUTS are hydrated eagerly on open
 * (imageStorage's `cubemapFaces` case loads all eight refs) while its UPSTREAM
 * is lazy. So on every open the six face images were present and correct, the
 * incoming cross read as null purely because `imageInput.image` had not loaded
 * back yet, and both effects treated that null as "disconnected" and wiped all
 * six outputs — taking six downstream chains dark at once, before the user had
 * touched anything.
 */

const mockUpdateNodeData = vi.fn();
const mockLoadNodeFullResInputs = vi.fn();

let edges: WorkflowEdge[] = [];
let nodes: unknown[] = [];

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      nodes,
      edges,
      dimmedNodeIds: new Set<string>(),
      updateNodeData: mockUpdateNodeData,
      loadNodeFullResInputs: mockLoadNodeFullResInputs,
      // BaseNode renders inside this component and reads its own slice.
      currentNodeIds: [] as string[],
      setHoveredNodeId: vi.fn(),
      groups: {},
      getNodesWithComments: vi.fn(() => []),
      markCommentViewed: vi.fn(),
      setNavigationTarget: vi.fn(),
      getConnectedInputs: vi.fn(() => ({ images: [], text: null, dynamicInputs: {} })),
    };
    return selector ? selector(state) : state;
  },
}));

function Wrapper({ children }: { children: ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

const SIX_FACES = {
  outputUp: "data:image/png;base64,UP",
  outputDown: "data:image/png;base64,DOWN",
  outputLeft: "data:image/png;base64,LEFT",
  outputRight: "data:image/png;base64,RIGHT",
  outputFront: "data:image/png;base64,FRONT",
  outputBack: "data:image/png;base64,BACK",
};

function renderFaces(data: Partial<CubemapFacesNodeData>) {
  const props = makeNodeProps({
    id: "cubemapFaces-1",
    type: "cubemapFaces" as const,
    selected: false,
    data: {
      mode: "split",
      outputSize: 1024,
      sourceImage: null,
      outputUp: null, outputDown: null, outputLeft: null,
      outputRight: null, outputFront: null, outputBack: null,
      outputCross: null,
      ...data,
    } as CubemapFacesNodeData,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<Wrapper><CubemapFacesNode {...(props as any)} /></Wrapper>);
}

/** Every field this node wrote null to, across all updateNodeData calls. */
function nulledFields(): string[] {
  const out: string[] = [];
  for (const [, patch] of mockUpdateNodeData.mock.calls) {
    if (!patch) continue;
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (v === null) out.push(k);
    }
  }
  return out;
}

describe("CubemapFacesNode — unhydrated upstream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edges = [];
    nodes = [];
  });

  it("SPLIT: keeps its six committed faces while the upstream is merely unhydrated", () => {
    edges = [{ id: "e1", source: "imageInput-1", sourceHandle: "image", target: "cubemapFaces-1", targetHandle: "image" } as WorkflowEdge];
    renderFaces({ mode: "split", sourceImage: "data:image/png;base64,CROSS", ...SIX_FACES });
    expect(nulledFields()).toEqual([]);
  });

  it("SPLIT: does not mirror the lazy null over a stored sourceImage", () => {
    edges = [{ id: "e1", source: "imageInput-1", sourceHandle: "image", target: "cubemapFaces-1", targetHandle: "image" } as WorkflowEdge];
    renderFaces({ mode: "split", sourceImage: "data:image/png;base64,CROSS", ...SIX_FACES });
    expect(nulledFields()).not.toContain("sourceImage");
  });

  it("SPLIT: still clears the six faces when there is genuinely no incoming edge", () => {
    edges = [];
    renderFaces({ mode: "split", sourceImage: null, ...SIX_FACES });
    expect(nulledFields()).toEqual(
      expect.arrayContaining(["outputUp", "outputDown", "outputLeft", "outputRight", "outputFront", "outputBack"]),
    );
  });

  it("COMBINE: keeps the committed cross while six face edges are all still unhydrated", () => {
    edges = (["up", "down", "left", "right", "front", "back"] as const).map((f) => ({
      id: `e-${f}`, source: `src-${f}`, sourceHandle: "image", target: "cubemapFaces-1", targetHandle: f,
    })) as WorkflowEdge[];
    renderFaces({ mode: "combine", outputCross: "data:image/png;base64,CROSS" });
    expect(nulledFields()).not.toContain("outputCross");
  });

  it("COMBINE: still clears the cross when no face is wired at all", () => {
    edges = [];
    renderFaces({ mode: "combine", outputCross: "data:image/png;base64,CROSS" });
    expect(nulledFields()).toContain("outputCross");
  });

  it("does NOT pull the upstream back when its own outputs are already committed", () => {
    // The six faces come off disk eagerly; re-splitting a 4096² cross to
    // reproduce images it already holds is pure waste. The size/mode buttons ask
    // for hydration instead, because those are the actions that need new pixels.
    edges = [{ id: "e1", source: "imageInput-1", sourceHandle: "image", target: "cubemapFaces-1", targetHandle: "image" } as WorkflowEdge];
    renderFaces({ mode: "split", sourceImage: "data:image/png;base64,CROSS", ...SIX_FACES });
    expect(mockLoadNodeFullResInputs).not.toHaveBeenCalled();
  });

  it("asks for hydration when it is wired and has no committed faces to fall back on", () => {
    edges = [{ id: "e1", source: "imageInput-1", sourceHandle: "image", target: "cubemapFaces-1", targetHandle: "image" } as WorkflowEdge];
    renderFaces({ mode: "split", sourceImage: null });
    expect(mockLoadNodeFullResInputs).toHaveBeenCalledWith("cubemapFaces-1");
  });
});
