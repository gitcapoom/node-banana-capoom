import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { getHandleType } from "@/components/WorkflowCanvas";
import {
  SpzViewerNode,
  buildOverlayHandoff,
  capturedImageCount,
  resolveOverlayInputs,
} from "@/components/nodes/SpzViewerNode";
import { makeNodeProps } from "@/test/nodeProps";
import type { SpzViewerNodeData, WorkflowEdge, WorkflowNode } from "@/types";

describe("spzViewer overlay pins", () => {
  it("types both new pins as image", () => {
    // getHandleType tests includes("image") BEFORE startsWith("text-"), so an id
    // containing "image" is an image pin. Both of these are meant to be.
    expect(getHandleType("image-fg")).toBe("image");
    expect(getHandleType("image-fg_alpha")).toBe("image");
  });
});

describe("buildOverlayHandoff", () => {
  it("packs a foreground and its matte", () => {
    expect(buildOverlayHandoff(["data:image/png;base64,FG"], "data:image/png;base64,A"))
      .toEqual({ fg: "data:image/png;base64,FG", alpha: "data:image/png;base64,A" });
  });

  it("treats a foreground with no matte as opaque", () => {
    expect(buildOverlayHandoff(["data:image/png;base64,FG"], null))
      .toEqual({ fg: "data:image/png;base64,FG", alpha: null });
  });

  it("returns null when no foreground is wired, so a lone matte is ignored", () => {
    expect(buildOverlayHandoff([], "data:image/png;base64,A")).toBeNull();
    expect(buildOverlayHandoff([], null)).toBeNull();
  });
});

describe("capture node spawning", () => {
  it("spawns one node per returned image", () => {
    expect(capturedImageCount({ image: "i", depthImage: null, compositeImage: null })).toBe(1);
    expect(capturedImageCount({ image: "i", depthImage: "d", compositeImage: null })).toBe(2);
    expect(capturedImageCount({ image: "i", depthImage: "d", compositeImage: "c" })).toBe(3);
    expect(capturedImageCount({ image: "i", depthImage: null, compositeImage: "c" })).toBe(2);
  });

  it("counts nothing for a capture with no image", () => {
    expect(capturedImageCount({ image: null, depthImage: null, compositeImage: null })).toBe(0);
  });
});

