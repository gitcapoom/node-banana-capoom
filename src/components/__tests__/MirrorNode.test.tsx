import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { MirrorNode } from "@/components/nodes/MirrorNode";
import { makeNodeProps } from "@/test/nodeProps";
import type { MirrorNodeData, WorkflowEdge } from "@/types";

/**
 * MirrorNode stands in for the whole "looks empty until you Run" tier —
 * reformat, cubemapEquirect, panoShift and colorGrade all have the same two
 * effects with the same two mistakes: mirror the lazy null over a stored
 * `sourceImage`, then read that null as "disconnected" and clear a committed
 * `outputImage`. The second one destroys work: a consumer that hydrated this
 * node's output mid-session loses it the next time the node remounts (React
 * Flow unmounts nodes scrolled out of view).
 */

const mockUpdateNodeData = vi.fn();
const mockLoadNodeFullResInputs = vi.fn();

let edges: WorkflowEdge[] = [];
let upstreamImages: string[] = [];

vi.mock("@/store/utils/connectedInputs", () => ({
  getConnectedInputsPure: () => ({
    images: upstreamImages, videos: [], audio: [], model3d: null, text: null, dynamicInputs: {}, easeCurve: null,
  }),
}));

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      nodes: [],
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
    };
    return selector ? selector(state) : state;
  },
}));

function Wrapper({ children }: { children: ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

function renderMirror(data: Partial<MirrorNodeData> = {}) {
  const props = makeNodeProps({
    id: "mirror-1",
    type: "mirror" as const,
    selected: false,
    data: {
      sourceImage: null,
      outputImage: null,
      flipHorizontal: true,
      flipVertical: false,
      ...data,
    } as MirrorNodeData,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<Wrapper><MirrorNode {...(props as any)} /></Wrapper>);
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
  target: "mirror-1", targetHandle: "image",
} as WorkflowEdge;

describe("MirrorNode — unhydrated upstream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edges = [];
    upstreamImages = [];
  });

  it("asks for hydration instead of sitting empty until a Run", () => {
    edges = [IMAGE_EDGE];
    renderMirror();
    expect(mockLoadNodeFullResInputs).toHaveBeenCalledWith("mirror-1");
  });

  it("does not clear a committed output while the upstream is merely unhydrated", () => {
    edges = [IMAGE_EDGE];
    renderMirror({ sourceImage: null, outputImage: "data:image/png;base64,FLIPPED" });
    expect(nulledFields()).not.toContain("outputImage");
  });

  it("does not mirror the lazy null over a source a consumer just hydrated", () => {
    edges = [IMAGE_EDGE];
    renderMirror({ sourceImage: "data:image/png;base64,SRC", outputImage: "data:image/png;base64,FLIPPED" });
    expect(nulledFields()).not.toContain("sourceImage");
  });

  it("still clears when there is genuinely no incoming edge", () => {
    edges = [];
    renderMirror({ sourceImage: "data:image/png;base64,SRC", outputImage: "data:image/png;base64,FLIPPED" });
    expect(nulledFields()).toEqual(expect.arrayContaining(["sourceImage"]));
    expect(mockLoadNodeFullResInputs).not.toHaveBeenCalled();
  });
});
