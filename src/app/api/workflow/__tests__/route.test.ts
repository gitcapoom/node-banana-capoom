import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import * as path from "path";

// Mock fs/promises before importing the route.
// The save path is crash-safe (open tmp + fsync + .bak rotate + rename):
//  - open(p, "w")  → tmp-file handle; its writeFile is forwarded to
//    mockWriteFile(p, json, "utf-8") so assertions still see the content.
//  - open(p, "r")  → head-probe of the existing target for .bak rotation;
//    defaults to ENOENT ("no existing file") — override per test.
const mockStat = vi.fn();
const mockMkdir = vi.fn();
const mockWriteFile = vi.fn();
const mockSync = vi.fn();
const mockClose = vi.fn();
const mockOpen = vi.fn();
const mockRename = vi.fn();
const mockCopyFile = vi.fn();
const mockUnlink = vi.fn();
const mockReadFile = vi.fn();

function wireFsDefaults() {
  mockOpen.mockImplementation((p: string, flags?: string) => {
    if (flags === "w") {
      return Promise.resolve({
        writeFile: (...args: unknown[]) => mockWriteFile(p, ...args),
        sync: (...args: unknown[]) => mockSync(...args),
        close: (...args: unknown[]) => mockClose(...args),
      });
    }
    return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  });
  mockSync.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
  mockCopyFile.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
}

