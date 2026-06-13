# Splat Viewer — standalone extraction & sync

**Status:** planned, not yet executed. The build runs on a **separate workstation**; this doc lives in
the repo so the full plan is available there on clone. node-banana keeps working unchanged throughout.

## What & why
The Gaussian Splat Viewer (`src/app/viewer/page.tsx`, ~3,470 lines) is a self-contained, client-only
three.js + `@sparkjsdev/spark` splat viewer driven entirely by URL params
(`?url=&name=&worldId=&lens=&sensor=`) plus a `postMessage` capture-back. We're lifting it into its own
repo (**`gitcapoom/splat-viewer`**) so it's usable as a standalone viewer by any browser-based app, while
staying in sync with node-banana.

**Connection model: git subtree.** The viewer source is shared by both repos. node-banana keeps serving
it at `/viewer` **same-origin**, so its current behaviour is unchanged — the `blob:` splat URLs and the
same-origin capture `postMessage` keep working with zero changes. The `splat-viewer` repo wraps the same
source as a deployable standalone app.

Why subtree (not npm / not a separate deployed origin): node-banana hands the viewer a `blob:` URL
(`SpzViewerNode.tsx:245`) and the capture-back uses same-origin `postMessage` (`page.tsx` send,
`SpzViewerNode.tsx:47` receive, both keyed to `window.location.origin`). Both only work same-origin.
Subtree vendors the code inside node-banana at build time → same origin → no integration changes.

## Architecture (two repos, one shared source tree)
```
splat-viewer/                      (NEW repo = source of truth, a standard Vite + React + TS app)
  src/SplatViewer.tsx              ← page.tsx refactored to a default-export <SplatViewer/> component
  src/cameraAnimation.ts  src/colmapIO.ts  src/distortionShader.ts  src/dofShader.ts
  src/videoExport.ts      src/ExportDialog.tsx  src/Timeline.tsx          (moved as-is)
  src/lib/cinemaCameraPresets.ts   ← vendored from node-banana src/utils/
  src/lib/ensureEvenDimension.ts   ← extracted from src/lib/video-probing.ts (avoids the mediabunny dep)
  src/lib/equirectProjection.ts    ← only if pano is included
  src/main.tsx  index.html  vite.config.ts  tsconfig.json  package.json  tailwind  (standalone scaffold)

node-banana-capoom/
  src/splat-viewer/                ← git subtree mirror of the splat-viewer repo (the prefix)
  src/app/viewer/page.tsx          ← thin Next wrapper: "use client" + render <SplatViewer/>
  src/app/viewer/[worldId]/  /pano/← stay node-banana-only (NOT shared)
```
**Invariant that makes it work in both wrappers:** the shared `src/` must have **no `@/` or `next/`
imports** — only relative imports + npm packages. `SplatViewer.tsx` still reads `window.location.search`
on mount, which is fine under a Next route or a Vite root.

## Where the work happens (cross-workstation split)
- **Build workstation** (needs GitHub auth for both private repos; clone paths are wherever you put them):
  clone `gitcapoom/node-banana-capoom` (branch `develop`) — it holds the viewer source AND is where the
  subtree gets wired — and create `gitcapoom/splat-viewer`. Do Steps 1–2; push both repos. Done-criteria
  here: standalone viewer renders + node-banana `npx tsc --noEmit` clean + both repos pushed. Do **not**
  run node-banana's app or smoke-test Open Viewer/Capture here.
- **Deploy box (OTOSERVE10):** after `develop` is pushed, pull it, replicate the additive changes to
  `master` (the usual `git checkout develop -- …` copy), restart the `:3001`/`:3000` dev servers, and run
  the in-app no-regression check (Open Viewer loads + Capture creates image nodes). Push `master`.

## Step 1 — create the `splat-viewer` repo (standalone)
1. Create `gitcapoom/splat-viewer` (private).
2. Scaffold Vite + React + TS. Pin deps to node-banana's versions: `three@^0.182.0`,
   `@sparkjsdev/spark@^0.1.10`, `jszip@^3.10.1`, `mp4-muxer@^5.2.2`, `react@^19`, `react-dom@^19`,
   `tailwindcss@^4`.
