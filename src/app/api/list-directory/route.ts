import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { validateWorkflowPath } from "@/utils/pathValidation";

export interface DirectoryEntry {
  name: string;
  type: "directory" | "file";
  size?: number;
}

// GET: List contents of a directory (folders + .json files only)
export async function GET(request: NextRequest) {
  const dirPath = request.nextUrl.searchParams.get("path");

  // If no path provided, return the user's home directory as a starting point
  if (!dirPath) {
    const homedir = os.homedir();
    return NextResponse.json({
      success: true,
      path: homedir,
      entries: await listDirectory(homedir),
    });
  }

  // Validate path to prevent traversal attacks
  const pathValidation = validateWorkflowPath(dirPath);
  if (!pathValidation.valid) {
    return NextResponse.json(
      { success: false, error: pathValidation.error },
      { status: 400 }
    );
  }

  try {
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) {
      return NextResponse.json(
        { success: false, error: "Path is not a directory" },
        { status: 400 }
      );
    }

    const entries = await listDirectory(dirPath);

    return NextResponse.json({
      success: true,
      path: dirPath,
      entries,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return NextResponse.json(
        { success: false, error: "Directory does not exist" },
        { status: 404 }
      );
    }
    if (err.code === "EPERM" || err.code === "EACCES") {
      return NextResponse.json(
        { success: false, error: "Permission denied" },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { success: false, error: err.message || "Failed to read directory" },
      { status: 500 }
    );
  }
}

async function listDirectory(dirPath: string): Promise<DirectoryEntry[]> {
  const rawEntries = await fs.readdir(dirPath, { withFileTypes: true });
  const entries: DirectoryEntry[] = [];

  for (const entry of rawEntries) {
    // Skip hidden files/folders (starting with .)
    if (entry.name.startsWith(".")) continue;
    // Skip node_modules
    if (entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      entries.push({ name: entry.name, type: "directory" });
    } else if (entry.name.toLowerCase().endsWith(".json")) {
      try {
        const filePath = path.join(dirPath, entry.name);
        const stat = await fs.stat(filePath);
        entries.push({ name: entry.name, type: "file", size: stat.size });
      } catch {
        entries.push({ name: entry.name, type: "file" });
      }
    }
  }

  // Sort: directories first (alphabetically), then files (alphabetically)
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return entries;
}
