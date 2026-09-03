import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { BaseNode } from "@/components/nodes/BaseNode";

/**
 * The Cancel button lives in BaseNode, which wraps every node, so this is the
 * one place its visibility rules are decided:
 *
 *   - only while THAT node is in flight (currentNodeIds), and
 *   - only for node types that hand work to a remote API.
 *
 * Getting either wrong is silently bad: a button on an idle node does nothing,
 * and a button on a local processor implies an interruption that isn't there.
 */

const mockCancelNode = vi.fn();
let currentNodeIds: string[] = [];
let nodeType = "nanoBanana";

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      currentNodeIds,
      setHoveredNodeId: vi.fn(),
      cancelNode: mockCancelNode,
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock("@/store/nodeMediaViewerStore", () => ({
  useNodeMediaViewer: () => ({ open: vi.fn() }),
}));

vi.mock("@/lib/thumbnailSize", () => ({ useThumbnailPending: () => false }));

vi.mock("@/components/WorkflowCanvas", () => ({ isPanningRef: { current: false } }));

// BaseNode reads the node's type through React Flow's indexed lookup rather
// than a store selector (it wraps every node, so a selector would be O(n^2)).
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    useNodesData: (id: string) => ({ id, type: nodeType, data: {} }),
  };
});

function Wrapper({ children }: { children: ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

function renderNode(id = "gen-1") {
  return render(
    <Wrapper>
      <BaseNode id={id}>
        <div>content</div>
      </BaseNode>
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  currentNodeIds = [];
  nodeType = "nanoBanana";
});

describe("BaseNode cancel button", () => {
  it("is hidden while the node is idle", () => {
    renderNode();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  it("appears while that node is in flight", () => {
    currentNodeIds = ["gen-1"];
    renderNode();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
  });

  it("does not appear because some OTHER node is running", () => {
    currentNodeIds = ["some-other-node"];
    renderNode();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  it("is hidden on local processors, which have nothing to interrupt", () => {
    currentNodeIds = ["gen-1"];
    nodeType = "imageCrop";
    renderNode();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  it("cancels this node, by id", () => {
    currentNodeIds = ["gen-1"];
    renderNode("gen-1");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mockCancelNode).toHaveBeenCalledWith("gen-1");
  });
});