3. Copy the shared core from the node-banana clone into the repo's `src/`:
   - **`SplatViewer.tsx`** = `src/app/viewer/page.tsx` with only two mechanical edits: rename the
     default-export function to `SplatViewer`, and repoint its 2 external imports to local relative paths
     (`@/utils/cinemaCameraPresets` → `./lib/cinemaCameraPresets`; the `ensureEvenDimension` import from
     `@/lib/video-probing` → `./lib/ensureEvenDimension`). **No logic changes.**
   - Move as-is from `src/app/viewer/`: `cameraAnimation.ts`, `colmapIO.ts`, `distortionShader.ts`,
     `dofShader.ts`, `videoExport.ts`, `ExportDialog.tsx`, `Timeline.tsx`.
   - Vendor into `src/lib/`: `cinemaCameraPresets.ts` (copy from node-banana `src/utils/` — pure,
     zero-dep) and `ensureEvenDimension.ts` (extract **just that one function** from node-banana
     `src/lib/video-probing.ts`; do NOT copy the whole file — it imports `mediabunny`).
4. Add `src/main.tsx` (`createRoot(document.getElementById('root')!).render(<SplatViewer/>)`) +
   `index.html` with a `#root` div.
5. `npm i && npm run dev` → open `/?url=<a CORS-enabled .ply or .spz>&name=test.ply` → splat renders;
   confirm `lens`/`sensor` params apply and video + COLMAP export still work. Commit + push `main`.

## Step 2 — wire node-banana to the shared source (on `develop`)
1. `git subtree add --prefix=src/splat-viewer https://github.com/gitcapoom/splat-viewer.git main --squash`
2. Replace `src/app/viewer/page.tsx` with:
   ```tsx
   "use client";
   import SplatViewer from "@/splat-viewer/src/SplatViewer";
   export default function ViewerPage() { return <SplatViewer />; }
   ```
   (`@/` → `src/`, so this resolves to `src/splat-viewer/src/SplatViewer.tsx`.)
3. Delete the now-duplicated `src/app/viewer/*.ts(x)` module files (they live in the subtree now). First
   **grep every importer** of `cinemaCameraPresets`, `equirectProjection`, `ensureEvenDimension`, and
   `./cameraAnimation` etc.; repoint `src/app/viewer/[worldId]/page.tsx` and `src/app/viewer/pano/page.tsx`
   (they import `cinemaCameraPresets` / `equirectProjection`) at the subtree, or leave thin re-export
   shims at the old `src/utils/...` paths.
4. **tsc gotcha:** add the standalone-only `src/splat-viewer/vite.config.ts` to node-banana's
   `tsconfig.json` `exclude` (it imports `vite`, which node-banana lacks). The nested `package.json` +
   `index.html` are inert for the Next build.
5. `npx tsc --noEmit` MUST be clean. Commit `develop` (trailer:
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`). Push `develop` + push the `splat-viewer` repo.

## Ongoing two-way sync
- **Pull viewer → node-banana** (bring features added in the standalone repo into node-banana):
  ```
  git subtree pull --prefix=src/splat-viewer https://github.com/gitcapoom/splat-viewer.git main --squash
  ```
- **Push node-banana → viewer** (send edits made inside node-banana back to the standalone repo):
  ```
  git subtree push --prefix=src/splat-viewer https://github.com/gitcapoom/splat-viewer.git main
  ```
- Run subtree ops on `develop` only; `master` gets the files via the normal develop→master replication on
  the deploy box. (Both are manual commands — that's normal for subtree, and keeps node-banana updates
  intentional.)

## Verification
1. **Standalone:** `npm run dev` → `?url=<CORS splat>` renders; camera/lens/sensor params apply; DoF +
   distortion + video export + COLMAP export work.
2. **node-banana no-regression (on OTOSERVE10):** tsc clean; from the Splat Viewer node, **Open Viewer**
   loads the splat, and **Capture** creates the image (+depth) input nodes — proving the same-origin
   `blob:` URL + `postMessage` path is intact.
3. **Sync round-trip:** trivial edit in `splat-viewer` → `subtree pull` into node-banana → change shows;
   edit in node-banana's `src/splat-viewer/` → `subtree push` → lands in the viewer repo.

## Scope / out of scope
- **Excluded:** `src/app/viewer/[worldId]/page.tsx` (server-coupled to `/api/worldlabs`, WorldLabs-only) —
  stays node-banana-only.
- **Optional later:** the `pano` viewer (separate node/route) — add `equirectProjection.ts` + a pano
  component to the shared core in a second pass.
- **Cross-origin capture-back** (so *other* apps embedding the deployed viewer can receive captures): the
  viewer posts with `targetOrigin = window.location.origin`, so capture only reaches a same-origin opener.
  Other apps can *view* splats today (just pass a CORS `?url=`); receiving captures cross-origin needs an
  `originAllow`/opener-origin param — future enhancement.
