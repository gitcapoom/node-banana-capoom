import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LLMGenerateNode } from "@/components/nodes/LLMGenerateNode";
import { makeNodeProps } from "@/test/nodeProps";
import { ReactFlowProvider } from "@xyflow/react";
import { LLMGenerateNodeData } from "@/types";

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
}));

// Wrapper component for React Flow context
function TestWrapper({ children }: { children: React.ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

describe("LLMGenerateNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementation
    mockUseWorkflowStore.mockImplementation((selector) => {
      const state = {
        updateNodeData: mockUpdateNodeData,
        regenerateNode: mockRegenerateNode,
        isRunning: false,
        currentNodeIds: [],
        groups: {},
        nodes: [],
        edges: [],
        providerSettings: { providers: {} },
        setHoveredNodeId: vi.fn(),
        getNodesWithComments: vi.fn(() => []),
        markCommentViewed: vi.fn(),
        setNavigationTarget: vi.fn(),
      };
      return selector(state);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createNodeData = (overrides: Partial<LLMGenerateNodeData> = {}): LLMGenerateNodeData => ({
    inputPrompt: null,
    inputImages: [],
    outputText: null,
    provider: "google",
    model: "gemini-3-flash-preview",
    temperature: 1.0,
    maxTokens: 2048,
    status: "idle",
    error: null,
    ...overrides,
  });

  const createNodeProps = (data: Partial<LLMGenerateNodeData> = {}) => makeNodeProps({
    id: "test-llm-1",
    type: "llmGenerate" as const,
    data: createNodeData(data),
    selected: false,
  });

  describe("Basic Rendering", () => {
    it("no longer renders a text INPUT handle — the compose box replaced it", () => {
      const { container } = render(
        <TestWrapper>
          <LLMGenerateNode {...createNodeProps()} />
        </TestWrapper>
      );

      expect(container.querySelector('[data-handletype="text"][class*="target"]')).toBeNull();
    });

    it("should render image input handle on left", () => {
      const { container } = render(
        <TestWrapper>
          <LLMGenerateNode {...createNodeProps()} />
        </TestWrapper>
      );

      const imageHandle = container.querySelector('[data-handletype="image"][class*="target"]');
      expect(imageHandle).toBeInTheDocument();
    });

    it("no longer renders a text OUTPUT handle — prompt nodes replaced it", () => {
      // The reply reaches the canvas as a real prompt node now, via the
      // Send/Update buttons, rather than being emitted straight into an edge.
      const { container } = render(
        <TestWrapper>
          <LLMGenerateNode {...createNodeProps()} />
        </TestWrapper>
      );

      expect(container.querySelector('[data-handletype="text"][class*="source"]')).toBeNull();
    });
  });

  describe("Empty State", () => {
    it("invites the user to type, now that every node has a compose box", () => {
      render(
        <TestWrapper>
          <LLMGenerateNode {...createNodeProps({ status: "idle", outputText: null })} />
        </TestWrapper>
      );

      expect(screen.getByText("No messages yet")).toBeInTheDocument();
    });

    it("offers a compose box and a Send button on every node", () => {
      render(
        <TestWrapper>
          <LLMGenerateNode {...createNodeProps({ status: "idle" })} />
        </TestWrapper>
      );

      expect(screen.getByPlaceholderText(/Type a message/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Send/ })).toBeInTheDocument();
    });
  });

  describe("Loading State", () => {
    it("shows a thinking indicator in the transcript", () => {
      const { container } = render(
        <TestWrapper>
          <LLMGenerateNode {...createNodeProps({ status: "loading" })} />
        </TestWrapper>
      );

      expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    });
  });

  describe("Error State", () => {
    it("should show error message when status is error", () => {
      render(
        <TestWrapper>
          <LLMGenerateNode {...createNodeProps({ status: "error", error: "API key missing" })} />
        </TestWrapper>
      );

      expect(screen.getByText("API key missing")).toBeInTheDocument();
    });

    it("still says it failed when the error message is null", () => {
      // A silent failure is worse than a vague one: the old single-output panel
      // always said this, and the transcript has to keep saying it.
      render(
        <TestWrapper>
          <LLMGenerateNode {...createNodeProps({ status: "error", error: null })} />
        </TestWrapper>
      );

      expect(screen.getByText("Generation failed")).toBeInTheDocument();
    });
  });

  describe("Transcript", () => {
    it("renders the assistant's reply from the conversation", () => {
      // outputText is no longer painted directly — the transcript is the view.
      render(
        <TestWrapper>
          <LLMGenerateNode
            {...createNodeProps({
              outputText: "Generated response text",
              conversation: [
                { role: "user", text: "hello", timestamp: 1 },
                { role: "assistant", text: "Generated response text", timestamp: 2 },
              ],
            })}
          />
        </TestWrapper>
      );

      expect(screen.getByText("Generated response text")).toBeInTheDocument();
    });
  });

  describe("Send", () => {
    it("calls regenerateNode when Send is clicked", () => {
      render(
        <TestWrapper>
          <LLMGenerateNode {...createNodeProps({ outputText: "Some output" })} />
        </TestWrapper>
      );

      fireEvent.click(screen.getByRole("button", { name: /Send/ }));

      expect(mockRegenerateNode).toHaveBeenCalledWith("test-llm-1");
    });

    it("disables Send while this node is executing", () => {
      // Per-node run gating (useCanRun): the button is blocked when this
      // node's id is in currentNodeIds, not by the global isRunning flag.
      mockUseWorkflowStore.mockImplementation((selector) => {
        const state = {
          updateNodeData: mockUpdateNodeData,
          regenerateNode: mockRegenerateNode,
          isRunning: true,
          currentNodeIds: ["test-llm-1"],
          groups: {},
          nodes: [],
          edges: [],
          providerSettings: { providers: {} },
          setHoveredNodeId: vi.fn(),
          getNodesWithComments: vi.fn(() => []),
          markCommentViewed: vi.fn(),
          setNavigationTarget: vi.fn(),
        };
        return selector(state);
      });

      render(
        <TestWrapper>
          <LLMGenerateNode {...createNodeProps({ outputText: "Some output" })} />
        </TestWrapper>
      );

      // When blocked, the button's title carries the blocked reason.
      expect(screen.getByTitle("Already running")).toBeDisabled();
    });

    it("keeps Send enabled when an unrelated node is executing", () => {
      // The point of per-node gating: in-flight work elsewhere in the
      // graph must not block this node (no upstream dependency on it).
      mockUseWorkflowStore.mockImplementation((selector) => {
        const state = {
          updateNodeData: mockUpdateNodeData,
          regenerateNode: mockRegenerateNode,
          isRunning: true,
          currentNodeIds: ["some-other-node"],
          groups: {},
          nodes: [],
          edges: [],
          providerSettings: { providers: {} },
          setHoveredNodeId: vi.fn(),
          getNodesWithComments: vi.fn(() => []),
          markCommentViewed: vi.fn(),
          setNavigationTarget: vi.fn(),
        };
        return selector(state);
      });

      render(
        <TestWrapper>
          <LLMGenerateNode {...createNodeProps({ outputText: "Some output" })} />
        </TestWrapper>
      );

      expect(screen.getByRole("button", { name: /Send/ })).not.toBeDisabled();
    });
  });

});
