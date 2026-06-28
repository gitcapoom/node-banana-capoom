import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { createReadStream } from "fs";
import { Readable } from "stream";
import path from "path";
import { validateWorkflowPath } from "@/utils/pathValidation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serves bytes of a local file for the splat viewer to load sidecar assets
// (the splat referenced by a saved scene JSON). Traversal-guarded via
// validateWorkflowPath, which allows network/UNC/mapped-drive project paths.
// No localhost-only gate — the app is routinely accessed over the LAN, and the
// sibling file routes (list-directory / save-generation) gate the same way.
// Streamed so a large splat is never buffered whole in server memory.

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".spz": "application/octet-stream",
  ".ply": "application/octet-stream",
  ".splat": "application/octet-stream",
  ".ksplat": "application/octet-stream",
};

export async function GET(req: NextRequest) {
  const inputPath = req.nextUrl.searchParams.get("path");
  if (!inputPath || typeof inputPath !== "string") {
    return NextResponse.json({ success: false, error: "path is required" }, { status: 400 });
  }

  const v = validateWorkflowPath(inputPath);
  if (!v.valid) {
    return NextResponse.json({ success: false, error: v.error || "Invalid path" }, { status: 400 });
  }

  let size = 0;
  try {
    const stats = await stat(inputPath);
    if (!stats.isFile()) {
      return NextResponse.json({ success: false, error: "Path is not a file" }, { status: 400 });
    }
    size = stats.size;
  } catch {
    return NextResponse.json({ success: false, error: "File does not exist" }, { status: 404 });
  }

  try {
    const nodeStream = createReadStream(inputPath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
    const ext = path.extname(inputPath).toLowerCase();
    return new NextResponse(webStream, {
      status: 200,
      headers: {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Content-Length": String(size),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: "Failed to read file" }, { status: 500 });
  }
}
