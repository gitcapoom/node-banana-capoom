# Session handoff — splat-viewer

**Updated:** 2026-07-11 · **Repo:** `gitcapoom/splat-viewer`

Standalone, client-only Gaussian Splat viewer (three.js + `@sparkjsdev/spark`). Everything runs in the browser. This brief is self-contained — read it, then continue.

---

## Develop
`node_modules` may not be present in a fresh clone:
```bash
npm install
npm run dev        # http://localhost:5173
```
Open with a splat:
```
http://localhost:5173/?url=<https URL of a .ply or .spz>&name=test.ply
```

## Build
```bash
npm run build      # outputs dist/ with relative asset paths (base: "./")
```
The build is self-contained and path-relative, so it can be served from any static host under any subpath. Keeping `base: "./"` in `vite.config.ts` is required for subpath hosting.

## Feature set (what the viewer does)
- **Loading:** `.spz` / `.ply` splats and `.glb` / `.obj` meshes; drag-drop, file picker, or `?url=` param. Scene save/load via a `FileDialog` (`.json`).
- **Camera & optics:** 7 sensor presets, 13 prime focal lengths, 6 aspect ratios; physically-based FOV. Camera **Reset** (restores exact load-time pose), **far clip** override (auto `distance × 1000` — fixes black sky), camera-scale slider, coordinate-system selector.
- **Navigation:** Fly (WASD + Q/E + Shift boost + mouse-look) and Orbit; `F` to toggle. Frame button, ground grid, origin axes.
- **Scene panel (`MeshPanel.tsx`):** three tabs — Meshes (transform gizmos T/R/S, World/Local, always-on-top overlay, per-mesh capture IBL), Lights (Point/Spot/Rect with full controls), IBL probes (Radius/Ramp/Intensity + Lift/Gain/Gamma HDR grade).
- **Animation (`Timeline.tsx` + `cameraAnimation.ts`):** keyframe camera path (pos/quat/FOV) with per-segment step/linear/easeInOut/smooth; full per-keyframe scene snapshot animates geometry/lights too. Canvas timeline: scrub, drag keyframes, play/loop, editable duration + FPS. Keys: `K` add, `Del` delete, `T` timeline, `H` panels, `Ctrl/Cmd+Z` undo.
- **Post-processing:** real-time depth-of-field (thin-lens CoC, `showCoC` heatmap) and lens distortion (Brown-Conrady, 5-iter Newton); each has On/Off + Reset in the Camera panel.
- **Export (`ExportDialog` + `videoExport.ts`):** camera-path video, RGB/Depth/Both, up to 4K, FPS 12–60, H.264 20/50/100 Mbps, optional DoF bake. WebCodecs + mp4-muxer with MediaRecorder fallback. Requires ≥2 keyframes.
- **COLMAP (`colmapIO.ts`):** import/export `cameras.txt` + `images.txt` (+ Nodos `extras.txt`); world-frame conventions y-up / y-down (default) / z-up.

## URL params (parsed in `SplatViewer.tsx`)
- `url` — splat URL (`.ply` / `.spz`), must be CORS-enabled (or same-origin)
- `name` — display name / download filename
- `worldId` — opaque id echoed back with captures
- `lens` — focal length in mm (e.g. `50`)
- `sensor` — sensor **width** in mm as a number, not a preset name (e.g. `36`)

No aperture/f-number param — the DoF f-number is UI-only.

## Architecture invariant
Everything under `src/` must use **only relative imports + npm packages** — no `@/` or `next/`. This keeps the source portable so it compiles under the Vite root here. `src/lib/cinemaCameraPresets.ts` is a self-contained copy for the same reason.

> This repo is mirrored into `node-banana-capoom` via git subtree at `src/splat-viewer` (served there at `/viewer`). This repo is the source of truth — make changes here; node-banana pulls them. That is the only reason for the relative-imports invariant above; deployment/hosting of any downstream consumer is out of scope for this repo.

## Current state
- `main` HEAD `7aef353` — no specific task pending; general continuation.
- Recent work: camera Reset button, far-clip control, full-feature README.
