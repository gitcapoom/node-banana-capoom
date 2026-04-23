/**
 * Internal endpoint that triggers the schema warmer.
 *
 * Called by `server.js` at startup + once per 24h. Also exposed for manual
 * kick-off via:
 *   curl -X POST http://localhost:3001/api/_internal/warm-schemas
 *
 * Runs are serialized with a module-level lock so concurrent calls return the
 * current in-flight report instead of queueing another warm.
 */

import { NextRequest, NextResponse } from "next/server";
import { warmAllSchemas, type WarmReport } from "@/lib/schema/warmer";

// Tie lifecycle to Node (file-system access for disk cache).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let inFlight: Promise<WarmReport> | null = null;
let lastRun: { startedAt: number; report: WarmReport } | null = null;

function parseConcurrency(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get("concurrency");
  if (!raw) return 8;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 64) return 8;
  return n;
}

function parseForce(req: NextRequest): boolean {
  const raw = req.nextUrl.searchParams.get("force");
  return raw === "0" || raw === "false" ? false : true;
}

export async function POST(req: NextRequest) {
  if (inFlight) {
    return NextResponse.json({
      status: "already-running",
      message: "A warm run is already in progress.",
    });
  }

  const concurrency = parseConcurrency(req);
  const force = parseForce(req);
  const startedAt = Date.now();
  console.log(`[warm-schemas] Starting (concurrency=${concurrency}, force=${force})`);

  inFlight = warmAllSchemas({ concurrency, force })
    .then((report) => {
      lastRun = { startedAt, report };
      return report;
    })
    .finally(() => {
      inFlight = null;
    });

  try {
    const report = await inFlight;
    return NextResponse.json({ status: "ok", report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[warm-schemas] Failed: ${message}`);
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}

/**
 * GET — returns the most recent run's summary (or null if never run).
 */
export async function GET() {
  return NextResponse.json({
    inFlight: inFlight !== null,
    lastRun,
  });
}
