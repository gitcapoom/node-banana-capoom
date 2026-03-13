import * as path from "path";

/**
 * Validates a workflow directory path to prevent path traversal attacks.
 * Ensures the path is absolute, doesn't contain traversal sequences,
 * and doesn't point to dangerous system directories.
 *
 * Supports:
 * - Standard paths: C:\Users\..., /home/user/...
 * - UNC paths: \\server\share\... or //server/share/...
 * - Mapped network drives: Z:\Projects\...
 */
export function validateWorkflowPath(inputPath: string): {
  valid: boolean;
  resolved: string;
  error?: string;
} {
  // Must be an absolute path
  if (!path.isAbsolute(inputPath)) {
    return {
      valid: false,
      resolved: inputPath,
      error: "Path must be absolute",
    };
  }

  // Normalize to forward slashes for consistent comparison
  const normalized = inputPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const isUNC = normalized.startsWith("//");

  if (isUNC) {
    // For UNC paths (//server/share/...), path.resolve() strips the leading //
    // which makes the comparison fail. Instead, just check for traversal sequences.
    if (/\/\.\.\/|\/\.\.$/.test(normalized)) {
      return {
        valid: false,
        resolved: normalized,
        error: "Path contains traversal sequences",
      };
    }
  } else {
    // For standard paths, resolve and compare to catch .. traversal
    const resolved = path.resolve(inputPath).replace(/\\/g, "/").replace(/\/+$/, "");
    if (resolved !== normalized) {
      return {
        valid: false,
        resolved,
        error: "Path contains traversal sequences",
      };
    }
  }

  // Block known dangerous system directories
  const dangerousPrefixes = [
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/sys",
    "/proc",
    "/var/run",
    "/System",
    "/Library",
  ];

  for (const prefix of dangerousPrefixes) {
    if (normalized.startsWith(prefix + "/") || normalized === prefix) {
      return {
        valid: false,
        resolved: normalized,
        error: `Access to ${prefix} is not allowed`,
      };
    }
  }

  return {
    valid: true,
    resolved: isUNC ? normalized : path.resolve(inputPath).replace(/\\/g, "/"),
  };
}
