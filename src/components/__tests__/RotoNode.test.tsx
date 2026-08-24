import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { RotoNode } from "@/components/nodes/RotoNode";
import { makeNodeProps } from "@/test/nodeProps";
import type { RotoNodeData, WorkflowEdge } from "@/types";

/**
 * The same dead end MaskPainterNode was fixed for, in its sibling.
 *
 * `roto.sourceImage` is ref-backed and lazily unloaded on open (imageStorage's
 * `roto` case), and `outputMask` only exists once shapes have been drawn. So a
 * roto node that has never been drawn on falls through to a placeholder with no
 * button and no double-click handler — and the modal is the only way to author
 * shapes. Nothing in the node asked for the pixels either, so it stayed there.
 */

const mockUpdateNodeData = vi.fn();
const mockLoadNodeFullResInputs = vi.fn();
const mockOpenModal = vi.fn();
const mockGetConnectedInputs = vi.fn(() => ({ images: [] as string[], text: null, dynamicInputs: {} }));
const mockEnsureFullRes = vi.fn(async () => {});

let edges: WorkflowEdge[] = [];

vi.mock("@/store/rotoStore", () => ({
  useRotoStore: (selector?: (s: unknown) => unknown) => {
    const state = { openModal: mockOpenModal };
    return selector ? selector(state) : state;
  },
}));

vi.mock("@/store/execution/hydrateForRun", () => ({
  ensureFullResForNodes: (...args: unknown[]) => mockEnsureFullRes(...(args as [])),
}));

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      nodes: [],
      edges,
      dimmedNodeIds: new Set<string>(),
      saveDirectoryPath: "/proj",
      updateNodeData: mockUpdateNodeData,
      loadNodeFullResInputs: mockLoadNodeFullResInputs,
      getConnectedInputs: mockGetConnectedInputs,
      currentNodeIds: [] as string[],
      setHoveredNodeId: vi.fn(),
      groups: {},
      getNodesWithComments: vi.fn(() => []),
      markCommentViewed: vi.fn(),
      setNavigationTarget: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

function Wrapper({ children }: { children: ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

function renderRoto(data: Partial<RotoNodeData> = {}) {
  const props = makeNodeProps({
    id: "roto-1",
    type: "roto" as const,
    selected: false,
    data: {
      sourceImage: null,
      outputMask: null,
      shapes: [],
      invert: false,
      ...data,
    } as unknown as RotoNodeData,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<Wrapper><RotoNode {...(props as any)} /></Wrapper>);
}

const IMAGE_EDGE = {
  id: "e1", source: "imageInput-1", sourceHandle: "image",
  target: "roto-1", targetHandle: "image",
} as WorkflowEdge;

describe("RotoNode — unhydrated source, nothing drawn yet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edges = [];
    mockGetConnectedInputs.mockReturnValue({ images: [], text: null, dynamicInputs: {} });
  });

  it("offers a way into the editor when wired but the source is still on disk", () => {
    edges = [IMAGE_EDGE];
    renderRoto();
    expect(screen.getByRole("button", { name: "Draw roto" })).toBeTruthy();
  });

  it("asks for the source to be hydrated instead of waiting for the editor", () => {
    edges = [IMAGE_EDGE];
    renderRoto();
    expect(mockLoadNodeFullResInputs).toHaveBeenCalledWith("roto-1");
  });

  it("opens the editor with the image the upstream publishes once it lands", async () => {
    edges = [IMAGE_EDGE];
    mockEnsureFullRes.mockImplementation(async () => {
      mockGetConnectedInputs.mockReturnValue({
        images: ["data:image/png;base64,UPSTREAM"], text: null, dynamicInputs: {},
      });
    });
    renderRoto();
    fireEvent.click(screen.getByRole("button", { name: "Draw roto" }));
    await vi.waitFor(() =>
      expect(mockOpenModal).toHaveBeenCalledWith("roto-1", "data:image/png;base64,UPSTREAM", []),
    );
  });

  it("still says 'Connect an image' when nothing is wired", () => {
    edges = [];
    renderRoto();
    expect(screen.getByText("Connect an image")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Draw roto" })).toBeNull();
    expect(mockLoadNodeFullResInputs).not.toHaveBeenCalled();
  });
});