describe("resolveOverlayInputs — pin resolution off the raw node/edge graph", () => {
  const imageInputNode = (nodeId: string, image: string | null): WorkflowNode =>
    ({ id: nodeId, type: "imageInput", data: { image } }) as unknown as WorkflowNode;

  const edge = (source: string, target: string, targetHandle: string): WorkflowEdge =>
    ({
      id: `${source}->${target}:${targetHandle}`,
      source,
      sourceHandle: "image",
      target,
      targetHandle,
    }) as unknown as WorkflowEdge;

  it("packs the fg pin with no alpha wired", () => {
    const nodes = [imageInputNode("a", "data:image/png;base64,A")];
    const edges = [edge("a", "spz-1", "image-fg")];
    expect(resolveOverlayInputs("spz-1", nodes, edges)).toEqual({ fg: "data:image/png;base64,A", alpha: null });
  });

  it("MINOR 4 — alpha takes the FIRST matching edge, same as fg, not the last", () => {
    // Two edges into image-fg_alpha used to leave the LAST one wired in effect
    // (a plain overwrite on every match), while image-fg already took the
    // FIRST by construction (buildOverlayHandoff reads fgImages[0]) — an
    // inconsistency between two pins on the same node.
    const nodes = [
      imageInputNode("fg", "data:image/png;base64,FG"),
      imageInputNode("a1", "data:image/png;base64,A1"),
      imageInputNode("a2", "data:image/png;base64,A2"),
    ];
    const edges = [
      edge("fg", "spz-1", "image-fg"),
      edge("a1", "spz-1", "image-fg_alpha"),
      edge("a2", "spz-1", "image-fg_alpha"),
    ];
    expect(resolveOverlayInputs("spz-1", nodes, edges)).toEqual({
      fg: "data:image/png;base64,FG",
      alpha: "data:image/png;base64,A1",
    });
  });

  it("returns null when the fg pin is wired but its source is still lazily unhydrated", () => {
    const nodes = [imageInputNode("a", null)];
    const edges = [edge("a", "spz-1", "image-fg")];
    expect(resolveOverlayInputs("spz-1", nodes, edges)).toBeNull();
  });

  it("ignores edges that target a different node", () => {
    const nodes = [imageInputNode("a", "data:image/png;base64,A")];
    const edges = [edge("a", "some-other-node", "image-fg")];
    expect(resolveOverlayInputs("spz-1", nodes, edges)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Component-level regression: CRITICAL 1 from the whole-feature review.
//
// This repo loads full-res images lazily: `hydrateNodeImages` deliberately
// leaves `imageInput.image` (and friends) null on workflow open, keeping only
// an inline thumb (src/utils/imageStorage.ts, src/utils/imageFieldMap.ts).
// `getSourceOutput` returns that null field verbatim. Nothing hydrates
// spzViewer's fg / fg_alpha pins before "Open Viewer" is clicked — this node
// has no Run button and no reactive-hydrate-on-mount hook — so the OLD
// `handleOpenViewer` read the still-null overlay at CLICK time, built no
// handoff, and its own else-branch DELETED any handoff sessionStorage held
// from a previous session. The viewer opened with no plate and no error; it
// only ever worked in the session the image was first loaded, or right after
// a run.
//
// The fix hydrates first (`loadNodeFullResInputs`, "consumer" mode) and THEN
// re-resolves the overlay from a fresh store read — the point of this test is
// that gap specifically: a resolver call made AFTER hydration finishes must
// see real pixels, not the snapshot closed over when the click handler was
// built. Mocking the store is the same pattern ImageCropNode.test.tsx and
// ColorGradeNode.test.tsx use for this exact class of bug.
// ─────────────────────────────────────────────────────────────────────────

const mockUpdateNodeData = vi.fn();
const mockLoadNodeFullResInputs = vi.fn();
const mockGetConnectedInputs = vi.fn(() => ({
  model3d: null as string | null,
  images: [] as string[],
  text: null as string | null,
  dynamicInputs: {} as Record<string, string | string[]>,
}));

let storeEdges: WorkflowEdge[] = [];
let storeNodes: WorkflowNode[] = [];

vi.mock("@/store/workflowStore", () => {
  const makeState = () => ({
    nodes: storeNodes,
    edges: storeEdges,
    dimmedNodeIds: new Set<string>(),
    updateNodeData: mockUpdateNodeData,
    addNode: vi.fn(() => "spawned-node"),
    saveDirectoryPath: null as string | null,
    regenerateNode: vi.fn(),
    loadNodeFullResInputs: mockLoadNodeFullResInputs,
    currentNodeIds: [] as string[],
    setHoveredNodeId: vi.fn(),
    groups: {},
    getNodesWithComments: vi.fn(() => []),
    markCommentViewed: vi.fn(),
    setNavigationTarget: vi.fn(),
    getConnectedInputs: mockGetConnectedInputs,
  });
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

function renderSpzViewer(data: Partial<SpzViewerNodeData> = {}) {
  const props = makeNodeProps({
    id: "spz-1",
    type: "spzViewer" as const,
    selected: false,
    data: {
      spzUrl: null,
      filename: null,
      capturedImage: null,
      capturedDepthImage: null,
      viewerOpen: false,
      ...data,
    } as SpzViewerNodeData,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<Wrapper><SpzViewerNode {...(props as any)} /></Wrapper>);
}

const FG_KEY = "splat-viewer-fg-spz-1";
const HYDRATED_FG = "data:image/png;base64,HYDRATED_FG_PIXELS";
const UNWIRED_EDGE_SOURCE = "imageInput-1";

describe("SpzViewerNode — Open Viewer hydrates before building the handoff", () => {
  let openedWindow: { postMessage: ReturnType<typeof vi.fn>; closed: boolean };

  beforeEach(() => {
    vi.clearAllMocks();
    storeEdges = [];
    storeNodes = [];
    sessionStorage.clear();
    openedWindow = { postMessage: vi.fn(), closed: false };
    vi.spyOn(window, "open").mockImplementation(() => openedWindow as unknown as Window);
    // Stand-in for the real loadNodeFullResInputs: it pulls the ref-backed
    // field back from disk and calls updateNodeData. Simulate that by
    // hydrating the upstream node in the mocked store, same shape the real
    // hydration produces (the raw `image` field goes from null to real pixels).
    mockLoadNodeFullResInputs.mockImplementation(async (_nodeId: string) => {
      storeNodes = storeNodes.map((n) =>
        n.id === UNWIRED_EDGE_SOURCE
          ? ({ ...n, data: { ...(n.data as object), image: HYDRATED_FG } } as WorkflowNode)
          : n,
      );
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands over the freshly-hydrated plate, not the null it read at click time", async () => {
    storeEdges = [
      {
        id: "e1",
        source: UNWIRED_EDGE_SOURCE,
        sourceHandle: "image",
        target: "spz-1",
        targetHandle: "image-fg",
      } as WorkflowEdge,
    ];
    // Lazily unhydrated, as on a freshly-reopened workflow: ref present, but
    // the inline image is null.
    storeNodes = [
      { id: UNWIRED_EDGE_SOURCE, type: "imageInput", data: { image: null, imageRef: "img-a" } } as unknown as WorkflowNode,
    ];

    renderSpzViewer();
    fireEvent.click(screen.getByText("Open empty viewer — load saved scene"));

    await waitFor(() => expect(mockLoadNodeFullResInputs).toHaveBeenCalledWith("spz-1"));
    await waitFor(() => expect(sessionStorage.getItem(FG_KEY)).not.toBeNull());

    expect(JSON.parse(sessionStorage.getItem(FG_KEY)!)).toEqual({ fg: HYDRATED_FG, alpha: null });

    // IMPORTANT 3, folded into the same click: the just-opened/reused window
    // is corrected directly via postMessage too, not left to rely solely on
    // sessionStorage (which a REUSED named window never re-reads).
    await waitFor(() =>
      expect(openedWindow.postMessage).toHaveBeenCalledWith(
        { type: "splat-viewer-fg", worldId: "spz-1", fg: HYDRATED_FG, alpha: null },
        window.location.origin,
      ),
    );
  });

  it("with neither pin wired, behaviour is unchanged: no handoff key, viewer still opens", async () => {
    storeEdges = [];
    storeNodes = [];
    // A leftover key from an earlier session must not survive an unwired open.
    sessionStorage.setItem(FG_KEY, "stale-from-a-previous-session");

    renderSpzViewer();
    fireEvent.click(screen.getByText("Open empty viewer — load saved scene"));

    await waitFor(() => expect(mockLoadNodeFullResInputs).toHaveBeenCalledWith("spz-1"));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    expect(sessionStorage.getItem(FG_KEY)).toBeNull();
  });

  it("IMPORTANT 2 — a write failure clears the key instead of leaving the PREVIOUS plate behind", async () => {
    storeEdges = [
      {
        id: "e1",
        source: UNWIRED_EDGE_SOURCE,
        sourceHandle: "image",
        target: "spz-1",
        targetHandle: "image-fg",
      } as WorkflowEdge,
    ];
    // Already hydrated this time — the point here is the write failure, not hydration.
    storeNodes = [{ id: UNWIRED_EDGE_SOURCE, type: "imageInput", data: { image: HYDRATED_FG } } as unknown as WorkflowNode];
    // Seed a PREVIOUS plate under the same key (as if plate A was handed over
    // successfully earlier), then force the write for the new plate to fail —
    // e.g. quota exceeded, switching to a larger plate B.
    sessionStorage.setItem(FG_KEY, JSON.stringify({ fg: "data:image/png;base64,OLD_PLATE_A", alpha: null }));
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key === FG_KEY) throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    renderSpzViewer();
    fireEvent.click(screen.getByText("Open empty viewer — load saved scene"));

    await waitFor(() => expect(window.open).toHaveBeenCalled());
    setItemSpy.mockRestore();

    // Not null (nothing) AND not the stale A payload either — removed outright.
    expect(sessionStorage.getItem(FG_KEY)).toBeNull();
  });
});
