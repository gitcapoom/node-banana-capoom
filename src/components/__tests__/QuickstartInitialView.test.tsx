import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuickstartInitialView } from "@/components/quickstart/QuickstartInitialView";

describe("QuickstartInitialView", () => {
  const mockOnNewProject = vi.fn();
  const mockOnSelectTemplates = vi.fn();
  const mockOnSelectVibe = vi.fn();
  const mockOnSelectLoad = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Basic Rendering", () => {
    it("should render the Node Banana Capoom title and logo", () => {
      render(
        <QuickstartInitialView
          onNewProject={mockOnNewProject}
          onSelectTemplates={mockOnSelectTemplates}
          onSelectVibe={mockOnSelectVibe}
          onSelectLoad={mockOnSelectLoad}
        />
      );

      expect(screen.getByText("Node Banana Capoom")).toBeInTheDocument();
      expect(screen.getByAltText("")).toBeInTheDocument(); // Logo image
    });

    it("should render the description text", () => {
      render(
        <QuickstartInitialView
          onNewProject={mockOnNewProject}
          onSelectTemplates={mockOnSelectTemplates}
          onSelectVibe={mockOnSelectVibe}
          onSelectLoad={mockOnSelectLoad}
        />
      );

      expect(
        screen.getByText(/node based workflow editor for AI generation of all sorts/i)
      ).toBeInTheDocument();
    });

    it("should render all four option buttons", () => {
      render(
        <QuickstartInitialView
          onNewProject={mockOnNewProject}
          onSelectTemplates={mockOnSelectTemplates}
          onSelectVibe={mockOnSelectVibe}
          onSelectLoad={mockOnSelectLoad}
        />
      );

      expect(screen.getByText("New project")).toBeInTheDocument();
      expect(screen.getByText("Load workflow")).toBeInTheDocument();
      expect(screen.getByText("Templates")).toBeInTheDocument();
      expect(screen.getByText("Prompt a workflow")).toBeInTheDocument();
    });

    it("should render option descriptions", () => {
      render(
        <QuickstartInitialView
          onNewProject={mockOnNewProject}
          onSelectTemplates={mockOnSelectTemplates}
          onSelectVibe={mockOnSelectVibe}
          onSelectLoad={mockOnSelectLoad}
        />
      );

      expect(screen.getByText("Start a new workflow")).toBeInTheDocument();
      expect(screen.getByText("Open existing file")).toBeInTheDocument();
      expect(screen.getByText("Pre-built workflows")).toBeInTheDocument();
      expect(screen.getByText("Prompt a workflow")).toBeInTheDocument();
    });
  });

  describe("New Project Option", () => {
    it("should call onNewProject when clicked", () => {
      render(
        <QuickstartInitialView
          onNewProject={mockOnNewProject}
          onSelectTemplates={mockOnSelectTemplates}
          onSelectVibe={mockOnSelectVibe}
          onSelectLoad={mockOnSelectLoad}
        />
      );

      fireEvent.click(screen.getByText("New project"));

      expect(mockOnNewProject).toHaveBeenCalledTimes(1);
    });

    it("should display correct description for new project", () => {
      render(
        <QuickstartInitialView
          onNewProject={mockOnNewProject}
          onSelectTemplates={mockOnSelectTemplates}
          onSelectVibe={mockOnSelectVibe}
          onSelectLoad={mockOnSelectLoad}
        />
      );

      expect(screen.getByText("Start a new workflow")).toBeInTheDocument();
    });
  });

  describe("Load Workflow Option", () => {
    it("should call onSelectLoad when clicked", () => {
      render(
        <QuickstartInitialView
          onNewProject={mockOnNewProject}
          onSelectTemplates={mockOnSelectTemplates}
          onSelectVibe={mockOnSelectVibe}
          onSelectLoad={mockOnSelectLoad}
        />
      );

      fireEvent.click(screen.getByText("Load workflow"));

      expect(mockOnSelectLoad).toHaveBeenCalledTimes(1);
    });
  });

  describe("Templates Option", () => {
    it("should call onSelectTemplates when clicked", () => {
      render(
        <QuickstartInitialView
          onNewProject={mockOnNewProject}
          onSelectTemplates={mockOnSelectTemplates}
          onSelectVibe={mockOnSelectVibe}
          onSelectLoad={mockOnSelectLoad}
        />
      );

      fireEvent.click(screen.getByText("Templates"));

      expect(mockOnSelectTemplates).toHaveBeenCalledTimes(1);
    });
  });

  describe("Prompt a Workflow Option", () => {
    it("should call onSelectVibe when clicked", () => {
      render(
        <QuickstartInitialView
          onNewProject={mockOnNewProject}
          onSelectTemplates={mockOnSelectTemplates}
          onSelectVibe={mockOnSelectVibe}
          onSelectLoad={mockOnSelectLoad}
        />
      );

      fireEvent.click(screen.getByText("Prompt a workflow"));

      expect(mockOnSelectVibe).toHaveBeenCalledTimes(1);
    });

    it("should display Beta badge on prompt option", () => {
      render(
        <QuickstartInitialView
          onNewProject={mockOnNewProject}
          onSelectTemplates={mockOnSelectTemplates}
          onSelectVibe={mockOnSelectVibe}
          onSelectLoad={mockOnSelectLoad}
        />
      );

      expect(screen.getByText("Beta")).toBeInTheDocument();
    });
  });

  describe("External Links", () => {
    it("should render Node Banana attribution link", () => {
      render(
        <QuickstartInitialView
          onNewProject={mockOnNewProject}
          onSelectTemplates={mockOnSelectTemplates}
          onSelectVibe={mockOnSelectVibe}
          onSelectLoad={mockOnSelectLoad}
        />
      );

      const nodeBananaLink = screen.getByText(/"Node Banana"/).closest("a");
      expect(nodeBananaLink).toHaveAttribute(
        "href",
        "https://github.com/shrimbly/node-banana"
      );
      expect(nodeBananaLink).toHaveAttribute("target", "_blank");
      expect(nodeBananaLink).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("should render docs link", () => {
      render(
        <QuickstartInitialView
          onNewProject={mockOnNewProject}
          onSelectTemplates={mockOnSelectTemplates}
          onSelectVibe={mockOnSelectVibe}
          onSelectLoad={mockOnSelectLoad}
        />
      );

      const docsLink = screen.getByText("Docs").closest("a");
      expect(docsLink).toHaveAttribute("href", "https://node-banana-docs.vercel.app/");
      expect(docsLink).toHaveAttribute("target", "_blank");
      expect(docsLink).toHaveAttribute("rel", "noopener noreferrer");
    });
  });

  describe("Accessibility", () => {
    it("should have all buttons as interactive button elements", () => {
      render(
        <QuickstartInitialView
          onNewProject={mockOnNewProject}
          onSelectTemplates={mockOnSelectTemplates}
          onSelectVibe={mockOnSelectVibe}
          onSelectLoad={mockOnSelectLoad}
        />
      );

      const buttons = screen.getAllByRole("button");
      // Should have 4 option buttons
      expect(buttons.length).toBe(4);
    });
  });
});
