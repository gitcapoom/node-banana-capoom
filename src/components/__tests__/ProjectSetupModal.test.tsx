import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProjectSetupModal } from "@/components/ProjectSetupModal";
import { ProviderSettings } from "@/types";

// Mock the workflow store
const mockSetUseExternalImageStorage = vi.fn();
const mockUpdateProviderApiKey = vi.fn();
const mockToggleProvider = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => {
  const useWorkflowStore = Object.assign(
    (selector?: (state: unknown) => unknown) => {
      if (selector) {
        return mockUseWorkflowStore(selector);
      }
      return mockUseWorkflowStore((s: unknown) => s);
    },
    {
      // The component calls useWorkflowStore.getState() when saving in
      // settings mode; route it through the same mock state.
      getState: () => mockUseWorkflowStore((s: unknown) => s),
    }
  );
  return {
    useWorkflowStore,
    generateWorkflowId: () => "mock-workflow-id",
  };
});

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock confirm
const mockConfirm = vi.fn(() => true);
global.confirm = mockConfirm;

// Ensure localStorage is always available in this test environment
const localStorageMock = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  key: vi.fn(() => null),
  length: 0,
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

// Default provider settings (Record<ProviderType, ProviderConfig> — must cover every provider)
const defaultProviderSettings: ProviderSettings = {
  providers: {
    gemini: { id: "gemini", name: "Gemini", enabled: true, apiKey: null, apiKeyEnvVar: "GEMINI_API_KEY" },
    openai: { id: "openai", name: "OpenAI", enabled: false, apiKey: null },
    anthropic: { id: "anthropic", name: "Anthropic", enabled: false, apiKey: null },
    replicate: { id: "replicate", name: "Replicate", enabled: false, apiKey: null },
    fal: { id: "fal", name: "fal.ai", enabled: false, apiKey: null },
    kie: { id: "kie", name: "Kie.ai", enabled: false, apiKey: null },
    wavespeed: { id: "wavespeed", name: "WaveSpeed", enabled: false, apiKey: null },
    worldlabs: { id: "worldlabs", name: "World Labs", enabled: false, apiKey: null },
    muapi: { id: "muapi", name: "muapi.ai", enabled: false, apiKey: null },
  },
};

// /api/env-status response with no env-configured providers
const envStatusAllFalse = {
  gemini: false,
  openai: false,
  anthropic: false,
  replicate: false,
  fal: false,
  kie: false,
  wavespeed: false,
  worldlabs: false,
};

// Default store state factory
const createDefaultState = (overrides = {}) => ({
  workflowName: "",
  workflowId: "",
  saveDirectoryPath: "",
  useExternalImageStorage: true,
  providerSettings: defaultProviderSettings,
  setUseExternalImageStorage: mockSetUseExternalImageStorage,
  updateProviderApiKey: mockUpdateProviderApiKey,
  toggleProvider: mockToggleProvider,
  maxConcurrentCalls: 3,
  setMaxConcurrentCalls: vi.fn(),
  canvasNavigationSettings: { panMode: "space", zoomMode: "altScroll", selectionMode: "click" },
  updateCanvasNavigationSettings: vi.fn(),
  ...overrides,
});

// Referentially-stable store state for the current test.
// IMPORTANT: the component's pre-fill useEffect depends on providerSettings /
// canvasNavigationSettings by reference. If the selector returned a fresh
// createDefaultState() object on every call, the effect would re-fire on every
// render, call setState, and loop forever (worker OOM). Tests that need
// different state must reassign `mockState` BEFORE rendering.
let mockState = createDefaultState();

