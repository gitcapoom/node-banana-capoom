import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { WelcomeModal } from "@/components/quickstart/WelcomeModal";
import { WorkflowFile } from "@/store/workflowStore";

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock templates
vi.mock("@/lib/quickstart/templates", () => {
  const template = {
    id: "product-shot",
    name: "Product Shot",
    description: "Place product in a new scene or environment",
    icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
    category: "product",
    tags: ["Gemini"],
    workflow: {
      name: "Product Shot",
      nodes: [{ id: "1", type: "imageInput", position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    },
  };
  return {
    getAllPresets: () => [template],
    PRESET_TEMPLATES: [template],
    getPresetTemplate: (id: string) => (id === "product-shot" ? { ...template, id: `workflow-${Date.now()}` } : null),
    getTemplateContent: () => ({ prompts: {}, images: {} }),
  };
});

describe("WelcomeModal", () => {
  const mockOnWorkflowGenerated = vi.fn();
  const mockOnClose = vi.fn();
  const mockOnNewProject = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Setup default fetch mock for community workflows
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/community-workflows") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, workflows: [] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Basic Rendering", () => {
    it("should render welcome modal with initial view by default", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      expect(screen.getByText("Node Banana Capoom")).toBeInTheDocument();
      expect(screen.getByText("New project")).toBeInTheDocument();
      expect(screen.getByText("Templates")).toBeInTheDocument();
      expect(screen.getByText("Prompt a workflow")).toBeInTheDocument();
    });

    it("should render modal overlay with backdrop", () => {
      const { container } = render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      const backdrop = container.querySelector(".bg-black\\/50");
      expect(backdrop).toBeInTheDocument();
    });
  });

  describe("Initial View Navigation", () => {
    it("should call onNewProject when 'New project' is clicked", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      fireEvent.click(screen.getByText("New project"));

      expect(mockOnNewProject).toHaveBeenCalled();
    });

    it("should navigate to templates view when 'Templates' is clicked", async () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByText("Templates"));
      });

      await waitFor(() => {
        expect(screen.getByText("Template Explorer")).toBeInTheDocument();
        expect(screen.getByText("Quick Start")).toBeInTheDocument();
      });
    });

    it("should navigate to vibe view when 'Prompt a workflow' is clicked", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      fireEvent.click(screen.getByText("Prompt a workflow"));

      expect(screen.getByText("Prompt a Workflow")).toBeInTheDocument();
      expect(screen.getByText("Describe your workflow")).toBeInTheDocument();
    });
  });

  describe("View Transitions", () => {
    it("should navigate back to initial view from templates view", async () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      // Navigate to templates
      await act(async () => {
        fireEvent.click(screen.getByText("Templates"));
      });

      await waitFor(() => {
        expect(screen.getByText("Template Explorer")).toBeInTheDocument();
      });

      // Click back
      await act(async () => {
        fireEvent.click(screen.getByText("Back"));
      });

      expect(screen.getByText("Node Banana Capoom")).toBeInTheDocument();
      expect(screen.getByText("New project")).toBeInTheDocument();
    });

    it("should navigate back to initial view from prompt view", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      // Navigate to prompt view
      fireEvent.click(screen.getByText("Prompt a workflow"));
      expect(screen.getByText("Prompt a Workflow")).toBeInTheDocument();

      // Click back
      fireEvent.click(screen.getByText("Back"));

      expect(screen.getByText("Node Banana Capoom")).toBeInTheDocument();
    });
  });

  describe("File Loading", () => {
    it("should render hidden file input for workflow loading", () => {
      const { container } = render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      const fileInput = container.querySelector('input[type="file"]');
      expect(fileInput).toBeInTheDocument();
      expect(fileInput).toHaveAttribute("accept", ".json");
      expect(fileInput).toHaveClass("hidden");
    });

    it("should trigger file input when 'Load workflow' is clicked", () => {
      const { container } = render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, "click");

      fireEvent.click(screen.getByText("Load workflow"));

      expect(clickSpy).toHaveBeenCalled();
    });

    it("should call onWorkflowGenerated when valid workflow file is loaded", async () => {
      const validWorkflow: WorkflowFile = {
        id: "test-id",
        version: 1,
        name: "Test Workflow",
        edgeStyle: "curved",
        nodes: [],
        edges: [],
      };

      // Create a mock FileReader class
      const mockFileReader = {
        readAsText: vi.fn(function (this: { onload: ((e: ProgressEvent<FileReader>) => void) | null; result: string }) {
          setTimeout(() => {
            this.onload?.({ target: { result: this.result } } as ProgressEvent<FileReader>);
          }, 0);
        }),
        onload: null as ((e: ProgressEvent<FileReader>) => void) | null,
        onerror: null,
        result: JSON.stringify(validWorkflow),
      };

      vi.stubGlobal("FileReader", function FileReaderMock(this: typeof mockFileReader) {
        Object.assign(this, mockFileReader);
        this.readAsText = mockFileReader.readAsText.bind(this);
        return this;
      });

      const { container } = render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      const file = new File([JSON.stringify(validWorkflow)], "test.json", {
        type: "application/json",
      });

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [file] } });
      });

      await waitFor(() => {
        expect(mockOnWorkflowGenerated).toHaveBeenCalledWith(validWorkflow);
      });

      vi.unstubAllGlobals();
    });

    it("should show alert for invalid workflow file format", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

      const invalidWorkflow = { foo: "bar" }; // Missing required fields

      const mockFileReader = {
        readAsText: vi.fn(function (this: { onload: ((e: ProgressEvent<FileReader>) => void) | null; result: string }) {
          setTimeout(() => {
            this.onload?.({ target: { result: this.result } } as ProgressEvent<FileReader>);
          }, 0);
        }),
        onload: null as ((e: ProgressEvent<FileReader>) => void) | null,
        onerror: null,
        result: JSON.stringify(invalidWorkflow),
      };

      vi.stubGlobal("FileReader", function FileReaderMock(this: typeof mockFileReader) {
        Object.assign(this, mockFileReader);
        this.readAsText = mockFileReader.readAsText.bind(this);
        return this;
      });

      const { container } = render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      const file = new File([JSON.stringify(invalidWorkflow)], "test.json", {
        type: "application/json",
      });

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [file] } });
      });

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith("Invalid workflow file format");
      });
      expect(mockOnWorkflowGenerated).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it("should show alert when file parsing fails", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

      const mockFileReader = {
        readAsText: vi.fn(function (this: { onload: ((e: ProgressEvent<FileReader>) => void) | null; result: string }) {
          setTimeout(() => {
            this.onload?.({ target: { result: this.result } } as ProgressEvent<FileReader>);
          }, 0);
        }),
        onload: null as ((e: ProgressEvent<FileReader>) => void) | null,
        onerror: null,
        result: "invalid json",
      };

      vi.stubGlobal("FileReader", function FileReaderMock(this: typeof mockFileReader) {
        Object.assign(this, mockFileReader);
        this.readAsText = mockFileReader.readAsText.bind(this);
        return this;
      });

      const { container } = render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      const file = new File(["invalid json"], "test.json", {
        type: "application/json",
      });

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [file] } });
      });

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith("Failed to parse workflow file");
      });

      vi.unstubAllGlobals();
    });

    it("should not process if no file is selected", () => {
      const { container } = render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

      fireEvent.change(fileInput, { target: { files: [] } });

      expect(mockOnWorkflowGenerated).not.toHaveBeenCalled();
    });
  });

  describe("Workflow Selection from Child Views", () => {
    it("should call onWorkflowGenerated when workflow is generated from templates view", async () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      // Navigate to templates
      await act(async () => {
        fireEvent.click(screen.getByText("Templates"));
      });

      await waitFor(() => {
        expect(screen.getByText("Template Explorer")).toBeInTheDocument();
      });

      // Verify templates view is showing - the actual workflow selection is tested in QuickstartTemplatesView tests
      expect(screen.getByText("Quick Start")).toBeInTheDocument();
    });

    it("should show prompt view when navigating to vibe", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      // Navigate to vibe/prompt view
      fireEvent.click(screen.getByText("Prompt a workflow"));

      expect(screen.getByText("Prompt a Workflow")).toBeInTheDocument();
      expect(screen.getByText("Generate Workflow")).toBeInTheDocument();
    });
  });
});
