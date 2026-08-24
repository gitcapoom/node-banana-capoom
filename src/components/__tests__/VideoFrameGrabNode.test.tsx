import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { VideoFrameGrabNode } from "@/components/nodes/VideoFrameGrabNode";
import { makeNodeProps } from "@/test/nodeProps";
import type { VideoFrameGrabNodeData, WorkflowEdge } from "@/types";

/**
 * The bug this pins, and how it differs from the image nodes.
 *
 * `generateVideo.outputVideo` and `videoInput.videoFile` are BOTH set to null on
 * open with only a ref left behind ("Don't hydrate full video — loaded
 * on-demand in overlay", imageStorage). This node gated its Extract button on
 * that value, so the button was permanently disabled on a reopened workflow.
 *
 * Unlike the image nodes, Running repaired nothing: RUN_FULLRES_FIELDS contains
 * no video field at all, so the run pre-pass never touched video — the executor
 * read `inputs.videos` as empty and raised "Connect a video input to extract a
 * frame" on a graph that is visibly wired. The executor now hydrates its own
 * direct producer (`ensureVideoInputs`), so the button only has to know that an
 * edge exists.
 */

const mockUpdateNodeData = vi.fn();
const mockRegenerateNode = vi.fn();

let edges: WorkflowEdge[] = [];

vi.mock("@/hooks/useCanRun", () => ({
  useCanRun: () => ({ canRun: true, isExecuting: false }),
}));

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      nodes: [],
      edges,
      dimmedNodeIds: new Set<string>(),
      updateNodeData: mockUpdateNodeData,
      regenerateNode: mockRegenerateNode,
      loadNodeFullResInputs: vi.fn(),
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

function renderGrab(data: Partial<VideoFrameGrabNodeData> = {}) {
  const props = makeNodeProps({
    id: "videoFrameGrab-1",
    type: "videoFrameGrab" as const,
    selected: false,
    data: {
      framePosition: "first",
      outputImage: null,
      status: "idle",
      error: null,
      ...data,
    } as VideoFrameGrabNodeData,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<Wrapper><VideoFrameGrabNode {...(props as any)} /></Wrapper>);
}

const VIDEO_EDGE = {
  id: "e1", source: "generateVideo-1", sourceHandle: "video",
  target: "videoFrameGrab-1", targetHandle: "video",
} as WorkflowEdge;

describe("VideoFrameGrabNode — unhydrated upstream video", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edges = [];
  });

  it("enables Extract when a video edge exists but the clip is still on disk", () => {
    edges = [VIDEO_EDGE];
    renderGrab();
    expect(screen.getByRole("button", { name: "Extract Frame" })).not.toBeDisabled();
  });

  it("shows the First/Last frame toggle for a wired-but-unhydrated video", () => {
    edges = [VIDEO_EDGE];
    renderGrab();
    expect(screen.getByRole("button", { name: "First" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Last" })).toBeTruthy();
  });

  it("still disables Extract when nothing is wired", () => {
    edges = [];
    renderGrab();
    expect(screen.getByRole("button", { name: "Extract Frame" })).toBeDisabled();
  });
});