describe("ProjectSetupModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for env-status API (called on modal open)
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/env-status") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(envStatusAllFalse),
        });
      }
      // Default success response for other APIs
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
    });
    mockState = createDefaultState();
    mockUseWorkflowStore.mockImplementation((selector) => selector(mockState));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Visibility", () => {
    it("should not render when isOpen is false", () => {
      render(
        <ProjectSetupModal
          isOpen={false}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      expect(screen.queryByText("New Project")).not.toBeInTheDocument();
      expect(screen.queryByText("Project Settings")).not.toBeInTheDocument();
    });

    it("should render with 'New Project' title when mode is 'new'", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      expect(screen.getByText("New Project")).toBeInTheDocument();
    });

    it("should render with 'Project Settings' title when mode is 'settings'", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      expect(screen.getByText("Project Settings")).toBeInTheDocument();
    });
  });

  describe("Tab Navigation", () => {
    it("should render Project, Providers, Node Defaults, and Canvas tabs", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      expect(screen.getByText("Project")).toBeInTheDocument();
      expect(screen.getByText("Providers")).toBeInTheDocument();
      expect(screen.getByText("Node Defaults")).toBeInTheDocument();
      expect(screen.getByText("Canvas")).toBeInTheDocument();
    });

    it("should start on Project tab in new mode", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      // Project tab should show project name input
      expect(screen.getByPlaceholderText("my-project")).toBeInTheDocument();
    });

    it("should switch to Providers tab when clicked", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      fireEvent.click(screen.getByText("Providers"));

      // Should show provider names
      expect(screen.getByText("Google Gemini")).toBeInTheDocument();
      expect(screen.getByText("OpenAI")).toBeInTheDocument();
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
      expect(screen.getByText("Replicate")).toBeInTheDocument();
      expect(screen.getByText("fal.ai")).toBeInTheDocument();
      expect(screen.getByText("Kie.ai")).toBeInTheDocument();
      expect(screen.getByText("WaveSpeed")).toBeInTheDocument();
    });
  });

  describe("Project Tab - New Mode", () => {
    it("should render empty form for new project", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
      const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project") as HTMLInputElement;

      expect(nameInput.value).toBe("");
      expect(directoryInput.value).toBe("");
    });

    it("should render Create button in new mode", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      expect(screen.getByText("Create")).toBeInTheDocument();
    });

    it("should render project name and directory inputs", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      expect(screen.getByText("Project Name")).toBeInTheDocument();
      expect(screen.getByText("Project Directory")).toBeInTheDocument();
    });

    it("should render embed images toggle", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      expect(screen.getByText("Embed images as base64")).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: /embed images as base64/i })).toBeInTheDocument();
    });
  });

  describe("Project Tab - Settings Mode", () => {
    it("should pre-fill form with existing values in settings mode", () => {
      mockState = createDefaultState({
        workflowName: "My Existing Project",
        saveDirectoryPath: "/path/to/project",
        useExternalImageStorage: false,
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
      const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project") as HTMLInputElement;

      expect(nameInput.value).toBe("My Existing Project");
      expect(directoryInput.value).toBe("/path/to/project");
    });

    it("should render Save button in settings mode", () => {
      mockState = createDefaultState({
        workflowName: "My Project",
        saveDirectoryPath: "/path/to/project",
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      expect(screen.getByText("Save")).toBeInTheDocument();
    });
  });

  describe("Form Validation", () => {
    it("should show error when project name is empty", async () => {
      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill directory but not name
      const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project");
      fireEvent.change(directoryInput, { target: { value: "/path/to/project" } });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(screen.getByText("Project name is required")).toBeInTheDocument();
      });
      expect(onSave).not.toHaveBeenCalled();
    });

    it("should show error when project directory is empty", async () => {
      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill name but not directory
      const nameInput = screen.getByPlaceholderText("my-project");
      fireEvent.change(nameInput, { target: { value: "My Project" } });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(screen.getByText("Project directory is required")).toBeInTheDocument();
      });
      expect(onSave).not.toHaveBeenCalled();
    });

    it("should allow save when directory does not exist yet", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(envStatusAllFalse),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ exists: false }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill both fields
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "/nonexistent/path" },
      });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          "mock-workflow-id",
          "My Project",
          "/nonexistent/path/My Project"
        );
      });
    });

    it("should show error when path is not absolute", async () => {
      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill name and a hostname-prefixed relative path
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "AT-ALGKG9VR/Users/guy/Desktop/AI Project" },
      });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(
          screen.getByText("Project directory must be an absolute path (starting with /, a drive letter, or a UNC path)")
        ).toBeInTheDocument();
      });
      expect(onSave).not.toHaveBeenCalled();
      // Validation should fail client-side without making a fetch to /api/workflow
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("/api/workflow")
      );
    });

    it("should show error when path is not a directory", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(envStatusAllFalse),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ exists: true, isDirectory: false }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill both fields
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "/path/to/file.txt" },
      });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(screen.getByText("Project path is not a directory")).toBeInTheDocument();
      });
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  describe("Save Behavior", () => {
    it("should call onSave with project details when form is valid", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(envStatusAllFalse),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ exists: true, isDirectory: true }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill both fields
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My New Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "/path/to/project" },
      });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          "mock-workflow-id",
          "My New Project",
          "/path/to/project/My New Project"
        );
      });
    });

    it("should show 'Validating...' while validating directory", async () => {
      let resolveValidation: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(envStatusAllFalse),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return new Promise((resolve) => {
            resolveValidation = resolve;
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      // Fill both fields
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "/path/to/project" },
      });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      expect(screen.getByText("Validating...")).toBeInTheDocument();

      // Resolve the validation
      resolveValidation!({
        ok: true,
        json: () => Promise.resolve({ exists: true, isDirectory: true }),
      });
    });

    it("should update external storage setting when saved", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(envStatusAllFalse),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ exists: true, isDirectory: true }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      // Fill fields
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "/path/to/project" },
      });

      // Toggle the embed switch (click it to enable embed/disable external)
      const embedSwitch = screen.getByRole("switch", { name: /embed images as base64/i });
      fireEvent.click(embedSwitch);

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockSetUseExternalImageStorage).toHaveBeenCalledWith(false);
      });
    });
  });

  describe("Browse Button", () => {
    // Browsing now opens the in-app FileOpenDialog (directory mode), which
    // lists folders via /api/list-directory. The old native-dialog
    // /api/browse-directory flow was removed.
    const mockBrowseFetch = (listedPath: string) => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(envStatusAllFalse),
          });
        }
        if (url.startsWith("/api/list-directory")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, path: listedPath, entries: [] }),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ exists: false, isDirectory: false }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });
    };

    it("should open the directory chooser and list directories when Browse is clicked", async () => {
      mockBrowseFetch("/selected/path");

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      fireEvent.click(screen.getByText("Browse"));

      expect(screen.getByText("Choose Directory")).toBeInTheDocument();

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("/api/list-directory")
        );
      });
    });

    it("should keep selected parent path in input after browse", async () => {
      mockBrowseFetch("/selected/path");

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      // Even with a project name typed, browsing keeps the parent path as-is
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "Foo" },
      });

      fireEvent.click(screen.getByText("Browse"));

      // Wait for the dialog to load the directory listing
      await waitFor(() => {
        expect(screen.getByText("/selected/path")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Select Folder"));

      expect(screen.queryByText("Choose Directory")).not.toBeInTheDocument();
      const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project") as HTMLInputElement;
      expect(directoryInput.value).toBe("/selected/path");
    });

    it("should keep selected path when project name is empty", async () => {
      mockBrowseFetch("/selected/path");

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      fireEvent.click(screen.getByText("Browse"));

      await waitFor(() => {
        expect(screen.getByText("/selected/path")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Select Folder"));

      const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project") as HTMLInputElement;
      expect(directoryInput.value).toBe("/selected/path");
    });

    it("should show a loading spinner while the directory listing loads", async () => {
      let resolvePromise: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(envStatusAllFalse),
          });
        }
        if (url.startsWith("/api/list-directory")) {
          return new Promise((resolve) => {
            resolvePromise = resolve;
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      fireEvent.click(screen.getByText("Browse"));

      expect(screen.getByText("Choose Directory")).toBeInTheDocument();
      expect(document.querySelector(".animate-spin")).not.toBeNull();

      resolvePromise!({
        ok: true,
        json: () => Promise.resolve({ success: true, path: "/selected/path", entries: [] }),
      });

      await waitFor(() => {
        expect(document.querySelector(".animate-spin")).toBeNull();
      });
    });

    it("should handle cancelled browse dialog", async () => {
      mockBrowseFetch("/original/path");

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      // Pre-fill directory
      const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project") as HTMLInputElement;
      fireEvent.change(directoryInput, { target: { value: "/original/path" } });

      fireEvent.click(screen.getByText("Browse"));
      expect(screen.getByText("Choose Directory")).toBeInTheDocument();

      // Escape cancels the dialog
      fireEvent.keyDown(screen.getByText("Choose Directory"), { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByText("Choose Directory")).not.toBeInTheDocument();
      });
      // Should keep original value when cancelled
      expect(directoryInput.value).toBe("/original/path");
    });

    it("should save using latest project name when renamed after browse", async () => {
      mockBrowseFetch("/selected/path");

      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "Foo" },
      });

      fireEvent.click(screen.getByText("Browse"));

      await waitFor(() => {
        expect(screen.getByText("/selected/path")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Select Folder"));

      const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project") as HTMLInputElement;
      expect(directoryInput.value).toBe("/selected/path");

      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "Bar" },
      });

      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          "mock-workflow-id",
          "Bar",
          "/selected/path/Bar"
        );
      });
    });
  });

  describe("Cancel Button", () => {
    it("should call onClose when Cancel is clicked", () => {
      const onClose = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={onClose}
          onSave={vi.fn()}
          mode="new"
        />
      );

      fireEvent.click(screen.getByText("Cancel"));

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("Keyboard Shortcuts", () => {
    it("should close modal when Escape is pressed", () => {
      const onClose = vi.fn();

      const { container } = render(
        <ProjectSetupModal
          isOpen={true}
          onClose={onClose}
          onSave={vi.fn()}
          mode="new"
        />
      );

      const modalDiv = container.querySelector(".bg-neutral-800");
      fireEvent.keyDown(modalDiv!, { key: "Escape" });

      expect(onClose).toHaveBeenCalled();
    });

    it("should submit form when Enter is pressed", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(envStatusAllFalse),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ exists: true, isDirectory: true }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      const onSave = vi.fn();

      const { container } = render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill fields
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "/path/to/project" },
      });

      const modalDiv = container.querySelector(".bg-neutral-800");
      fireEvent.keyDown(modalDiv!, { key: "Enter" });

      await waitFor(() => {
        expect(onSave).toHaveBeenCalled();
      });
    });
  });

  describe("Providers Tab", () => {
    // The default beforeEach already sets up proper mocks for env-status

    it("should render all provider sections", async () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByText("Providers"));

      await waitFor(() => {
        expect(screen.getByText("Google Gemini")).toBeInTheDocument();
        expect(screen.getByText("OpenAI")).toBeInTheDocument();
        expect(screen.getByText("Anthropic")).toBeInTheDocument();
        expect(screen.getByText("Replicate")).toBeInTheDocument();
        expect(screen.getByText("fal.ai")).toBeInTheDocument();
        expect(screen.getByText("Kie.ai")).toBeInTheDocument();
        expect(screen.getByText("WaveSpeed")).toBeInTheDocument();
      });
    });

    it("should show API key inputs for each provider", async () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByText("Providers"));

      await waitFor(() => {
        // Check for placeholder texts
        expect(screen.getByPlaceholderText("AIza...")).toBeInTheDocument();
        expect(screen.getByPlaceholderText("sk-...")).toBeInTheDocument();
        expect(screen.getByPlaceholderText("sk-ant-...")).toBeInTheDocument();
        expect(screen.getByPlaceholderText("r8_...")).toBeInTheDocument();
        // fal.ai, Kie.ai, and WaveSpeed share a generic placeholder
        expect(screen.getAllByPlaceholderText("...")).toHaveLength(3);
      });
    });

    it("should show 'Configured via .env' when provider has env key", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ...envStatusAllFalse, gemini: true }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByText("Providers"));

      await waitFor(() => {
        expect(screen.getByText("Configured via .env")).toBeInTheDocument();
      });
    });

    it("should show Override button for env-configured providers", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ...envStatusAllFalse, gemini: true }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByText("Providers"));

      await waitFor(() => {
        expect(screen.getByText("Override")).toBeInTheDocument();
      });
    });

    it("should toggle Show/Hide for API key visibility", async () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByText("Providers"));

      await waitFor(() => {
        const showButtons = screen.getAllByText("Show");
        expect(showButtons.length).toBeGreaterThan(0);
      });

      // Click Show for first provider
      fireEvent.click(screen.getAllByText("Show")[0]);

      await waitFor(() => {
        expect(screen.getByText("Hide")).toBeInTheDocument();
      });
    });

    it("should call onClose when Save is clicked on Providers tab", async () => {
      const onClose = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={onClose}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByText("Providers"));

      await waitFor(() => {
        expect(screen.getByText("Google Gemini")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Save"));

      expect(onClose).toHaveBeenCalled();
    });
  });
});
