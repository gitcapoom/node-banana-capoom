# Splat Viewer

Standalone, client-only Gaussian Splat viewer (three.js + [`@sparkjsdev/spark`](https://www.npmjs.com/package/@sparkjsdev/spark)), driven by URL params plus an optional same-origin `postMessage` capture-back. Everything runs in the browser — no server-side rendering, no upload of splat data.

This repo is the **source of truth** for the viewer. It is shared into
[`node-banana-capoom`](https://github.com/gitcapoom/node-banana-capoom) via `git subtree`
(prefix `src/splat-viewer`), where it is served same-origin at `/viewer`.

## Features

### Loading & files
- **SPZ / PLY splat loading** — drag-drop, file picker, or `?url=` param (URL must be CORS-enabled).
- **GLB / OBJ mesh loading** — add polygonal meshes into the splat scene via the Scene panel's `+ Add Mesh (.glb / .obj)` button or by dragging files onto the panel.
- **Scene save / load** — a modal `FileDialog` reads and writes scene `.json` files through `/api/list-directory`:
  - Two modes: **Save** (returns directory + filename) and **Open** (returns an absolute file path); header reads *Save scene* / *Open scene*.
  - Editable path input with a **Go** button, a parent-folder (**up**) button, and a live directory listing.
  - Listing shows folders first (yellow folder icon) then files (file icon); files are filtered to the configured extension (default `.json`). Clicking a directory navigates into it.
  - **Open**: single-click selects (indigo highlight), double-click opens immediately, or confirm with **Open** (disabled until a file is selected).
  - **Save**: clicking an existing file reuses its base name; a `Name:` field (with the fixed extension suffix shown) sets the filename; Enter or **Save** confirms (disabled if blank).
  - Loading spinner while listing; error state with a *Go to home directory* fallback link; *Empty folder* message; current path shown in the footer (monospace, truncated).
  - Dismiss via backdrop click, **Escape**, or **Cancel**. Handles both Windows (`\`) and POSIX (`/`) separators, auto-detecting and normalizing trailing slashes.

### Camera & optics (cinema presets)
- **Sensor presets (7):** Super 35mm `24.89×18.66` (default), Full Frame `36.0×24.0`, ARRI Alexa LF `36.70×25.54`, RED Monstro VV `40.96×21.60`, IMAX 65mm `70.41×52.63`, Micro Four Thirds `17.30×13.0`, APS-C `23.60×15.60` (mm).
- **Lens focal lengths (13 primes):** 14, 18, 21, 24, 28, **35** (default), 40, 50, 75, 85, 100, 135, 200 mm.
- **Aspect-ratio presets (6):** 2.39:1 Scope, 1.85:1 Flat, **16:9** (default), 4:3, 1.43:1 IMAX, 1:1 Square.
- **FOV math:** horizontal FOV = `2·atan(sensorWidth / (2·focal))`; the Three.js camera vertical FOV = `2·atan(tan(hFOV/2) / aspect)`.
- **Summary/filename helpers:** `getCameraSummary()` (e.g. *"ARRI Alexa LF · 85mm · 2.39:1 Scope · 15.2° vFOV"*) and `getCameraFilenameSegment()` (e.g. `Super35mm_35mm`).
- **Camera Reset** — one-click restore to the exact pose the camera had when the file loaded.
- **Far clip control** — manual override for the camera far plane (fixes black sky on large splats). Auto default is `distance × 1000`.
- **Camera scale** — log slider (0.001 → 1000) that multiplies camera-track translations so a cm-scale COLMAP pairs with a metre-scale splat without resizing the splat (pure translation rescale). Reset (↺) returns to 1.0.
- **Coordinate system** — dropdown selecting the capture's world-frame convention (COLMAP/OpenCV Y-down, glTF Y-up, Blender Z-up). Applied to imported/exported COLMAP tracks and to PLY splats at load (SPZ uses its embedded metadata).

### Navigation
- **Fly mode** (default) — WASD to move, **Q/E** down/up, **Shift** for a ~3× speed boost, mouse-drag to look. Roll is preserved so restored/scrubbed poses keep their full orientation.
- **Orbit mode** — click-drag to orbit around the target, with damping. Toggle Fly ⇄ Orbit with **F** or the Nav buttons.
- **Frame** — re-fit the camera to the splat's bounding box (SuperSplat-style ¾ view).
- **Ground grid** and **origin axes** (X red / Y green / Z blue) toggles.

### Scene helpers, meshes & lights
The floating **Scene panel** (MeshPanel) is a scrollable dark card with three tabs, each showing a live count: **Meshes (N)**, **Lights (N)**, **IBL (N)**.

**Meshes tab**
- Add via footer `+ Add Mesh (.glb / .obj)` or drag-drop (empty state: *Drop .glb / .obj or click Add*).
- Each row: visibility eye toggle, clickable name (selects the mesh), an **always-on-top** overlay toggle, an expand chevron, and a delete (**X**) button.
- **Always-on-top** overlay: ON draws the mesh through/over the splat (amber icon); OFF clips it behind the splat.
- Selecting a mesh highlights the row (indigo border) and reveals the gizmo mode/space bar.
- Expanded row transform controls: **Position** X/Y/Z, **Rotation°** X/Y/Z (step 1), and a single uniform **Scale** input (clamped ≥ 0.0001, step 0.1).
- **Capture IBL from mesh** — captures a 360° image-based-lighting probe from the mesh center and adds it to the IBL list.

**Gizmo toolbar** (shown only when something is selected)
- Mode buttons: **Translate / Rotate / Scale** (T/R/S; active = indigo).
- Space toggle: **World (W)** vs **Local (L)** (Local shown amber).

**Lights tab**
- Add via footer buttons: **Point / Spot / Rect** (empty state: *No lights yet*).
- Each row: visibility eye toggle, name + type label, expand chevron, delete (**X**); selectable (indigo border when selected).
- Common expanded controls: **Color** picker, **Intensity** slider (0–100, step 0.5, value shown), and **Position** X/Y/Z.
- **Spot** extras: **Move Light** vs **Move Target** selector (chooses which the gizmo affects), a **Move light + target together** lock checkbox, **Target** X/Y/Z, **Angle°** slider (1–89°, radian-converted), **Penumbra** slider (0–1, step 0.05).
- **Rect** (area) extras: **Width** / **Height** inputs (each clamped ≥ 0.1) and **Rotation°** X/Y/Z (step 1).

**IBL tab**
- Lists captured image-based-lighting probes; footer `+ Capture IBL at Camera` captures a 360° probe from the current camera position (empty state: *No IBLs yet. Capture from mesh or camera.*).
- Each row: visibility eye toggle, name, expand chevron, delete (**X**).
- Expanded controls: **Position** X/Y/Z; **Radius** slider (0–50, step 0.5; `0` displays as **∞** = infinite/global); **Ramp** slider (0–1, shown only when radius > 0) for falloff; **Intensity** slider (0–5, step 0.05).
- **HDR color grade:** negative-capable **Lift** (−2…2), **Gain** (−2…10), and **Gamma** (0.1…5) sliders, each paired with a numeric input.

> Inputs use raw-string local state so you can type intermediate/negative values (`-`, `1.`) before parsing; values display rounded to 3 decimals. All controls carry `nodrag nopan` so slider/keyboard interaction never pans or drags the underlying canvas node.

### Animation & timeline (keyframe camera system)
- **Keyframes** store camera position (Vector3), rotation (Quaternion), and vertical FOV (degrees) at a normalized time in `[0,1]`.
- **Per-keyframe interpolation mode** (applies to the segment *starting* at that keyframe): **step**, **linear**, **easeInOut**, **smooth**.
- **Full scene-state snapshot per keyframe** (`SceneSnapshot`): splat transform, meshes (id/transform/visible), lights, IBLs, orbit target — so geometry, visibility, and lights animate alongside the camera.
- **Interpolation:**
  - Position: Catmull-Rom spline (smooth / easeInOut) using 4 control points with clamped-duplicate endpoints; straight-line lerp for linear / step.
  - Rotation: quaternion SLERP between the two bracketing keyframes (no cross-key spline smoothing).
  - FOV: linear lerp between bracketing keyframes.
  - `easeInOutCubic` applied to local segment time in easeInOut mode; step pins local time to 0 (holds start value); linear/smooth use raw local time.
- **Path evaluation** (`evaluateCameraPath`) clamps: first keyframe before range, last after range, single keyframe directly, `null` if none.
- **Scene evaluation** (`evaluateSceneAtFrame`) mirrors camera bracketing; returns `null` unless a keyframe carries scene data (backward-compatible with camera-only / older saves). Generic value interpolation: numbers lerp, booleans/non-color strings step, `#rrggbb` colors blend per channel, arrays/objects recurse, missing keys hold prior value; entities matched by id, unmatched entities held. *IBLs are captured and serialized but not applied live during playback (too expensive per-frame).*
- **Keyframe CRUD:** `addKeyframe` (replaces a keyframe within ~half-frame tolerance, re-sorts), `removeKeyframe`, `updateKeyframe` (partial merge + re-sort); cloning deep-copies position/quaternion but shares the scene snapshot by reference.
- **Serialization:** `serializePath` / `deserializePath` — position as `[x,y,z]`, quaternion as `[x,y,z,w]`; deserialization tolerant of legacy `{x,y,z}` / `{x,y,z,w}` object forms.
- **Helpers:** `frameToTime` / `timeToFrame` (clamped), `createEmptyPath` (default 120 frames @ 25 fps), `getPathDurationSeconds`.
- **Interactive canvas timeline:** device-pixel-ratio aware, `ResizeObserver`-driven redraw. Draws track background, auto-spaced frame ticks with labels, yellow keyframe diamonds (selected = orange with white outline), and a red playhead bar with triangle marker.
- **Playback controls:** play/stop toggle, loop toggle, previous/next keyframe (jump to nearest keyframe before/after current frame and select it), add keyframe, delete selected keyframe (disabled when none selected).
- **Scrubbing:** click/drag empty track to move the playhead. **Keyframe dragging:** drag a diamond to a new time (10px hit radius, topmost-first hit test).
- **Interpolation selector** (STEP / LIN / EASE / SMOOTH) shown only when a keyframe is selected (defaults to *smooth* when unset).
- **Duration input** (min 2, max 9999 frames), **FPS dropdown** (12 / 24 / 25 / 30 / 60), and live readout: `currentFrame / lastFrame · Xs` plus `N keys`.

### Post-processing effects (real-time)
Both effects live in the Camera panel with an **On/Off** toggle and a **Reset** button (zeroes the coefficients / restores defaults), and reveal their parameter controls only when enabled.

- **Depth-of-field** — thin-lens circle-of-confusion blur consuming a color texture and a linearized depth texture (R = Z metres, ≤ 0 = background).
  - Scatter-as-gather weighting prevents in-focus foreground bleeding onto blurred backgrounds.
  - 24-tap golden-angle Vogel-spiral disk sampler (`GOLDEN = 2.39996323`) with `sqrt(t)` radial mapping for uniform density; gather radius floored at 1px for cheap AA even in focus.
  - CoC model: `D = f/N`; `CoC_mm = f·D·|Z−S| / (Z·(S − f/1000))` reconciled to metres; `CoC_px = CoC_mm · pxPerMm`, clamped to `[0, maxBlurPx]`; singularity guard `denom = max(Z·(focusM − focalMm·0.001), 1e-4)` (clamp `focusM ≥ focalMm/1000 + ε`).
  - Uniforms: `focalMm` (50), `apertureMm` (50/2.8), `focusM` (3.0 m), `pxPerMm` (80 = passWidth/sensorWidthMm), `maxBlurPx` (60), `showCoC` toggle, `enabled` toggle.
  - **CoC debug overlay** (`showCoC`): heatmap of `|CoC_px|/maxBlurPx` — green at the focal plane → yellow → red at heavy defocus.
- **Lens distortion** — forward Brown-Conrady (OpenCV) via inverse mapping with 5 Newton iterations (sub-pixel accuracy for `k1 ≲ 0.5`).
  - Radial factor `1 + k1·r² + k2·r²²`; tangential `dx = 2·p1·u·v + p2·(r²+2u²)`, `dy = p1·(r²+2v²) + 2·p2·u·v`. Handles radial `k1,k2` + tangential `p1,p2` only (no `k3` / fisheye).
  - Out-of-bounds source samples render opaque black so the framing edge is unambiguous.
  - Uniforms: `fx`/`fy` (1000), `cx`/`cy` (0.5), `k1`/`k2`/`p1`/`p2` (0), `enabled` toggle.
  - `computeFovMargin()` estimates the extra FOV coverage a distortion pass needs by forward-distorting the worst image corner, returning a focal-length multiplier `≥ 1`, capped at 2.0 — superseded by a measured `DISTORTION_SCALE` when available.

### Video & depth export
Camera-path export animating the camera along keyframes via `evaluateCameraPath()`.
- **Output modes:** RGB only, Depth only, or Both (RGB + depth as two separate MP4 blobs in `VideoExportResult`).
- **Resolutions:** 1280×720 (HD), 1920×1080 (Full HD, default), 3840×2160 (4K).
- **FPS:** 12 / 24 / 25 / 30 / 60.
- **Total frame count:** user-set (min 2, max 9999) with live duration readout (`durationFrames / fps`).
- **Quality / codec presets (all H.264):** `H.264` 20 Mbps, `H.264 HQ` 50 Mbps, `H.264 Max` 100 Mbps (`DEFAULT_BITRATE` = 20 Mbps).
- **Bake DoF** — optional per-frame depth-of-field pass using the viewer's live aperture/focus/sensor settings; off by default (~1× extra splat-render cost per frame).
- **COLMAP camera data** toggle (`cameras.txt` + `images.txt`), on by default.
- **Dual encoder backends:** primary **WebCodecs** `VideoEncoder` + `mp4-muxer`, with automatic fallback to **MediaRecorder** if WebCodecs is unavailable or throws (logged via `console.warn`).
  - WebCodecs: MP4, codec `avc1.640028` (H.264 High L4.0), `latencyMode: "quality"`, keyframe every 2 s (`fps·2`).
  - MediaRecorder fallback: `captureStream(0)` with manual `requestFrame()` per frame and real-time pacing (`1000/fps` ms); MIME prefers MP4/`avc1` then falls through webm vp9/vp8.
- **Global depth-range scan:** when depth is needed, a first pass walks all frames to find global min/max depth so every depth frame normalizes against one consistent range.
- **Post-processing baked into export:** generic `postProcess.apply` (reused for both DoF and lens distortion) renders into `srcTarget` then a fullscreen quad into `dstTarget`; `postProcess.prepareCamera` adds per-frame FOV margin (restored after each frame).
- **Per-frame scene animation** via `applySceneAtFrame()` so splat/mesh/light transforms and visibility animate, not just the camera.
- **Progress** via `onProgress(frame, totalFrames)`, scaled across scan + render (+ encode) passes; UI shows a progress bar with *Rendering frame X/total* and percentage.
- **Robustness:** even-dimension enforcement (`ensureEvenDimension` — nearest lower even ≥ 2, returns 0 for non-finite/≤0); full camera-state restore in a `finally` block (position, quaternion, fov, aspect, renderer size) plus render-target disposal; WebGL vertical flip of read-back pixels (`flipVerticallyInto`); `safeReadPixels` unbinds any stray `PIXEL_PACK_BUFFER` before `readRenderTargetPixels`.
- **Preconditions:** ≥ 2 keyframes **and** `durationFrames > 0` — enforced in the UI (Export disabled, warning banner *"Add at least 2 keyframes before exporting"*) and in the backend (both encoders throw *"Need at least 2 keyframes and > 0 frames to export video"*).

### COLMAP import / export
- **Export:** writes the camera path as standard COLMAP `cameras.txt` + `images.txt` + empty `points3D.txt`, bundled in a ZIP (JSZip) — interoperable with COLMAP, 3DGS trainers, and NerfStudio.
  - Single shared **PINHOLE** camera: `focalLengthPx = (focalLengthMm/sensorWidthMm)·width`, `fx=fy=focalLengthPx`, `cx=width/2`, `cy=height/2`.
  - Per-frame `images.txt` line `IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME` (world→camera R and t) with an empty POINTS2D line after each; image names `frame_00000.png`; one image per `durationFrames`.
- **Import:** reads `cameras.txt` + `images.txt` (+ optional Nodos `extras.txt` sidecar) from a ZIP and produces a `CameraPath` — one keyframe per pose plus parsed intrinsics.
  - Per-keyframe FOV from intrinsics: `fov = 2·atan(height/(2·fy))` degrees (fallback 60° when intrinsics missing).
  - Poses sorted by `IMAGE_ID`; keyframe times distributed uniformly across `[0,1]`.
  - Parses camera models **PINHOLE, SIMPLE_PINHOLE, OPENCV, RADIAL, SIMPLE_RADIAL**; unrecognized models are skipped (best-effort fallback to PINHOLE defaults, distortion dropped).
  - Extracts Brown-Conrady coefficients: OPENCV → `k1,k2,p1,p2`; RADIAL → `k1,k2`; SIMPLE_RADIAL → `k1`.
  - Nodos `extras.txt`: reads `DISTORTION_SCALE` (column 6) into `cameraParams.distortionScale` as an authoritative FOV-margin multiplier overriding `k1/k2` estimation.
- **World-frame conventions** (both directions; inverse is the transpose):
  - `y-up` — identity (glTF / Three.js / Maya / Unity)
  - `y-down` — 180° about X (raw COLMAP / OpenCV / vanilla SfM) — **default** for import and export
  - `z-up` — −90° about X (Blender / Unreal / RealityCapture / Metashape)
  - COLMAP camera frame is spec-fixed RDF (+X right, +Y down, +Z forward); Three.js is RUB. The camera-axis change `D = diag(1,−1,−1)` (180° about X) is applied on the camera side in both directions.

### Capture (postMessage)
- **Screenshot capture** — aspect-ratio cropped, cinematic naming.
- Optional same-origin `postMessage` capture-back (used by node-banana to receive captures); `worldId` is echoed back with captures.

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

### Keyboard shortcuts
Viewer shortcuts are suppressed while typing in an input/select/textarea.

- `W` `A` `S` `D` — move (Fly mode); `Q` / `E` — down / up; `Shift` — speed boost; mouse-drag — look
- `F` — toggle Fly ⇄ Orbit navigation
- `H` — show / hide the controls panels
- `T` — show / hide the timeline
- `K` — add keyframe
- `Del` / `Backspace` — delete the selected keyframe
- `Ctrl/Cmd + Z` — undo (scene/keyframe edits)
- `Escape` — cancel/close the file dialog
- `Enter` (path input) — navigate to the typed path; `Enter` (save Name field) — confirm save
- Double-click a file (open mode) — open it immediately

> Capture/screenshot is button-only — there is no keyboard shortcut for it.

## Build

```bash
npm run build   # outputs dist/ with relative asset paths (base: "./")
```

The build is self-contained and path-relative, so `dist/` can be served from any static host, including under an arbitrary subpath. Keep `base: "./"` in `vite.config.ts` for subpath hosting to work.

## Architecture invariant
`src/` must use **only relative imports + npm packages** — no `@/` or `next/`
imports — so the same source compiles under both this Vite root and the Next
`/viewer` route in node-banana. The `FileDialog` and the viewer-local
`cinemaCameraPresets.ts` are deliberately self-contained copies for this reason.

## Sharing with node-banana (git subtree)

```bash
# pull viewer changes into node-banana
git subtree pull --prefix=src/splat-viewer https://github.com/gitcapoom/splat-viewer.git main --squash

# push node-banana edits back to this repo
git subtree push --prefix=src/splat-viewer https://github.com/gitcapoom/splat-viewer.git main
```
