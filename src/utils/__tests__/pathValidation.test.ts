import { describe, it, expect } from "vitest";
import * as path from "path";
import { validateWorkflowPath } from "../pathValidation";

// Deterministic injected environments so both platforms' semantics can be
// exercised on any host. `cwd` pins path resolution (drive-relative paths on
// win32, and posix resolution) so results don't depend on the test runner's
// actual working directory.
const win32Deps = {
  pathImpl: path.win32,
  platform: "win32" as NodeJS.Platform,
  env: {} as Record<string, string | undefined>,
  cwd: "C:\\Users\\testuser",
};

const posixDeps = {
  pathImpl: path.posix,
  platform: "linux" as NodeJS.Platform,
  env: {} as Record<string, string | undefined>,
  cwd: "/home/testuser",
};

describe("validateWorkflowPath", () => {
  describe("win32 dangerous system prefixes", () => {
    it("blocks C:\\Windows itself", () => {
      const result = validateWorkflowPath("C:\\Windows", win32Deps);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Access to C:/Windows is not allowed");
    });

    it("blocks children of C:\\Windows", () => {
      const result = validateWorkflowPath("C:\\Windows\\System32", win32Deps);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Access to C:/Windows is not allowed");
    });

    it("blocks case variants (c:\\windows\\system32)", () => {
      const result = validateWorkflowPath("c:\\windows\\system32", win32Deps);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Access to C:/Windows is not allowed");
    });

    it("blocks forward-slash form (C:/Windows/Temp)", () => {
      const result = validateWorkflowPath("C:/Windows/Temp", win32Deps);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Access to C:/Windows is not allowed");
    });

    it("blocks trailing-slash form (C:\\Windows\\)", () => {
      const result = validateWorkflowPath("C:\\Windows\\", win32Deps);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Access to C:/Windows is not allowed");
    });

    it("blocks C:\\Program Files and children", () => {
      expect(validateWorkflowPath("C:\\Program Files", win32Deps).valid).toBe(false);
      const child = validateWorkflowPath("C:\\Program Files\\SomeApp", win32Deps);
      expect(child.valid).toBe(false);
      expect(child.error).toBe("Access to C:/Program Files is not allowed");
    });

    it("blocks C:\\Program Files (x86) and children", () => {
      const result = validateWorkflowPath(
        "C:\\Program Files (x86)\\SomeApp",
        win32Deps
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Access to C:/Program Files (x86) is not allowed");
    });

    it("blocks C:\\ProgramData and children", () => {
      const result = validateWorkflowPath("C:\\ProgramData\\SomeApp", win32Deps);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Access to C:/ProgramData is not allowed");
    });

    it("blocks \\\\?\\ device-path form of a blocked directory", () => {
      const result = validateWorkflowPath(
        "\\\\?\\C:\\Windows\\System32",
        win32Deps
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Access to C:/Windows is not allowed");
    });

    it("blocks \\\\.\\ device-path form of a blocked directory", () => {
      const result = validateWorkflowPath(
        "\\\\.\\C:\\Windows\\System32",
        win32Deps
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Access to C:/Windows is not allowed");
    });

    it("blocks admin-share form of a blocked directory (\\\\host\\c$\\Windows)", () => {
      const result = validateWorkflowPath(
        "\\\\localhost\\c$\\Windows\\System32",
        win32Deps
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Access to C:/Windows is not allowed");
    });

    it("rejects 8.3 short-name segments that could alias blocked directories", () => {
      const result = validateWorkflowPath("C:\\PROGRA~1\\SomeApp", win32Deps);
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        "Windows 8.3 short names are not allowed (PROGRA~1)"
      );
    });

    it("rejects 8.3 short names with extensions and in UNC paths", () => {
      expect(
        validateWorkflowPath("C:\\Users\\testuser\\DOCUME~1.OLD\\x", win32Deps).valid
      ).toBe(false);
      expect(
        validateWorkflowPath("\\\\server\\share\\PROGRA~1", win32Deps).valid
      ).toBe(false);
    });
  });

  describe("win32 near-miss siblings are NOT blocked", () => {
    it.each([
      "C:\\Windows-backup",
      "C:\\WindowsOld",
      "C:\\Program FilesX",
      "C:\\Program Files (x86) backup",
      "C:\\ProgramDataOld\\stuff",
    ])("allows %s", (input) => {
      const result = validateWorkflowPath(input, win32Deps);
      expect(result.valid).toBe(true);
    });
  });

  describe("win32 user-writable locations stay allowed", () => {
    it.each([
      "C:\\Users\\testuser\\Documents\\node-banana",
      "C:\\Users\\testuser\\Desktop",
      "D:\\Projects\\banana",
      "Z:\\shared\\workflows",
      "C:\\",
    ])("allows %s", (input) => {
      const result = validateWorkflowPath(input, win32Deps);
      expect(result.valid).toBe(true);
    });

    it("allows UNC network paths", () => {
      const result = validateWorkflowPath("\\\\server\\share\\folder", win32Deps);
      expect(result.valid).toBe(true);
    });

    it("allows non-system admin-share paths and 'Windows' as a share segment", () => {
      // c$\Users is the user tree, d$ is a data drive — neither is blocked;
      // a share directory merely NAMED Windows is not the system root.
      expect(
        validateWorkflowPath("\\\\localhost\\c$\\Users\\testuser", win32Deps).valid
      ).toBe(true);
      expect(validateWorkflowPath("\\\\host\\d$\\Data", win32Deps).valid).toBe(true);
      expect(
        validateWorkflowPath("\\\\server\\share\\Windows\\assets", win32Deps).valid
      ).toBe(true);
    });

    it("allows tilde names that are not 8.3 short names", () => {
      // No digit after the tilde, or the digit isn't terminal in the segment.
      expect(
        validateWorkflowPath("C:\\Users\\testuser\\my~notes", win32Deps).valid
      ).toBe(true);
      expect(
        validateWorkflowPath("C:\\Users\\testuser\\v2~3-backup", win32Deps).valid
      ).toBe(true);
    });

    it("does not apply POSIX prefixes on win32 for fully-qualified paths", () => {
      // e.g. a folder literally named "etc" on a data drive
      expect(validateWorkflowPath("D:\\etc\\stuff", win32Deps).valid).toBe(true);
    });
  });

  describe("win32 env-derived system locations", () => {
    it("derives blocked prefixes from SystemRoot/SystemDrive", () => {
      const deps = {
        ...win32Deps,
        env: { SystemDrive: "D:", SystemRoot: "D:\\WINNT" },
      };
      const winnt = validateWorkflowPath("D:\\WINNT\\System32", deps);
      expect(winnt.valid).toBe(false);
      expect(winnt.error).toBe("Access to D:/WINNT is not allowed");
      // Program Files fallback follows SystemDrive
      expect(validateWorkflowPath("D:\\Program Files\\App", deps).valid).toBe(false);
      expect(validateWorkflowPath("D:\\ProgramData\\App", deps).valid).toBe(false);
    });

    it("uses explicit ProgramFiles/ProgramData env values when present", () => {
      const deps = {
        ...win32Deps,
        env: {
          SystemDrive: "C:",
          SystemRoot: "C:\\Windows",
          ProgramFiles: "E:\\Program Files",
          "ProgramFiles(x86)": "E:\\Program Files (x86)",
          ProgramData: "E:\\ProgramData",
        },
      };
      expect(validateWorkflowPath("E:\\Program Files\\App", deps).valid).toBe(false);
      expect(
        validateWorkflowPath("E:\\Program Files (x86)\\App", deps).valid
      ).toBe(false);
      expect(validateWorkflowPath("E:\\ProgramData\\App", deps).valid).toBe(false);
      expect(validateWorkflowPath("C:\\Windows\\Temp", deps).valid).toBe(false);
    });
  });

  describe("win32 pre-existing rejections still fire first", () => {
    it("rejects traversal sequences before the blocklist", () => {
      const result = validateWorkflowPath("C:\\Users\\..\\Windows", win32Deps);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Path contains traversal sequences");
    });

    it("rejects drive-relative POSIX-style paths via the traversal check", () => {
      // Matches the documented behavior asserted by the route tests on Windows:
      // "/etc/workflows" resolves to "<cwd drive>:/etc/workflows" and mismatches.
      const result = validateWorkflowPath("/etc/workflows", win32Deps);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Path contains traversal sequences");
    });

    it("rejects relative paths", () => {
      const result = validateWorkflowPath("relative\\path", win32Deps);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Path must be absolute");
    });

    it("rejects UNC paths containing traversal", () => {
      const result = validateWorkflowPath(
        "\\\\server\\share\\..\\other",
        win32Deps
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Path contains traversal sequences");
    });
  });

  describe("POSIX behavior (unchanged)", () => {
    it.each([
      ["/etc", "/etc"],
      ["/etc/passwd", "/etc"],
      ["/usr/local", "/usr"],
      ["/bin/sh", "/bin"],
      ["/sbin/init", "/sbin"],
      ["/sys/kernel", "/sys"],
      ["/proc/1", "/proc"],
      ["/var/run/docker.sock", "/var/run"],
      ["/System/Library", "/System"],
      ["/Library/Preferences", "/Library"],
    ])("blocks %s", (input, prefix) => {
      const result = validateWorkflowPath(input, posixDeps);
      expect(result.valid).toBe(false);
      expect(result.error).toBe(`Access to ${prefix} is not allowed`);
    });

    it.each([
      "/home/testuser/projects",
      "/etcetera/files",
      "/usrdata",
      "/var/log",
      "/Volumes/External/projects",
      "/tmp/workflows",
    ])("allows %s", (input) => {
      const result = validateWorkflowPath(input, posixDeps);
      expect(result.valid).toBe(true);
    });

    it("does not apply Windows prefixes on POSIX", () => {
      // a literal directory named "C:" under root is weird but legal on POSIX
      expect(validateWorkflowPath("/mnt/c/Windows", posixDeps).valid).toBe(true);
    });

    it("rejects traversal sequences", () => {
      const result = validateWorkflowPath("/home/../etc", posixDeps);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Path contains traversal sequences");
    });

    it("rejects relative paths", () => {
      const result = validateWorkflowPath("relative/path", posixDeps);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Path must be absolute");
    });

    it("allows UNC-style network paths and rejects traversal within them", () => {
      expect(validateWorkflowPath("//server/share/folder", posixDeps).valid).toBe(
        true
      );
      const traversal = validateWorkflowPath("//server/share/../x", posixDeps);
      expect(traversal.valid).toBe(false);
      expect(traversal.error).toBe("Path contains traversal sequences");
    });

    it("is case-sensitive on POSIX (existing behavior)", () => {
      expect(validateWorkflowPath("/ETC/passwd", posixDeps).valid).toBe(true);
    });
  });

  describe("production defaults (host platform)", () => {
    it("accepts a plain host-resolved directory with no deps argument", () => {
      const result = validateWorkflowPath(path.resolve("/test/dir"));
      expect(result.valid).toBe(true);
      expect(result.resolved).toBe(
        path.resolve("/test/dir").replace(/\\/g, "/")
      );
    });

    it("rejects traversal with no deps argument", () => {
      // Build the raw string by hand: path.join would normalize the ".." away.
      const result = validateWorkflowPath(
        path.resolve("/test/dir") + path.sep + ".." + path.sep + "other"
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Path contains traversal sequences");
    });
  });

  describe("resolved output shape (unchanged)", () => {
    it("returns forward-slash resolved path for standard paths", () => {
      const result = validateWorkflowPath(
        "C:\\Users\\testuser\\Documents",
        win32Deps
      );
      expect(result.valid).toBe(true);
      expect(result.resolved).toBe("C:/Users/testuser/Documents");
    });

    it("returns normalized UNC path with trailing slash stripped", () => {
      const result = validateWorkflowPath("\\\\server\\share\\dir\\", win32Deps);
      expect(result.valid).toBe(true);
      expect(result.resolved).toBe("//server/share/dir");
    });
  });
});
