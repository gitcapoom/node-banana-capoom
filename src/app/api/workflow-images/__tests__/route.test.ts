import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import * as path from "path";

const mockStat = vi.fn();
const mockMkdir = vi.fn();
const mockWriteFile = vi.fn();

vi.mock("fs/promises", () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { POST } from "../route";

// validateWorkflowPath compares each path against its path.resolve() form,
// so a POSIX-style "/test/workflow" fails on Windows ("C:/test/workflow"
// mismatch). Build test paths through the platform's own resolution instead.
const WORKFLOW_DIR = path.resolve("/test/workflow");

function createMockPostRequest(body: unknown): NextRequest {
  return {
    json: vi.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

describe("/api/workflow-images route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("POST - Save workflow image", () => {
    it("should save image when workflow directory exists", async () => {
      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        workflowPath: WORKFLOW_DIR,
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.imageId).toBe("img_123");
      expect(data.filePath).toBe(path.join(WORKFLOW_DIR, "inputs", "img_123.png"));
      expect(mockMkdir).toHaveBeenCalledWith(path.join(WORKFLOW_DIR, "inputs"), { recursive: true });
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it("should create missing workflow directory and save image", async () => {
      const newWorkflowDir = path.resolve("/test/new-workflow");
      mockStat.mockRejectedValue(new Error("ENOENT"));
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        workflowPath: newWorkflowDir,
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(mockMkdir).toHaveBeenCalledWith(newWorkflowDir, { recursive: true });
      expect(mockMkdir).toHaveBeenCalledWith(path.join(newWorkflowDir, "inputs"), { recursive: true });
    });

    it("should reject path traversal attempts", async () => {
      const request = createMockPostRequest({
        workflowPath: "/test/../etc/passwd",
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Path contains traversal sequences");
    });

    it("should reject non-absolute paths", async () => {
      const request = createMockPostRequest({
        workflowPath: "relative/path",
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Path must be absolute");
    });

    it("should reject dangerous system paths", async () => {
      const request = createMockPostRequest({
        workflowPath: "/etc/workflows",
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
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
});
