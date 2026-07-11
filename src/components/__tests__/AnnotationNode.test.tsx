import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { AnnotationNode } from "@/components/nodes/AnnotationNode";
import { makeNodeProps } from "@/test/nodeProps";
import { ReactFlowProvider } from "@xyflow/react";
import { AnnotationNodeData } from "@/types";

// Mock the workflow store
const mockUpdateNodeData = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
}));

// Mock the annotation store
const mockOpenModal = vi.fn();
const mockUseAnnotationStore = vi.fn();

vi.mock("@/store/annotationStore", () => ({
  useAnnotationStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseAnnotationStore(selector);
    }
    return mockUseAnnotationStore((s: unknown) => s);
  },
}));

// Mock alert
const mockAlert = vi.fn();

// Wrapper component for React Flow context
function TestWrapper({ children }: { children: ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

describe("AnnotationNode", () => {
  beforeAll(() => {
    vi.stubGlobal("alert", mockAlert);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementation for workflow store
    mockUseWorkflowStore.mockImplementation((selector) => {
      const state = {
        updateNodeData: mockUpdateNodeData,
        currentNodeIds: [],
        groups: {},
        nodes: [],
        edges: [],
        getConnectedInputs: vi.fn(() => ({ images: [], text: null, dynamicInputs: {} })),
        getNodesWithComments: vi.fn(() => []),
        markCommentViewed: vi.fn(),
        setNavigationTarget: vi.fn(),
      };
      return selector(state);
    });

    // Default mock implementation for annotation store
    mockUseAnnotationStore.mockImplementation((selector) => {
      const state = {
        openModal: mockOpenModal,
      };
      return selector(state);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createNodeData = (overrides: Partial<AnnotationNodeData> = {}): AnnotationNodeData => ({
    sourceImage: null,
    annotations: [],
    outputImage: null,
    ...overrides,
  });

  const createNodeProps = (data: Partial<AnnotationNodeData> = {}) => makeNodeProps({
    id: "test-annotation-1",
    type: "annotation" as const,
    data: createNodeData(data),
    selected: false,
  });

  describe("Basic Rendering", () => {
    it("should render image input handle on left", () => {
      const { container } = render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      const inputHandle = container.querySelector('[data-handletype="image"][class*="target"]');
      expect(inputHandle).toBeInTheDocument();
    });

    it("should render image output handle on right", () => {
      const { container } = render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      const outputHandle = container.querySelector('[data-handletype="image"][class*="source"]');
      expect(outputHandle).toBeInTheDocument();
    });
  });

  describe("Empty State", () => {
    it("should show 'Connect an image' message when no image", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({ sourceImage: null, outputImage: null })} />
        </TestWrapper>
      );

      expect(screen.getByText("Connect an image")).toBeInTheDocument();
    });

    it("should not have any clickable/droppable empty state", () => {
      const { container } = render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      // No file input should exist
      const fileInput = container.querySelector('input[type="file"]');
      expect(fileInput).not.toBeInTheDocument();
    });
  });

  describe("Image Display", () => {
    const propsWithImage = {
      sourceImage: "data:image/png;base64,sourceImageData",
      annotations: [],
      outputImage: null,
    };

    it("should display source image when sourceImage is set", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps(propsWithImage)} />
        </TestWrapper>
      );

      const img = screen.getByAltText("Annotated");
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute("src", "data:image/png;base64,sourceImageData");
    });

    it("should display output image when outputImage is set", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,sourceImageData",
            outputImage: "data:image/png;base64,outputImageData",
            annotations: [],
          })} />
        </TestWrapper>
      );

      const img = screen.getByAltText("Annotated");
      expect(img).toHaveAttribute("src", "data:image/png;base64,outputImageData");
    });

    it("should prefer outputImage over sourceImage when both exist", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,source",
            outputImage: "data:image/png;base64,output",
            annotations: [],
          })} />
        </TestWrapper>
      );

      const img = screen.getByAltText("Annotated");
      expect(img).toHaveAttribute("src", "data:image/png;base64,output");
    });
  });

  describe("Edit Button / Image Click", () => {
    it("should show 'Add annotations' hint when no annotations exist", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,test",
            annotations: [],
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("Add annotations")).toBeInTheDocument();
    });

    it("should show annotation count when annotations exist", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,test",
            annotations: [
              { id: "1", type: "rectangle", x: 0, y: 0, width: 100, height: 100, stroke: "#ff0000", strokeWidth: 2, opacity: 1, fill: null },
              { id: "2", type: "rectangle", x: 50, y: 50, width: 100, height: 100, stroke: "#00ff00", strokeWidth: 2, opacity: 1, fill: null },
            ],
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("Edit (2)")).toBeInTheDocument();
    });

    it("should open annotation modal when edit button is clicked", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,test",
            annotations: [],
          })} />
        </TestWrapper>
      );

      const editButton = screen.getByText("Add annotations");
      fireEvent.click(editButton);

      expect(mockOpenModal).toHaveBeenCalledWith(
        "test-annotation-1",
        "data:image/png;base64,test",
        []
      );
    });

    it("should pass existing annotations when opening modal", () => {
      const annotations = [
        { id: "1", type: "rectangle" as const, x: 0, y: 0, width: 100, height: 100, stroke: "#ff0000", strokeWidth: 2, opacity: 1, fill: null },
      ];

      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,test",
            annotations,
          })} />
        </TestWrapper>
      );

      const editButton = screen.getByText("Edit (1)");
      fireEvent.click(editButton);

      expect(mockOpenModal).toHaveBeenCalledWith(
        "test-annotation-1",
        "data:image/png;base64,test",
        annotations
      );
    });

    it("should show connect message when trying to edit without an image", () => {
      // When no image, empty state shows "Connect an image" instead of edit controls
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({ sourceImage: null, outputImage: null })} />
        </TestWrapper>
      );

      expect(screen.getByText("Connect an image")).toBeInTheDocument();
    });
  });

  describe("Remove/Clear Button", () => {
    it("should render remove button when image is present", () => {
      const { container } = render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,test",
          })} />
        </TestWrapper>
      );

      // The remove button has an X SVG icon
      const removeButton = container.querySelector('button svg path[d*="M6 18"]');
      expect(removeButton).toBeInTheDocument();
    });

    it("should call updateNodeData to clear when remove button is clicked", () => {
      const { container } = render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,test",
            outputImage: "data:image/png;base64,output",
            annotations: [{ id: "1", type: "rectangle", x: 0, y: 0, width: 100, height: 100, stroke: "#ff0000", strokeWidth: 2, opacity: 1, fill: null }],
          })} />
        </TestWrapper>
      );

      // Find the remove button by looking for the button element that contains the X icon
      // The button has opacity-0 by default but is still clickable
      const buttons = container.querySelectorAll('button');
      // The remove button is the one with the X icon SVG
      const removeButton = Array.from(buttons).find((btn) =>
        btn.querySelector('svg path[d*="M6 18"]')
      );
      expect(removeButton).toBeInTheDocument();

      if (removeButton) {
        fireEvent.click(removeButton);
      }

      expect(mockUpdateNodeData).toHaveBeenCalledWith("test-annotation-1", {
        sourceImage: null,
        sourceImageRef: undefined,
        outputImage: null,
        outputImageRef: undefined,
        annotations: [],
      });
    });
  });

  describe("Input-only (no file upload/drop)", () => {
    it("should not render any file input element", () => {
      const { container } = render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      const fileInput = container.querySelector('input[type="file"]');
      expect(fileInput).not.toBeInTheDocument();
    });

    it("should not have any clickable drop zone in empty state", () => {
      const { container } = render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      // The empty state should show "Connect an image" and not be interactive
      const connectText = screen.getByText("Connect an image");
      expect(connectText).toBeInTheDocument();

      // Verify no cursor-pointer on the container
      const emptyContainer = connectText.parentElement!;
      expect(emptyContainer.className).not.toContain("cursor-pointer");
    });
  });

});
