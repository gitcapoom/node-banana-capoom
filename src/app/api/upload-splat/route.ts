import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";

const CADDY_BASE_URL = process.env.CADDY_BASE_URL;   // e.g. http://otoserve10:8080
const CADDY_UPLOAD_PATH = process.env.CADDY_UPLOAD_PATH; // filesystem path Caddy serves, e.g. /mnt/share
const UPLOAD_SUBDIR = "splat_uploads";

// POST: Upload a .spz/.ply file, save it under the Caddy-served filesystem,
// and return a persistent Caddy URL that survives page reloads.
export async function POST(request: NextRequest) {
  if (!CADDY_BASE_URL || !CADDY_UPLOAD_PATH) {
    return NextResponse.json(
      { success: false, error: "CADDY_BASE_URL / CADDY_UPLOAD_PATH not configured" },
      { status: 503 }
    );
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ success: false, error: "No file provided" }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const hash = crypto.createHash("md5").update(buf).digest("hex");
    const ext = file.name.match(/\.(spz|ply)$/i)?.[1]?.toLowerCase() ?? "spz";
    const basename = file.name.replace(/\.(spz|ply)$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const filename = `${basename}_${hash}.${ext}`;

    const uploadDir = path.join(CADDY_UPLOAD_PATH, UPLOAD_SUBDIR);
    await fs.mkdir(uploadDir, { recursive: true });

    const filePath = path.join(uploadDir, filename);
    // Skip write if identical file already exists (same hash → same content)
    try { await fs.access(filePath); } catch { await fs.writeFile(filePath, buf); }

    const url = `${CADDY_BASE_URL.replace(/\/$/, "")}/${UPLOAD_SUBDIR}/${filename}`;
    return NextResponse.json({ success: true, url });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Upload failed" },
      { status: 500 }
    );
  }
}
