import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Generate3DNode } from "@/components/nodes/Generate3DNode";
import { makeNodeProps } from "@/test/nodeProps";
import { ReactFlowProvider } from "@xyflow/react";
import { Generate3DNodeData } from "@/types";

// Mock deduplicatedFetch
vi.mock("@/utils/deduplicatedFetch", () => ({
  deduplicatedFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  clearFetchCache: vi.fn(),
}));

// Mock the workflow store
const mockUpdateNodeData = vi.fn();
const mockRegenerateNode = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
  useProviderApiKeys: () => ({
    replicateApiKey: null,
    falApiKey: null,
    kieApiKey: null,
    wavespeedApiKey: null,
    replicateEnabled: false,
    kieEnabled: false,
  }),
}));

// Mock useReactFlow
const mockSetNodes = vi.fn();

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({
      getNodes: vi.fn(() => []),
      setNodes: mockSetNodes,
      screenToFlowPosition: vi.fn((pos) => pos),
    }),
  };
});

// Mock Toast
vi.mock("@/components/Toast", () => ({
  useToast: {
    getState: () => ({
      show: vi.fn(),
    }),
  },
}));

// Mock createPortal
vi.mock("react-dom", async () => {
  const actual = await vi.importActual("react-dom");
  return {
    ...actual,
    createPortal: (node: React.ReactNode) => node,
  };
});

// Mock ThreeModelViewer (requires WebGL which isn't available in jsdom)
vi.mock("@/components/ThreeModelViewer", () => ({
  ThreeModelViewer: () => null,
}));

// Mock saveMediaImmediately
vi.mock("@/utils/mediaStorage", () => ({
  saveMediaImmediately: vi.fn().mockResolvedValue(null),
  loadMediaById: vi.fn().mockResolvedValue(null),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

function TestWrapper({ children }: { children: React.ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

describe("Generate3DNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [], success: true }),
    });

    mockUseWorkflowStore.mockImplementation((selector) => {
      const state = {
        updateNodeData: mockUpdateNodeData,
        regenerateNode: mockRegenerateNode,
        addNode: vi.fn(),
        isRunning: false,
        currentNodeIds: [],
        groups: {},
        nodes: [],
        edges: [],
        recentModels: [],
        trackModelUsage: vi.fn(),
        incrementModalCount: vi.fn(),
        decrementModalCount: vi.fn(),
        getNodesWithComments: vi.fn(() => []),
        markCommentViewed: vi.fn(),
        setNavigationTarget: vi.fn(),
        generationsPath: null,
        saveDirectoryPath: null,
      };
      return selector(state);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createNodeData = (overrides: Partial<Generate3DNodeData> = {}): Generate3DNodeData => ({
    inputImages: [],
    inputPrompt: null,
    output3dUrl: null,
    savedFilename: null,
    savedFilePath: null,
    thumbnailImage: null,
    model3dHistory: [],
    selectedModel3dHistoryIndex: 0,
    status: "idle",
    error: null,
    ...overrides,
  });

  const createNodeProps = (data: Partial<Generate3DNodeData> = {}) => makeNodeProps({
    id: "test-3d-node",
    type: "generate3d" as const,
    data: createNodeData(data),
    selected: false,
  });

  describe("Basic Rendering", () => {
    it("should render 'Run to generate' when idle", () => {
      render(
        <TestWrapper>
          <Generate3DNode {...createNodeProps()} />
        </TestWrapper>
      );

      expect(screen.getByText("Run to generate")).toBeInTheDocument();
    });
  });

  describe("Handles", () => {
    it("should render image and text input handles", () => {
      const { container } = render(
        <TestWrapper>
          <Generate3DNode {...createNodeProps()} />
        </TestWrapper>
      );

      const imageHandle = container.querySelector('[data-handletype="image"]');
      const textHandle = container.querySelector('[data-handletype="text"]');
      expect(imageHandle).toBeInTheDocument();
      expect(textHandle).toBeInTheDocument();
    });

    it("should render 3D output handle", () => {
      const { container } = render(
        <TestWrapper>
          <Generate3DNode {...createNodeProps()} />
        </TestWrapper>
      );

      const outputHandle = container.querySelector('[data-handletype="3d"]');
      expect(outputHandle).toBeInTheDocument();
    });

    it("should render output label as '3D'", () => {
      render(
        <TestWrapper>
          <Generate3DNode {...createNodeProps()} />
        </TestWrapper>
      );

      expect(screen.getByText("3D")).toBeInTheDocument();
    });
  });

  describe("Output States", () => {
    it("should show 3D output area with clear button when output exists", () => {
      const { container } = render(
        <TestWrapper>
          <Generate3DNode {...createNodeProps({ output3dUrl: "https://example.com/model.glb" })} />
        </TestWrapper>
      );

      // Should show the clear button
      expect(screen.getByTitle("Clear 3D model")).toBeInTheDocument();

      // Should show "double click to view" hint
      expect(screen.getByText("double click to view")).toBeInTheDocument();
    });

    it("should show error message when status is error", () => {
      render(
        <TestWrapper>
          <Generate3DNode {...createNodeProps({
            status: "error",
            error: "Model not found",
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("Model not found")).toBeInTheDocument();
    });
  });
});
