import { NextRequest, NextResponse } from "next/server";
import { mkdir } from "fs/promises";
import { createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "stream/web";
import path from "path";
import { validateWorkflowPath } from "@/utils/pathValidation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Writes a request body to a local path for the splat viewer's "save scene"
// (sidecar splat + lean JSON). The target path is a query param; the body is the
// raw bytes, streamed straight to disk — so a large splat is never buffered
// whole in memory (no ~5x base64 spike, no FormData/arrayBuffer ceiling).
// Traversal-guarded via validateWorkflowPath (allows network/UNC/mapped-drive
// project paths). No localhost-only gate — the app is routinely accessed over
// the LAN, and the sibling file routes (list-directory / save-generation) gate
// the same way.

export async function POST(req: NextRequest) {
  const targetPath = req.nextUrl.searchParams.get("path");
  if (!targetPath || typeof targetPath !== "string") {
    return NextResponse.json({ success: false, error: "path is required" }, { status: 400 });
  }
  const v = validateWorkflowPath(targetPath);
  if (!v.valid) {
    return NextResponse.json({ success: false, error: v.error || "Invalid path" }, { status: 400 });
  }
  if (!req.body) {
    return NextResponse.json({ success: false, error: "request body is empty" }, { status: 400 });
  }

  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    const nodeStream = Readable.fromWeb(req.body as unknown as NodeWebReadableStream);
    await pipeline(nodeStream, createWriteStream(targetPath));
    return NextResponse.json({ success: true, path: targetPath });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed to write file" },
      { status: 500 }
    );
  }
}
