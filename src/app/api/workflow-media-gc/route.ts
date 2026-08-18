/**
 * Reclaim orphaned media from a workflow's `inputs/` and `generations/` folders.
 *
 * Every generation, crop, comp commit and roto writes a NEW content-addressed file
 * (`img-${md5(dataUrl)}`, see saveImageAndGetId in imageStorage.ts) and nothing has
 * ever removed the superseded one. Measured on one real shot: 6.6 GB of 7.9 GB was
 * unreferenced — 119 of 159 files in `inputs/` alone. The workflow JSON itself was a
 * healthy 0.9 MB, so this is purely media that outlived its references.
 *
 * Three rules make this safe, and each exists because of a specific way it could
 * destroy work:
 *
 * 1. REFERENCES ARE READ FROM EVERY .json IN THE FOLDER, not just the live one —
 *    `AI_Gen.json.bak` holds the PREVIOUS save's refs. Collecting against only the
 *    current file would quietly gut the rolling backup, which is the one thing that
 *    makes a bad save recoverable.
 * 2. FILES ARE MOVED TO `_trash/<timestamp>/`, NEVER DELETED. Names are content
 *    hashes, so an older workflow restored later may reference something collected
 *    today; a move is recoverable, an unlink is not.
 * 3. IT ONLY EVER RUNS WHEN ASKED. No hook on save, load or idle. A collector racing
 *    an autosave is exactly the shape of an accident.
 *
 * GET  — dry run. Reports what WOULD move. Changes nothing.
 * POST — performs the move. Same scan, then relocates.
 */

import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "@/utils/logger";
import { validateWorkflowPath } from "@/utils/pathValidation";

export const maxDuration = 300;

/** Folders whose contents are candidates for collection. */
const MEDIA_FOLDERS = ["inputs", "generations"] as const;
const TRASH_FOLDER = "_trash";

export interface GcOrphan {
  folder: string;
  file: string;
  bytes: number;
}

export interface GcScan {
  /** Every .json consulted for references — surfaced so the caller can see that
   *  the .bak was included. */
  scannedManifests: string[];
  orphans: GcOrphan[];
  orphanBytes: number;
  referencedCount: number;
  referencedBytes: number;
}

/**
 * Build the set of referenced media by scanning the raw TEXT of every manifest.
 *
 * Deliberately not schema-aware: refs live in a dozen differently-named fields
 * (`imageRef`, `outputImageRef`, `inputImageRefs[]`, `thumbnailImageRef`,
 * `outputMaskRef`, history entry ids…) across every node type, and a schema-aware
 * walker would silently miss a field the day someone adds one. A substring test over
 * the file text cannot under-report, and over-reporting is harmless here — it only
 * means we keep a file we could have collected.
 */
async function scanProject(dir: string): Promise<GcScan> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const manifests = entries
    .filter((e) => e.isFile() && /\.json(\.bak)?$/i.test(e.name))
    .map((e) => e.name);

  let corpus = "";
  for (const name of manifests) {
    try {
      corpus += await fs.readFile(path.join(dir, name), "utf-8");
    } catch {
      // An unreadable manifest is a reason to collect LESS, not more. Bail out
      // rather than risk treating its references as absent.
      throw new Error(`Could not read ${name} — refusing to scan with an incomplete reference set`);
    }
  }

  const orphans: GcOrphan[] = [];
  let orphanBytes = 0;
  let referencedCount = 0;
  let referencedBytes = 0;

  for (const folder of MEDIA_FOLDERS) {
    const abs = path.join(dir, folder);
    let files: string[];
    try {
      files = (await fs.readdir(abs, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      continue; // folder absent — nothing to collect
    }
    for (const file of files) {
      let bytes = 0;
      try {
        bytes = (await fs.stat(path.join(abs, file))).size;
      } catch {
        continue;
      }
      // Match on the STEM: refs are stored without an extension.
      const stem = file.replace(/\.[^.]+$/, "");
      if (stem && corpus.includes(stem)) {
        referencedCount++;
        referencedBytes += bytes;
      } else {
        orphans.push({ folder, file, bytes });
        orphanBytes += bytes;
      }
    }
  }

  return { scannedManifests: manifests, orphans, orphanBytes, referencedCount, referencedBytes };
}

function validate(dir: string | null): { ok: true } | { ok: false; res: NextResponse } {
  if (!dir) {
    return { ok: false, res: NextResponse.json({ success: false, error: "workflowPath is required" }, { status: 400 }) };
  }
  const v = validateWorkflowPath(dir);
  if (!v.valid) {
    return { ok: false, res: NextResponse.json({ success: false, error: v.error }, { status: 400 }) };
  }
  return { ok: true };
}

/** GET — dry run. */
export async function GET(request: NextRequest) {
  const dir = request.nextUrl.searchParams.get("workflowPath");
  const gate = validate(dir);
  if (!gate.ok) return gate.res;

  try {
    const scan = await scanProject(path.normalize(dir!));
    logger.info("file.load", "Media GC dry run", {
      workflowPath: dir,
      manifests: scan.scannedManifests,
      orphans: scan.orphans.length,
      orphanBytes: scan.orphanBytes,
    });
    return NextResponse.json({ success: true, ...scan });
  } catch (error) {
    logger.error("file.error", "Media GC dry run failed", { workflowPath: dir }, error instanceof Error ? error : undefined);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Scan failed" },
      { status: 500 },
    );
  }
}

/** POST — move the orphans into `_trash/<timestamp>/`. */
export async function POST(request: NextRequest) {
  let dir: string | undefined;
  try {
    const body = await request.json();
    dir = body.workflowPath;
    const gate = validate(dir ?? null);
    if (!gate.ok) return gate.res;

    const root = path.normalize(dir!);
    // Re-scan rather than trusting a list from the client: the dry run may be
    // minutes old, and a file that became referenced since then must not be moved.
    const scan = await scanProject(root);
    if (scan.orphans.length === 0) {
      return NextResponse.json({ success: true, moved: 0, movedBytes: 0, trashDir: null });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const trashDir = path.join(root, TRASH_FOLDER, stamp);

    let moved = 0;
    let movedBytes = 0;
    const failed: string[] = [];
    for (const o of scan.orphans) {
      const from = path.join(root, o.folder, o.file);
      const to = path.join(trashDir, o.folder, o.file);
      try {
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
        moved++;
        movedBytes += o.bytes;
      } catch (err) {
        // Cross-device or locked file — copy+unlink rather than abandoning it.
        try {
          await fs.copyFile(from, to);
          await fs.unlink(from);
          moved++;
          movedBytes += o.bytes;
        } catch {
          failed.push(o.file);
        }
      }
    }

    logger.info("file.save", "Media GC moved orphans to trash", {
      workflowPath: dir,
      manifests: scan.scannedManifests,
      moved,
      movedBytes,
      failed: failed.length,
      trashDir,
    });

    return NextResponse.json({ success: true, moved, movedBytes, trashDir, failed });
  } catch (error) {
    logger.error("file.error", "Media GC failed", { workflowPath: dir }, error instanceof Error ? error : undefined);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "GC failed" },
      { status: 500 },
    );
  }
}
