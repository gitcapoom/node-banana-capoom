import { describe, it, expect, vi, beforeEach } from "vitest";
import { sep } from "path";

// Mock fs/promises before importing route (namespace import pattern, same as workflow route tests)
const mockReaddir = vi.fn();
vi.mock("fs/promises", () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
}));

// Mock os.homedir before importing route
vi.mock("os", () => ({
  homedir: () => "/home/testuser",
}));

// Import after mocks are set up
import { normalizeSelectedPath, GET } from "../route";
import type { NextRequest } from "next/server";

describe("normalizeSelectedPath", () => {
  it("should strip hostname prefix on macOS", () => {
    expect(normalizeSelectedPath("AT-ALGKG9VR/Users/guy/Desktop", "darwin"))
      .toBe("/Users/guy/Desktop");
  });

  it("should preserve absolute paths on macOS", () => {
    expect(normalizeSelectedPath("/Users/guy/Desktop", "darwin"))
      .toBe("/Users/guy/Desktop");
  });

  it("should remove trailing slash", () => {
    expect(normalizeSelectedPath("/Users/guy/Desktop/", "darwin"))
      .toBe("/Users/guy/Desktop");
  });

  it("should strip hostname and trailing slash", () => {
    expect(normalizeSelectedPath("HOST/Users/guy/", "darwin"))
      .toBe("/Users/guy");
  });

  it("should strip hostname prefix on Linux", () => {
    expect(normalizeSelectedPath("hostname/home/user", "linux"))
      .toBe("/home/user");
  });

  it("should not modify Windows drive paths", () => {
    expect(normalizeSelectedPath("C:\\Users\\guy", "win32"))
      .toBe("C:\\Users\\guy");
  });

  it("should preserve Windows drive root with backslash", () => {
    expect(normalizeSelectedPath("C:\\", "win32"))
      .toBe("C:\\");
  });

  it("should preserve Windows drive root with forward slash", () => {
    expect(normalizeSelectedPath("C:/", "win32"))
      .toBe("C:/");
  });

  it("should preserve Unix root /", () => {
    expect(normalizeSelectedPath("/", "darwin"))
      .toBe("/");
  });

  it("should leave hostname-only (no slash) as-is", () => {
    expect(normalizeSelectedPath("HOSTNAME", "darwin"))
      .toBe("HOSTNAME");
  });
});

describe("GET /api/browse-directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createRequest(path?: string) {
    const url = path
      ? `http://localhost:3000/api/browse-directory?path=${encodeURIComponent(path)}`
      : "http://localhost:3000/api/browse-directory";
    return { url } as NextRequest;
  }

  function makeDirent(name: string, isDir: boolean) {
    return {
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      parentPath: "",
      path: "",
    };
  }

  it("should return directory listing when path is given", async () => {
    mockReaddir.mockResolvedValueOnce([
      makeDirent("src", true),
      makeDirent("node_modules", true),
      makeDirent("package.json", false), // file, filtered out
    ]);

    const response = await GET(createRequest("/home/testuser/project"));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.entries).toHaveLength(2);
    expect(data.entries.map((e: { name: string }) => e.name)).toContain("src");
    expect(data.entries.map((e: { name: string }) => e.name)).toContain("node_modules");
  });

  it("should filter out files and only return directories", async () => {
    mockReaddir.mockResolvedValueOnce([
      makeDirent("folder1", true),
      makeDirent("file1.txt", false),
      makeDirent("file2.js", false),
      makeDirent("folder2", true),
    ]);

    const response = await GET(createRequest("/test"));
    const data = await response.json();

    expect(data.entries).toHaveLength(2);
    expect(data.entries.every((e: { name: string }) => ["folder1", "folder2"].includes(e.name))).toBe(true);
  });

  it("should sort entries alphabetically case-insensitive", async () => {
    mockReaddir.mockResolvedValueOnce([
      makeDirent("Zebra", true),
      makeDirent("apple", true),
      makeDirent("Banana", true),
    ]);

    const response = await GET(createRequest("/test"));
    const data = await response.json();

    expect(data.entries.map((e: { name: string }) => e.name)).toEqual(["apple", "Banana", "Zebra"]);
  });

  it("should return parent directory for subdirectory", async () => {
    mockReaddir.mockResolvedValueOnce([]);

    const response = await GET(createRequest("/home/testuser/projects"));
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.parent).toBeTruthy();
  });

  it("should include separator in response", async () => {
    mockReaddir.mockResolvedValueOnce([]);

    const response = await GET(createRequest("/test"));
    const data = await response.json();

    expect(data.separator).toBe(sep);
  });

  it("should return 404 for nonexistent path", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockReaddir.mockRejectedValueOnce(err);

    const response = await GET(createRequest("/nonexistent/path"));
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.success).toBe(false);
    expect(data.error).toBe("Directory does not exist");
  });

  it("should return 403 for permission denied", async () => {
    const err = new Error("EACCES") as NodeJS.ErrnoException;
    err.code = "EACCES";
    mockReaddir.mockRejectedValueOnce(err);

    const response = await GET(createRequest("/root/secret"));
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.success).toBe(false);
    expect(data.error).toBe("Permission denied");
  });

  it("should return 500 for other errors", async () => {
    mockReaddir.mockRejectedValueOnce(new Error("Unexpected error"));

    const response = await GET(createRequest("/test"));
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.success).toBe(false);
  });

  it("should default to home directory when no path given", async () => {
    mockReaddir.mockResolvedValueOnce([
      makeDirent("Documents", true),
    ]);

    const response = await GET(createRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    // Should have resolved to the mocked homedir
    expect(data.path).toContain("testuser");
  });
});
