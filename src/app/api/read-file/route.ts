import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { createReadStream } from "fs";
import { Readable } from "stream";
import path from "path";
import os from "os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serves bytes of a local file for the splat viewer to load sidecar assets
// (the splat referenced by a saved scene JSON). Localhost-only + restricted to
// the user's home directory, mirroring open-file's guards. Streamed so a large
// splat is never buffered whole in server memory.

function isLocalhostRequest(req: NextRequest): boolean {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const firstIp = forwarded.split(",")[0].trim();
    if (firstIp !== "127.0.0.1" && firstIp !== "::1" && firstIp !== "::ffff:127.0.0.1") return false;
  }
  const host = req.headers.get("host") || "";
  const hostname = host.split(":")[0];
  if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") return false;
  return true;
}

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".spz": "application/octet-stream",
  ".ply": "application/octet-stream",
  ".splat": "application/octet-stream",
  ".ksplat": "application/octet-stream",
};

export async function GET(req: NextRequest) {
  if (!isLocalhostRequest(req)) {
    return NextResponse.json({ success: false, error: "Forbidden: localhost only" }, { status: 403 });
  }

  const inputPath = req.nextUrl.searchParams.get("path");
  if (!inputPath || typeof inputPath !== "string") {
    return NextResponse.json({ success: false, error: "path is required" }, { status: 400 });
  }

  // Normalize + restrict to the user's home directory (prevents traversal).
  const normalizedPath = path.resolve(inputPath);
  const homeDir = os.homedir();
  if (!normalizedPath.startsWith(homeDir + path.sep) && normalizedPath !== homeDir) {
    return NextResponse.json({ success: false, error: "Path is outside allowed directory" }, { status: 403 });
  }

  let size = 0;
  try {
    const stats = await stat(normalizedPath);
    if (!stats.isFile()) {
      return NextResponse.json({ success: false, error: "Path is not a file" }, { status: 400 });
    }
    size = stats.size;
  } catch {
    return NextResponse.json({ success: false, error: "File does not exist" }, { status: 404 });
  }

  try {
    const nodeStream = createReadStream(normalizedPath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
    const ext = path.extname(normalizedPath).toLowerCase();
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
