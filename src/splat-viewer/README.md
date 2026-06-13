# Splat Viewer

Standalone, client-only Gaussian Splat viewer (three.js + [`@sparkjsdev/spark`](https://www.npmjs.com/package/@sparkjsdev/spark)), driven entirely by URL params plus an optional same-origin `postMessage` capture-back.

This repo is the **source of truth** for the viewer. It is shared into
[`node-banana-capoom`](https://github.com/gitcapoom/node-banana-capoom) via `git subtree`
(prefix `src/splat-viewer`), where it is served same-origin at `/viewer`.

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
- `lens` — focal length in mm (e.g. `35`)
- `sensor` — sensor preset name (e.g. `Super 35mm`)

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
