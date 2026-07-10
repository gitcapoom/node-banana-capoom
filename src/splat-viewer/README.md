# Splat Viewer

Standalone, client-only Gaussian Splat viewer (three.js + [`@sparkjsdev/spark`](https://www.npmjs.com/package/@sparkjsdev/spark)), driven entirely by URL params plus an optional same-origin `postMessage` capture-back.

This repo is the **source of truth** for the viewer. It is shared into
[`node-banana-capoom`](https://github.com/gitcapoom/node-banana-capoom) via `git subtree`
(prefix `src/splat-viewer`), where it is served same-origin at `/viewer`.

## Features

- **SPZ / PLY loading** — drag-drop, file picker, or `?url=` param
- **Cinematic camera presets** — 7 sensors, 13 focal lengths, 6 aspect ratios
- **Keyframe animation** — Catmull-Rom paths with canvas timeline UI (linear / smooth / easeInOut interpolation)
- **Video export** — WebCodecs + mp4-muxer (MediaRecorder fallback), RGB or depth, up to 4K / 100 Mbps
- **Real-time post-processing** — thin-lens depth-of-field, Brown-Conrady lens distortion
- **COLMAP import/export** — camera tracks as `cameras.txt` + `images.txt`, multiple world-frame conventions
- **Camera Reset** — one-click restore to the exact pose the camera had when the file loaded
- **Far clip control** — manual override for the camera far plane (fixes black sky on large splats)
- **Screenshot capture** — aspect-ratio cropped, cinematic naming

## Develop

```bash
npm install
npm run dev
```

Open with a CORS-enabled splat:

```
http://localhost:5173/?url=<https URL of a .ply or .spz>&name=test.ply
```

### URL params
- `url` — splat URL (`.ply` / `.spz`), must be CORS-enabled
- `name` — display name / download filename
- `worldId` — opaque id echoed back with captures
- `lens` — focal length in mm (e.g. `75`)
- `sensor` — sensor width in mm as a number (e.g. `33.7`)

## Build & deploy

```bash
npm run build   # outputs dist/ with relative asset paths (base: "./")
```

Copy `dist/*` into the Caddy-served directory (e.g. `D:\Projects\AD\_viewer\` on OTOSERVE10).
No Caddyfile changes needed — the build uses relative paths and works as a drop-in under any subpath.

## Architecture invariant
`src/` must use **only relative imports + npm packages** — no `@/` or `next/`
imports — so the same source compiles under both this Vite root and the Next
`/viewer` route in node-banana.

## Sharing with node-banana (git subtree)

```bash
# pull viewer changes into node-banana
git subtree pull --prefix=src/splat-viewer https://github.com/gitcapoom/splat-viewer.git main --squash

# push node-banana edits back to this repo
git subtree push --prefix=src/splat-viewer https://github.com/gitcapoom/splat-viewer.git main
```
