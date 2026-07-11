import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { WelcomeModal } from "@/components/quickstart/WelcomeModal";
import { WorkflowFile } from "@/store/workflowStore";

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock FileOpenDialog - the real dialog browses the server filesystem via
// /api/list-directory; stub it with buttons that trigger its callbacks.
vi.mock("@/components/FileOpenDialog", () => {
  const React = require("react");
  return {
    FileOpenDialog: (props: {
      onFileSelected: (filePath: string) => void;
      onCancel: () => void;
    }) =>
      React.createElement(
        "div",
        { "data-testid": "file-open-dialog" },
        React.createElement(
          "button",
          { onClick: () => props.onFileSelected("C:/workflows/test.json") },
          "Select test file"
        ),
        React.createElement(
          "button",
          { onClick: () => props.onCancel() },
          "Cancel dialog"
        )
      ),
  };
});

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
    it("should open file dialog when 'Load workflow' is clicked", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      expect(screen.queryByTestId("file-open-dialog")).not.toBeInTheDocument();

      fireEvent.click(screen.getByText("Load workflow"));

      expect(screen.getByTestId("file-open-dialog")).toBeInTheDocument();
    });

    it("should close file dialog without loading when cancelled", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      fireEvent.click(screen.getByText("Load workflow"));
      fireEvent.click(screen.getByText("Cancel dialog"));

      expect(screen.queryByTestId("file-open-dialog")).not.toBeInTheDocument();
      expect(mockOnWorkflowGenerated).not.toHaveBeenCalled();
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

      mockFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/workflow" && init?.method === "PUT") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                workflow: validWorkflow,
                directoryPath: "C:/workflows",
                fileName: "test.json",
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, workflows: [] }),
        });
      });

      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      fireEvent.click(screen.getByText("Load workflow"));

      await act(async () => {
        fireEvent.click(screen.getByText("Select test file"));
      });

      expect(mockFetch).toHaveBeenCalledWith("/api/workflow", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: "C:/workflows/test.json" }),
      });

      await waitFor(() => {
        expect(mockOnWorkflowGenerated).toHaveBeenCalledWith(
          validWorkflow,
          "C:/workflows",
          "test.json"
        );
      });

      // Dialog closes after selection
      expect(screen.queryByTestId("file-open-dialog")).not.toBeInTheDocument();
    });

    it("should show alert for invalid workflow file format", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

      mockFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/workflow" && init?.method === "PUT") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                workflow: { foo: "bar" }, // Missing version/nodes/edges
                directoryPath: "C:/workflows",
                fileName: "test.json",
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, workflows: [] }),
        });
      });

      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      fireEvent.click(screen.getByText("Load workflow"));

      await act(async () => {
        fireEvent.click(screen.getByText("Select test file"));
      });

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith("Invalid workflow file format");
      });
      expect(mockOnWorkflowGenerated).not.toHaveBeenCalled();
    });

    it("should show alert when the server fails to open the file", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

      mockFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/workflow" && init?.method === "PUT") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ success: false, error: "File not found" }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, workflows: [] }),
        });
      });

      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      fireEvent.click(screen.getByText("Load workflow"));

      await act(async () => {
        fireEvent.click(screen.getByText("Select test file"));
      });

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith("Failed to open: File not found");
      });
      expect(mockOnWorkflowGenerated).not.toHaveBeenCalled();
    });

    it("should show alert when the request throws", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

      mockFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/workflow" && init?.method === "PUT") {
          return Promise.reject(new Error("Network down"));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, workflows: [] }),
        });
      });

      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      fireEvent.click(screen.getByText("Load workflow"));

      await act(async () => {
        fireEvent.click(screen.getByText("Select test file"));
      });

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith(
          "Failed to open workflow: Network down"
        );
      });
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
