import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import os from "os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Writes bytes to a local path for the splat viewer's "save scene" (sidecar
// splat + lean JSON). Localhost-only + restricted to the user's home directory,
// mirroring open-file/read-file. The client uploads multipart binary (NOT
// base64), so saving a large splat never inflates memory ~5x the way an
// embedded-base64 download does.

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

export async function POST(req: NextRequest) {
  if (!isLocalhostRequest(req)) {
    return NextResponse.json({ success: false, error: "Forbidden: localhost only" }, { status: 403 });
  }

  try {
    const form = await req.formData();
    const targetPath = form.get("path");
    const file = form.get("file");
    if (typeof targetPath !== "string" || !targetPath) {
      return NextResponse.json({ success: false, error: "path is required" }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "file is required" }, { status: 400 });
    }

    const normalizedPath = path.resolve(targetPath);
    const homeDir = os.homedir();
    if (!normalizedPath.startsWith(homeDir + path.sep) && normalizedPath !== homeDir) {
      return NextResponse.json({ success: false, error: "Path is outside allowed directory" }, { status: 403 });
    }

    await mkdir(path.dirname(normalizedPath), { recursive: true });
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(normalizedPath, buf);

    return NextResponse.json({ success: true, path: normalizedPath, size: buf.length });
  } catch {
    return NextResponse.json({ success: false, error: "Failed to write file" }, { status: 500 });
  }
}
