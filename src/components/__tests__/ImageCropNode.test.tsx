import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { ImageCropNode } from "@/components/nodes/ImageCropNode";
import { makeNodeProps } from "@/test/nodeProps";
import type { ImageCropNodeData, WorkflowEdge } from "@/types";

/**
 * The bug this pins:
 *
 * `imageInput.image` is a lazily-hydrated field. On workflow open it is null,
 * the input node paints its thumb — so it looks perfectly loaded — and the
 * full-res sits on disk behind `imageRef`. `getSourceOutput` returns that null,
 * so a crop node wired to it received nothing and sat empty forever: the only
 * thing that hydrated the upstream was the crop's own Edit button.
 *
 * It presented as size-dependent, which it is not. An image dragged in during
 * the session is still inline and works; the same picture reopened from the
 * saved workflow is lazy and does not. Large images were simply the ones that
 * had been in the project long enough to be saved.
 */

const mockUpdateNodeData = vi.fn();
const mockLoadNodeFullResInputs = vi.fn();
const mockOpenModal = vi.fn();

let edges: WorkflowEdge[] = [];

vi.mock("@/store/imageCropStore", () => ({
  useImageCropStore: (selector?: (s: unknown) => unknown) => {
    const state = { openModal: mockOpenModal };
    return selector ? selector(state) : state;
  },
}));

// The node resolves its upstream through getConnectedInputsPure; the point of
// these tests is the null case, so it always yields no image.
vi.mock("@/store/utils/connectedInputs", () => ({
  getConnectedInputsPure: () => ({
    images: [], videos: [], audio: [], model3d: null, text: null, dynamicInputs: {}, easeCurve: null,
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

function cropProps(data: Partial<ImageCropNodeData>) {
  return makeNodeProps({
    id: "imageCrop-1",
    type: "imageCrop" as const,
    selected: false,
    data: {
      sourceImage: null,
      outputImage: null,
      cropRegion: null,
      cropMetadata: null,
      ...data,
    } as ImageCropNodeData,
  });
}

function renderCrop(data: Partial<ImageCropNodeData>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<Wrapper><ImageCropNode {...(cropProps(data) as any)} /></Wrapper>);
}

describe("ImageCropNode — unhydrated upstream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edges = [];
  });

  it("asks for hydration when an edge is connected but the source is still null", () => {
    edges = [{ id: "e1", source: "imageInput-1", sourceHandle: "image", target: "imageCrop-1", targetHandle: "image" } as WorkflowEdge];
    renderCrop({ sourceImage: null });
    expect(mockLoadNodeFullResInputs).toHaveBeenCalledWith("imageCrop-1");
  });

  it("does NOT clear a committed output while the upstream is merely unhydrated", () => {
    // The saved crop is good; the input just has not loaded back yet. Clearing
    // here threw away real work on every open.
    edges = [{ id: "e1", source: "imageInput-1", sourceHandle: "image", target: "imageCrop-1", targetHandle: "image" } as WorkflowEdge];
    renderCrop({ sourceImage: null, outputImage: "data:image/png;base64,AAAA", cropMetadata: '{"v":1}' });
    const cleared = mockUpdateNodeData.mock.calls.some(
      ([, patch]) => patch && "outputImage" in patch && patch.outputImage === null,
    );
    expect(cleared).toBe(false);
  });

  it("clears the output when there is genuinely no incoming edge", () => {
    edges = [];
    renderCrop({ sourceImage: null, outputImage: "data:image/png;base64,AAAA" });
    expect(mockLoadNodeFullResInputs).not.toHaveBeenCalled();
    const cleared = mockUpdateNodeData.mock.calls.some(
      ([, patch]) => patch && patch.outputImage === null,
    );
    expect(cleared).toBe(true);
  });

  it("requests hydration once per wiring, so a failed load is not a request loop", () => {
    edges = [{ id: "e1", source: "imageInput-1", sourceHandle: "image", target: "imageCrop-1", targetHandle: "image" } as WorkflowEdge];
    const { rerender } = renderCrop({ sourceImage: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = cropProps({ sourceImage: null }) as any;
    rerender(<Wrapper><ImageCropNode {...p} /></Wrapper>);
    rerender(<Wrapper><ImageCropNode {...p} /></Wrapper>);
    expect(mockLoadNodeFullResInputs).toHaveBeenCalledTimes(1);
  });
});
