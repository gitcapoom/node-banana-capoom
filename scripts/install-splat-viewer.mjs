#!/usr/bin/env node
/**
 * Install the Gaussian Splat Viewer as a LOCAL build — without embedding it
 * in this repo.
 *
 * The viewer is a standalone project (gitcapoom/splat-viewer). This script
 * clones it to a temp dir, builds it, and copies the Vite build into
 * public/_viewer/ (gitignored). next.config.ts detects that folder and serves
 * /viewer from it instead of proxying the hosted build, so no external viewer
 * host (SPLAT_VIEWER_ORIGIN) is needed.
 *
 *   npm run viewer:install     # install or update (re-run any time)
 *
 * Requirements: git + npm on PATH. Restart the dev server after installing.
 * Override the source repo with SPLAT_VIEWER_REPO if you use a fork.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(repoRoot, "public", "_viewer");
const REPO = process.env.SPLAT_VIEWER_REPO || "https://github.com/gitcapoom/splat-viewer.git";

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "splat-viewer-"));
try {
  console.log(`\n→ Cloning ${REPO}`);
  run(`git clone --depth 1 "${REPO}" .`, tmp);

  console.log("\n→ Installing viewer dependencies");
  run("npm install --no-audit --no-fund", tmp);

  console.log("\n→ Building");
  run("npm run build", tmp);

  const dist = path.join(tmp, "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    throw new Error(`Build did not produce dist/index.html (looked in ${dist})`);
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(dist, dest, { recursive: true });

  console.log(`\n✓ Viewer installed → ${path.relative(repoRoot, dest)}`);
  console.log("  Restart the dev server; /viewer now serves this local build.");
  console.log("  Re-run `npm run viewer:install` any time to update.\n");
} finally {
  // Windows: git object files are read-only — retry, and tolerate leftovers
  // (it's a temp dir; the OS cleans it eventually).
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    console.warn(`(could not fully remove temp dir ${tmp} — safe to ignore)`);
  }
}
