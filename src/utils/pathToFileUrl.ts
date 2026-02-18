/**
 * Convert a filesystem path to a file:// URL that the browser can open.
 * This allows the client's OS to handle the path (e.g., open in Windows Explorer)
 * instead of running shell commands on the server.
 *
 * Handles:
 * - UNC paths: //SERVER/share → file://SERVER/share
 * - UNC paths with backslashes: \\SERVER\share → file://SERVER/share
 * - Windows drive paths: C:\path → file:///C:/path
 * - Unix paths: /path → file:///path
 */
export function pathToFileUrl(inputPath: string): string {
  // Normalize backslashes to forward slashes
  const normalized = inputPath.replace(/\\/g, "/");

  // UNC path: //SERVER/share → file://SERVER/share
  if (normalized.startsWith("//")) {
    return "file:" + normalized;
  }

  // Windows drive: C:/path → file:///C:/path
  if (/^[A-Za-z]:\//.test(normalized)) {
    return "file:///" + normalized;
  }

  // Unix: /path → file:///path
  if (normalized.startsWith("/")) {
    return "file://" + normalized;
  }

  // Fallback: return as-is (shouldn't happen with absolute paths)
  return normalized;
}
