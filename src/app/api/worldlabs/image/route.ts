/**
 * WorldLabs Temporary Image Hosting
 *
 * Converts base64 image data to a temporary URL that WorldLabs API can access.
 * POST: stores base64 image in memory, returns a URL.
 * GET:  serves the image by UUID.
 *
 * Images auto-expire after 10 minutes.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

// In-memory store for temporary images
interface TempImage {
  data: Buffer;
  contentType: string;
  createdAt: number;
}

const imageStore = new Map<string, TempImage>();

// Cleanup interval: remove expired images every 2 minutes
const EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function ensureCleanup() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, img] of imageStore) {
      if (now - img.createdAt > EXPIRY_MS) {
        imageStore.delete(id);
      }
    }
    // Stop interval if no images left
    if (imageStore.size === 0 && cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  }, 2 * 60 * 1000);
}

// ─── POST: Store base64 image ───────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { imageData, contentType = "image/png" } = body as {
      imageData: string;
      contentType?: string;
    };

    if (!imageData) {
      return NextResponse.json(
        { success: false, error: "imageData is required" },
        { status: 400 }
      );
    }

    // Strip data URL prefix if present
    const base64 = imageData.includes(",")
      ? imageData.split(",")[1]
      : imageData;

    const buffer = Buffer.from(base64, "base64");
    const id = randomUUID();

    imageStore.set(id, {
      data: buffer,
      contentType,
      createdAt: Date.now(),
    });

    ensureCleanup();

    // Build the URL using the request's origin
    const url = new URL(request.url);
    const imageUrl = `${url.origin}/api/worldlabs/image?id=${id}`;

    console.log(
      `[WorldLabs:Image] Stored temp image ${id} (${(buffer.length / 1024).toFixed(1)}KB)`
    );

    return NextResponse.json({
      success: true,
      imageUrl,
      imageId: id,
    });
  } catch (error) {
    console.error("[WorldLabs:Image] POST error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// ─── GET: Serve stored image ────────────────────────────────────

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");

  if (!id) {
    return NextResponse.json(
      { error: "Missing id parameter" },
      { status: 400 }
    );
  }

  const image = imageStore.get(id);
  if (!image) {
    return NextResponse.json(
      { error: "Image not found or expired" },
      { status: 404 }
    );
  }

  // Check expiry
  if (Date.now() - image.createdAt > EXPIRY_MS) {
    imageStore.delete(id);
    return NextResponse.json(
      { error: "Image expired" },
      { status: 410 }
    );
  }

  return new NextResponse(image.data, {
    headers: {
      "Content-Type": image.contentType,
      "Content-Length": String(image.data.length),
      "Cache-Control": "private, max-age=600",
    },
  });
}
