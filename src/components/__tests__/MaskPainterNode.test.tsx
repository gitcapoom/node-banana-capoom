import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { MaskPainterNode } from "@/components/nodes/MaskPainterNode";
import { makeNodeProps } from "@/test/nodeProps";
import type { MaskPainterNodeData, WorkflowEdge } from "@/types";

/**
 * The bug this pins:
 *
 * With no strokes painted yet AND a source that is still lazily unloaded, this
 * node fell through to a placeholder with no button and no double-click handler
 * — and there is no `maskPainter` case in the canvas expand modals either. The
 * full-screen editor is the ONLY way to author a mask, so that placeholder was
 * a dead end, not a cosmetic blank: a freshly connected mask painter could not
 * be opened at all until something else happened to hydrate its upstream.
 */

const mockUpdateNodeData = vi.fn();
const mockLoadNodeFullResInputs = vi.fn();
const mockOpenModal = vi.fn();
const mockGetConnectedInputs = vi.fn(() => ({ images: [] as string[], text: null, dynamicInputs: {} }));

let edges: WorkflowEdge[] = [];

vi.mock("@/store/maskPainterStore", () => ({
  useMaskPainterStore: (selector?: (s: unknown) => unknown) => {
    const state = { openModal: mockOpenModal };
    return selector ? selector(state) : state;
  },
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

function renderMask(data: Partial<MaskPainterNodeData> = {}) {
  const props = makeNodeProps({
    id: "maskPainter-1",
    type: "maskPainter" as const,
    selected: false,
    data: {
      sourceImage: null,
      outputMask: null,
      strokes: [],
      brushSize: 30,
      blurRadius: 0,
      invert: false,
      ...data,
    } as unknown as MaskPainterNodeData,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<Wrapper><MaskPainterNode {...(props as any)} /></Wrapper>);
}

const IMAGE_EDGE = {
  id: "e1", source: "imageInput-1", sourceHandle: "image",
  target: "maskPainter-1", targetHandle: "image",
} as WorkflowEdge;

describe("MaskPainterNode — unhydrated source, nothing painted yet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edges = [];
    mockGetConnectedInputs.mockReturnValue({ images: [], text: null, dynamicInputs: {} });
  });

  it("offers a way into the editor when wired but the source is still on disk", () => {
    edges = [IMAGE_EDGE];
    renderMask();
    expect(screen.getByRole("button", { name: "Paint mask" })).toBeTruthy();
  });

  it("asks for the source to be hydrated instead of waiting for the editor", () => {
    edges = [IMAGE_EDGE];
    renderMask();
    expect(mockLoadNodeFullResInputs).toHaveBeenCalledWith("maskPainter-1");
  });

  it("opens the editor with the image the upstream publishes once it lands", async () => {
    edges = [IMAGE_EDGE];
    // No sourceImage and no sourceImageRef of its own: the mirror effect only
    // ever wrote `sourceImage`, so a never-opened mask painter has nothing on
    // disk under its own name and must read the upstream instead.
    mockLoadNodeFullResInputs.mockImplementation(async () => {
      mockGetConnectedInputs.mockReturnValue({
        images: ["data:image/png;base64,UPSTREAM"], text: null, dynamicInputs: {},
      });
    });
    renderMask();
    fireEvent.click(screen.getByRole("button", { name: "Paint mask" }));
    await vi.waitFor(() =>
      expect(mockOpenModal).toHaveBeenCalledWith("maskPainter-1", "data:image/png;base64,UPSTREAM", []),
    );
  });

  it("still says 'Connect an image' when nothing is wired", () => {
    edges = [];
    renderMask();
    expect(screen.getByText("Connect an image")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Paint mask" })).toBeNull();
  });
});
