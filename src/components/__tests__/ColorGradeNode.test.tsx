import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { ColorGradeNode } from "@/components/nodes/ColorGradeNode";
import { makeNodeProps } from "@/test/nodeProps";
import type { ColorGradeNodeData, WorkflowEdge } from "@/types";

/**
 * This covers the SHARED half of the colour-node fix: `useColorNode`'s commit
 * effect used to write `outputImage: null` whenever `sourceImage` was falsy.
 * That is the lazy on-open state of every wired grade in a saved workflow, so a
 * remount (React Flow unmounts nodes scrolled out of view) with an output a
 * consumer had already hydrated threw the graded frame away — and every
 * downstream consumer went dark with it. hsvCorrect and contrastAdjust run
 * through the same hook.
 *
 * The store's own outputImage is read via getState() in that branch, so the mock
 * below has to expose one.
 */

const mockUpdateNodeData = vi.fn();
const mockLoadNodeFullResInputs = vi.fn();

let edges: WorkflowEdge[] = [];
let storeNodes: Array<{ id: string; type: string; data: Record<string, unknown> }> = [];

const makeState = () => ({
  nodes: storeNodes,
  edges,
  dimmedNodeIds: new Set<string>(),
  updateNodeData: mockUpdateNodeData,
  loadNodeFullResInputs: mockLoadNodeFullResInputs,
  currentNodeIds: [] as string[],
  setHoveredNodeId: vi.fn(),
  groups: {},
  getNodesWithComments: vi.fn(() => []),
  markCommentViewed: vi.fn(),
  setNavigationTarget: vi.fn(),
  getConnectedInputs: vi.fn(() => ({ images: [], text: null, dynamicInputs: {} })),
});

vi.mock("@/store/workflowStore", () => {
  const useWorkflowStore = (selector?: (s: unknown) => unknown) => {
    const state = makeState();
    return selector ? selector(state) : state;
  };
  useWorkflowStore.getState = () => makeState();
  return { useWorkflowStore };
});

function Wrapper({ children }: { children: ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

function renderGrade(data: Partial<ColorGradeNodeData> = {}) {
  const props = makeNodeProps({
    id: "colorGrade-1",
    type: "colorGrade" as const,
    selected: false,
    data: {
      sourceImage: null,
      outputImage: null,
      blackpoint: 0, whitepoint: 1, lift: 0,
      gain: 1, multiply: 1, offset: 0, gamma: 1,
      ...data,
    } as unknown as ColorGradeNodeData,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<Wrapper><ColorGradeNode {...(props as any)} /></Wrapper>);
}

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

const IMAGE_EDGE = {
  id: "e1", source: "imageInput-1", sourceHandle: "image",
  target: "colorGrade-1", targetHandle: "image",
} as WorkflowEdge;

describe("ColorGradeNode — unhydrated upstream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edges = [];
    storeNodes = [];
  });

  it("asks for hydration instead of sitting on its thumb until the editor opens", () => {
    edges = [IMAGE_EDGE];
    storeNodes = [{ id: "imageInput-1", type: "imageInput", data: { image: null, imageRef: "img-a" } }];
    renderGrade();
    expect(mockLoadNodeFullResInputs).toHaveBeenCalledWith("colorGrade-1");
  });

  it("does not clear a committed grade while the upstream is merely unhydrated", () => {
    edges = [IMAGE_EDGE];
    storeNodes = [
      { id: "imageInput-1", type: "imageInput", data: { image: null, imageRef: "img-a" } },
      { id: "colorGrade-1", type: "colorGrade", data: { outputImage: "data:image/png;base64,GRADED" } },
    ];
    renderGrade({ sourceImage: null, outputImage: "data:image/png;base64,GRADED" });
    expect(nulledFields()).not.toContain("outputImage");
  });

  it("still clears when there is genuinely no incoming edge", () => {
    edges = [];
    storeNodes = [
      { id: "colorGrade-1", type: "colorGrade", data: { outputImage: "data:image/png;base64,GRADED" } },
    ];
    renderGrade({ sourceImage: null, outputImage: "data:image/png;base64,GRADED" });
    expect(nulledFields()).toContain("outputImage");
    expect(mockLoadNodeFullResInputs).not.toHaveBeenCalled();
  });
});