vi.mock("fs/promises", () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  open: (...args: unknown[]) => mockOpen(...args),
  rename: (...args: unknown[]) => mockRename(...args),
  copyFile: (...args: unknown[]) => mockCopyFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// Mock logger to avoid console noise during tests
vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { POST, GET, PUT } from "../route";

// validateWorkflowPath compares each path against its path.resolve() form,
// so a POSIX-style "/test/dir" fails on Windows ("C:/test/dir" mismatch).
// Build test paths through the platform's own resolution instead.
const TEST_DIR = path.resolve("/test/dir");

// Helper to create mock NextRequest for POST
function createMockPostRequest(body: unknown): NextRequest {
  return {
    json: vi.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

// Helper to create mock NextRequest for GET
function createMockGetRequest(params: Record<string, string>): NextRequest {
  return {
    nextUrl: {
      searchParams: new URLSearchParams(params),
    },
  } as unknown as NextRequest;
}

describe("/api/workflow route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireFsDefaults();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("POST - Save workflow", () => {
    it("should save workflow successfully", async () => {
      const mockWorkflow = {
        nodes: [{ id: "node1", type: "prompt" }],
        edges: [],
      };

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: TEST_DIR,
        filename: "my-workflow",
        workflow: mockWorkflow,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.filePath).toBe(path.join(TEST_DIR, "my-workflow.json"));
      // Crash-safe write: content goes to a tmp sibling, fsynced, then renamed over.
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join(TEST_DIR, "my-workflow.json") + ".tmp-"),
        JSON.stringify(mockWorkflow, null, 2),
        "utf-8"
      );
      expect(mockSync).toHaveBeenCalled();
      expect(mockRename).toHaveBeenCalledWith(
        expect.stringContaining(".tmp-"),
        path.join(TEST_DIR, "my-workflow.json")
      );
      // No existing target (head-probe ENOENT) → no .bak rotation.
      expect(mockCopyFile).not.toHaveBeenCalled();
    });

    it("should rotate the previous good save to .bak before replacing it", async () => {
      const mockWorkflow = { nodes: [], edges: [] };
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockMkdir.mockResolvedValue(undefined);
      const finalPath = path.join(TEST_DIR, "workflow.json");
      // Existing target whose first byte is '{' (a good JSON file).
      mockOpen.mockImplementation((p: string, flags?: string) => {
        if (flags === "w") {
          return Promise.resolve({
            writeFile: (...args: unknown[]) => mockWriteFile(p, ...args),
            sync: (...args: unknown[]) => mockSync(...args),
            close: (...args: unknown[]) => mockClose(...args),
          });
        }
        return Promise.resolve({
          read: (buf: Buffer) => { buf[0] = 0x7b; return Promise.resolve({ bytesRead: 1 }); },
          close: (...args: unknown[]) => mockClose(...args),
        });
      });

      const response = await POST(createMockPostRequest({
        directoryPath: TEST_DIR,
        filename: "workflow",
        workflow: mockWorkflow,
      }));
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(mockCopyFile).toHaveBeenCalledWith(finalPath, `${finalPath}.bak`);
    });

    it("should NOT displace the .bak when the existing target is corrupt (not JSON)", async () => {
      const mockWorkflow = { nodes: [], edges: [] };
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockMkdir.mockResolvedValue(undefined);
      // Existing target reads back as NUL bytes (the crash-zeroed pattern).
      mockOpen.mockImplementation((p: string, flags?: string) => {
        if (flags === "w") {
          return Promise.resolve({
            writeFile: (...args: unknown[]) => mockWriteFile(p, ...args),
            sync: (...args: unknown[]) => mockSync(...args),
            close: (...args: unknown[]) => mockClose(...args),
          });
        }
        return Promise.resolve({
          read: (buf: Buffer) => { buf[0] = 0x00; return Promise.resolve({ bytesRead: 1 }); },
          close: (...args: unknown[]) => mockClose(...args),
        });
      });

      const response = await POST(createMockPostRequest({
        directoryPath: TEST_DIR,
        filename: "workflow",
        workflow: mockWorkflow,
      }));
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(mockCopyFile).not.toHaveBeenCalled();
      expect(mockRename).toHaveBeenCalled();
    });

    it("should sanitize filename with special characters", async () => {
      const mockWorkflow = { nodes: [], edges: [] };

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: TEST_DIR,
        filename: "my workflow!@#$%",
        workflow: mockWorkflow,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.filePath).toBe(path.join(TEST_DIR, "my_workflow_____.json"));
    });

    it("should create inputs and generations subfolders", async () => {
      const mockWorkflow = { nodes: [], edges: [] };

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: TEST_DIR,
        filename: "workflow",
        workflow: mockWorkflow,
      });

      await POST(request);

      expect(mockMkdir).toHaveBeenCalledWith(path.join(TEST_DIR, "inputs"), { recursive: true });
      expect(mockMkdir).toHaveBeenCalledWith(path.join(TEST_DIR, "generations"), { recursive: true });
    });

    it("should reject missing directoryPath", async () => {
      const request = createMockPostRequest({
        filename: "workflow",
        workflow: { nodes: [], edges: [] },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Missing required fields");
    });

    it("should reject missing filename", async () => {
      const request = createMockPostRequest({
        directoryPath: TEST_DIR,
        workflow: { nodes: [], edges: [] },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Missing required fields");
    });

    it("should reject missing workflow", async () => {
      const request = createMockPostRequest({
        directoryPath: TEST_DIR,
        filename: "workflow",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Missing required fields");
    });

    it("should reject non-directory path", async () => {
      mockStat.mockResolvedValue({
        isDirectory: () => false,
      });

      const request = createMockPostRequest({
        directoryPath: path.resolve("/test/file.txt"),
        filename: "workflow",
        workflow: { nodes: [], edges: [] },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Path is not a directory");
    });

    it("should create non-existent directory and continue saving", async () => {
      const mockWorkflow = { nodes: [], edges: [] };
      const nonexistentDir = path.resolve("/nonexistent/dir");
      mockStat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: nonexistentDir,
        filename: "workflow",
        workflow: mockWorkflow,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(mockMkdir).toHaveBeenCalledWith(nonexistentDir, { recursive: true });
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join(nonexistentDir, "workflow.json") + ".tmp-"),
        JSON.stringify(mockWorkflow, null, 2),
        "utf-8"
      );
    });

    it("should continue saving even if subfolder creation fails", async () => {
      const mockWorkflow = { nodes: [], edges: [] };

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockMkdir.mockRejectedValue(new Error("Permission denied"));
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: TEST_DIR,
        filename: "workflow",
        workflow: mockWorkflow,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.filePath).toBe(path.join(TEST_DIR, "workflow.json"));
    });

    it("should return 500 on write failure", async () => {
      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockRejectedValue(new Error("Disk full"));

      const request = createMockPostRequest({
        directoryPath: TEST_DIR,
        filename: "workflow",
        workflow: { nodes: [], edges: [] },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Disk full");
    });

    it("should reject path traversal attempts", async () => {
      const request = createMockPostRequest({
        directoryPath: "/test/../etc/passwd",
        filename: "workflow",
        workflow: { nodes: [], edges: [] },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Path contains traversal sequences");
    });

    it("should reject non-absolute paths", async () => {
      const request = createMockPostRequest({
        directoryPath: "relative/path",
        filename: "workflow",
        workflow: { nodes: [], edges: [] },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Path must be absolute");
    });

    it("should reject dangerous system paths", async () => {
      const request = createMockPostRequest({
        directoryPath: "/etc/workflows",
        filename: "workflow",
        workflow: { nodes: [], edges: [] },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      // On POSIX "/etc/workflows" survives path.resolve unchanged and hits
      // the dangerous-prefix blocklist; on Windows it resolves to
      // "C:/etc/workflows" and is rejected earlier by the traversal check.
      expect(data.error).toBe(
        process.platform === "win32"
          ? "Path contains traversal sequences"
          : "Access to /etc is not allowed"
      );
    });
  });

  describe("GET - Validate directory", () => {
    it("should return exists: true for existing directory", async () => {
      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });

      const request = createMockGetRequest({ path: TEST_DIR });
      const response = await GET(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.exists).toBe(true);
      expect(data.isDirectory).toBe(true);
    });

    it("should return isDirectory: false for file path", async () => {
      mockStat.mockResolvedValue({
        isDirectory: () => false,
      });

      const request = createMockGetRequest({ path: path.resolve("/test/file.txt") });
      const response = await GET(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.exists).toBe(true);
      expect(data.isDirectory).toBe(false);
    });

    it("should return exists: false for non-existent path", async () => {
      mockStat.mockRejectedValue(new Error("ENOENT"));

      const request = createMockGetRequest({ path: path.resolve("/nonexistent") });
      const response = await GET(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.exists).toBe(false);
      expect(data.isDirectory).toBe(false);
    });

    it("should reject missing path parameter", async () => {
      const request = createMockGetRequest({});
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Path parameter required");
    });

    it("should reject path traversal attempts in GET", async () => {
      const request = createMockGetRequest({ path: "/test/../etc" });
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Path contains traversal sequences");
    });

    it("should reject non-absolute paths in GET", async () => {
      const request = createMockGetRequest({ path: "relative/path" });
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Path must be absolute");
    });
  });

  describe("PUT - Load workflow by path", () => {
    const WF_PATH = path.join(TEST_DIR, "AI_Gen.json");
    const VALID_WF = JSON.stringify({ version: 1, nodes: [{ id: "n1" }], edges: [] });

    function createMockPutRequest(filePath: string): NextRequest {
      return { json: vi.fn().mockResolvedValue({ filePath }) } as unknown as NextRequest;
    }

    it("should load a valid workflow file", async () => {
      mockReadFile.mockResolvedValue(VALID_WF);

      const response = await PUT(createMockPutRequest(WF_PATH));
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.workflow.nodes).toHaveLength(1);
      expect(data.restoredFromBackup).toBe(false);
      expect(data.warning).toBeUndefined();
    });

    it("should fall back to .bak when the main file is corrupt", async () => {
      // Main file zeroed by a crash mid-save; .bak holds the previous good save.
      mockReadFile
        .mockResolvedValueOnce("   ")
        .mockResolvedValueOnce(VALID_WF);

      const response = await PUT(createMockPutRequest(WF_PATH));
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.restoredFromBackup).toBe(true);
      expect(data.warning).toContain(".bak");
      expect(data.workflow.nodes).toHaveLength(1);
      expect(mockReadFile.mock.calls[1][0]).toBe(`${path.normalize(WF_PATH)}.bak`);
    });

    it("should surface the original parse error when no .bak exists", async () => {
      mockReadFile
        .mockResolvedValueOnce("   ")
        .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      const response = await PUT(createMockPutRequest(WF_PATH));
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
    });
  });
});
