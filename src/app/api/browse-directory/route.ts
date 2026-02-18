import { NextRequest, NextResponse } from "next/server";
import { readdir } from "fs/promises";
import { resolve, dirname, sep } from "path";
import { homedir } from "os";

/**
 * Normalize a path returned by native directory pickers.
 * On macOS, osascript can return hostname-prefixed paths for network volumes
 * (e.g. "HOSTNAME/Users/..." instead of "/Users/..."). This strips the
 * hostname prefix and cleans up trailing slashes.
 */
export function normalizeSelectedPath(selectedPath: string, platform: string): string {
  // On macOS/Linux, ensure the path is absolute.
  // osascript can return hostname-prefixed paths for network volumes
  // e.g. "AT-ALGKG9VR/Users/guy/Desktop" instead of "/Users/guy/Desktop"
  if ((platform === "darwin" || platform === "linux") && !selectedPath.startsWith("/")) {
    const firstSlash = selectedPath.indexOf("/");
    if (firstSlash >= 0) {
      selectedPath = selectedPath.substring(firstSlash);
    }
  }

  // Remove trailing slash/backslash (except root paths like "/" or "C:\")
  if (selectedPath.length > 1 && (selectedPath.endsWith("/") || selectedPath.endsWith("\\"))) {
    if (!(platform === "win32" && /^[A-Za-z]:[\\\/]$/.test(selectedPath))) {
      selectedPath = selectedPath.slice(0, -1);
    }
  }

  return selectedPath;
}

/**
 * GET: List directory contents for the web-based directory browser.
 * Returns subdirectories of the requested path (or home directory if no path given).
 *
 * Query params:
 *   - path (optional): Absolute directory path to list. Defaults to os.homedir().
 *
 * Response: { success, path, parent, separator, entries: [{ name }] }
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const requestedPath = searchParams.get("path");

    // Resolve to absolute path, default to home directory
    const resolvedPath = resolve(requestedPath || homedir());

    // Read directory contents
    const dirents = await readdir(resolvedPath, { withFileTypes: true });

    // Filter to directories only, sort alphabetically (case-insensitive)
    const entries = dirents
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((d) => ({ name: d.name }));

    // Compute parent (null if we're at root)
    const parent = dirname(resolvedPath);
    const isRoot = parent === resolvedPath;

    return NextResponse.json({
      success: true,
      path: resolvedPath,
      parent: isRoot ? null : parent,
      separator: sep,
      entries,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return NextResponse.json(
        { success: false, error: "Directory does not exist" },
        { status: 404 }
      );
    }

    if (code === "EACCES" || code === "EPERM") {
      return NextResponse.json(
        { success: false, error: "Permission denied" },
        { status: 403 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list directory",
      },
      { status: 500 }
    );
  }
}
