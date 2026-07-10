# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run dev      # Start Next.js dev server at http://localhost:3000
npm run build    # Build for production
npm run start    # Start production server
npm run lint     # Run Next.js linting
npm run test     # Run all tests with Vitest (watch mode)
npm run test:run # Run all tests once (CI mode)
```

## Environment Setup

Create `.env.local` in the root directory:
```
GEMINI_API_KEY=your_gemini_api_key
OPENAI_API_KEY=your_openai_api_key    # Optional, for OpenAI LLM provider
KIE_API_KEY=your_kie_api_key          # Optional, for Kie.ai models (Sora, Veo, Kling, etc.)
WORLDLABS_API_KEY=your_worldlabs_key  # Optional, for WorldLabs Marble 3D generation
```

## Architecture Overview

Node Banana is a node-based visual workflow editor for AI image generation. Users drag nodes onto a React Flow canvas, connect them via typed handles, and execute pipelines that call AI APIs.

### Core Stack
- **Next.js 16** (App Router) with TypeScript
- **@xyflow/react** (React Flow) for the node editor canvas
- **Konva.js / react-konva** for canvas annotation & mask painting
- **Three.js** for 3D panorama viewer & SPZ Gaussian Splat rendering
- **@sparkjsdev/spark** for 3D Gaussian Splatting viewer
- **Zustand** for state management (single store pattern)

### Key Files

| Purpose | Location |
|---------|----------|
| Central workflow state & execution logic | `src/store/workflowStore.ts` |
| All TypeScript type definitions | `src/types/index.ts` |
| Main canvas component & connection validation | `src/components/WorkflowCanvas.tsx` |
| Base node component (shared by all nodes) | `src/components/nodes/BaseNode.tsx` |
| Image generation API route | `src/app/api/generate/route.ts` |
| LLM text generation API route | `src/app/api/llm/route.ts` |
| Cost calculations | `src/utils/costCalculator.ts` |
| Grid splitting utility | `src/utils/gridSplitter.ts` |
| Equirectangular projection math | `src/utils/equirectProjection.ts` |
| Cinema camera presets | `src/utils/cinemaCameraPresets.ts` |
| Mask painter types | `src/types/maskPainter.ts` |
| Mask painter state (Zustand) | `src/store/maskPainterStore.ts` |
| Full-screen mask editor modal | `src/components/MaskPainterModal.tsx` |
| WorldLabs API proxy | `src/app/api/worldlabs/route.ts` |
| WorldLabs shared utilities | `src/store/execution/worldLabsUtils.ts` |
| Panorama executor | `src/store/execution/worldLabsPanoExecutor.ts` |
| World generation executor | `src/store/execution/worldLabsWorldExecutor.ts` |
| Panorama compositing executor | `src/store/execution/panoEditorExecutor.ts` |

### State Management

All application state lives in `workflowStore.ts` using Zustand. Key patterns:
- `useWorkflowStore()` hook provides access to nodes, edges, and all actions
- `executeWorkflow(startFromNodeId?)` runs the pipeline via topological sort
- `getConnectedInputs(nodeId)` retrieves upstream data for a node
- `updateNodeData(nodeId, partialData)` updates node state
- Auto-save runs every 90 seconds when enabled

### Execution Flow

1. User clicks Run or presses `Cmd/Ctrl+Enter`
2. `executeWorkflow()` performs topological sort on node graph
3. Nodes execute in dependency order, calling APIs as needed
4. `getConnectedInputs()` provides upstream images/text to each node
5. Locked groups are skipped; pause edges halt execution

## AI Models & Providers

Image generation models (these exist and are recently released):
- `gemini-2.5-flash-image` → internal name: `nano-banana`
- `gemini-3-pro-image-preview` → internal name: `nano-banana-pro`

LLM models:
- Google: `gemini-2.5-flash`, `gemini-3-flash-preview`, `gemini-3-pro-preview`
- OpenAI: `gpt-4.1-mini`, `gpt-4.1-nano`

3D world generation (WorldLabs Marble API):
- `Marble 0.1-mini` — fast panorama generation (used by `worldLabsPano`)
- `Marble 0.1-plus` — high-quality 3D world generation (used by `worldLabsWorld`)

## Node Types

### Core Nodes

| Type | Purpose | Inputs | Outputs |
|------|---------|--------|---------|
| `imageInput` | Load/upload images | reference | image |
| `annotation` | Draw on images (Konva) | image | image |
| `prompt` | Text prompt input | none | text |
| `promptConstructor` | Template-based prompt builder | text (variables) | text |
| `nanoBanana` | AI image generation | image, text, dynamic | image |
| `generateVideo` | AI video generation | image, text | video |
| `generate3d` | AI 3D model generation | image, text | 3d |
| `generateAudio` | AI audio/TTS generation | text | audio |
| `llmGenerate` | AI text generation | text, image | text |
| `splitGrid` | Split image into grid cells | image | reference |
| `audioInput` | Load/upload audio files | audio | audio |
| `output` | Display final result | image | none |
| `outputGallery` | Display multiple results | image (multiple) | none |
| `imageCompare` | Side-by-side image comparison | image ×2 | none |

### Video Processing Nodes

| Type | Purpose | Inputs | Outputs |
|------|---------|--------|---------|
| `videoStitch` | Concatenate video clips | video (multiple) | video |
| `easeCurve` | Apply easing curves to video | video, easeCurve | video |
| `videoTrim` | Trim video start/end | video | video |
| `videoFrameGrab` | Extract frame from video | video | image |

### 3D & Panorama Nodes

| Type | Purpose | Inputs | Outputs |
|------|---------|--------|---------|
| `worldLabsPano` | Generate panorama (Marble API) | image, text | image, text |
| `worldLabsWorld` | Generate 3D world (Marble API) | image | 3d, image |
| `glbViewer` | Load/display 3D GLB models | none | image |
| `spzViewer` | View 3D Gaussian Splat files | 3d | image |
| `panoViewer` | Interactive panorama viewer | image | creates PanoCrop nodes |
| `panoCrop` | Perspective snapshot from pano | auto-created | image, text (metadata) |
| `panoEditor` | Composite edit back onto pano | image ×2, text | image |

### Mask & Utility Nodes

| Type | Purpose | Inputs | Outputs |
|------|---------|--------|---------|
| `maskPainter` | Paint inpainting masks (Konva) | image | image (mask) |

## Node Connection System

### Handle Types

| Handle Type | Data Format | Description |
|-------------|-------------|-------------|
| `image` | Base64 data URL | Visual content |
| `text` | String | Text content |
| `audio` | Base64 data URL | Audio content |
| `video` | Blob URL / data URL | Video content |
| `3d` | URL | 3D model data (SPZ, PLY, GLB) |
| `easeCurve` | Bezier handles | Easing function curve |

### Connection Rules

1. **Type Matching**: Handles only connect to matching types (`image`→`image`, `text`→`text`, `3d`→`3d`, etc.)
2. **Direction**: Connections flow from source (output) to target (input)
3. **Multiplicity**: Image inputs accept multiple connections; text inputs accept one
4. **Dynamic Handles**: Generator nodes create additional input handles based on the selected model's schema (e.g., mask, control image, depth map)

### Dynamic Model Input Handles

Generator nodes (`nanoBanana`, `generateVideo`, `generate3d`) dynamically create input handles based on the selected model's `inputSchema`. When a model is selected:
1. `ModelParameters` component fetches schema from `/api/models/{modelId}?provider={provider}`
2. Schema is cached in localStorage (`node-banana-schema-cache-v3`, 48-hour TTL)
3. Additional input handles appear on the node (e.g., `image-mask_url`, `image-control_image`)
4. Handle IDs follow the pattern `image-{schemaName}` for image inputs, `text-{index}` for text inputs
5. Connected inputs are routed to the correct API parameter via `dynamicInputs` in `getConnectedInputs()`

### Data Flow in `getConnectedInputs`

Returns `{ images, videos, audio, model3d, text, dynamicInputs, easeCurve }`.

**Image data extracted from:**
- `imageInput` → `data.image`
- `annotation` → `data.outputImage`
- `nanoBanana` → `data.outputImage`
- `videoFrameGrab` → `data.outputImage`
- `glbViewer` / `spzViewer` → `data.capturedImage`
- `worldLabsPano` → `data.panoUrl` or `data.thumbnailUrl`
- `worldLabsWorld` → `data.panoUrl` or `data.thumbnailUrl`
- `panoCrop` → `data.image`
- `panoEditor` → `data.outputImage`
- `maskPainter` → `data.outputMask`

**Text data extracted from:**
- `prompt` → `data.prompt`
- `promptConstructor` → `data.outputText`
- `llmGenerate` → `data.outputText`
- `worldLabsPano` → `data.caption` (via `text` handle)
- `panoCrop` → `data.metadata` (via `text` handle)

**Video data extracted from:**
- `generateVideo` → `data.outputVideo`
- `videoStitch` → `data.outputVideo`
- `easeCurve` → `data.outputVideo`
- `videoTrim` → `data.outputVideo`

**Audio data extracted from:**
- `audioInput` → `data.audioFile`
- `generateAudio` → `data.outputAudio`

**3D data extracted from:**
- `generate3d` → `data.output3dUrl`
- `worldLabsWorld` → `data.spzUrls` (via `3d` handle)

## Keyboard Shortcuts

- `Cmd/Ctrl + Enter` - Run workflow
- `Cmd/Ctrl + C/V` - Copy/paste nodes
- `Shift + P` - Add prompt node at center
- `Shift + I` - Add image input node
- `Shift + G` - Add generate (nanoBanana) node
- `Shift + V` - Add video (generateVideo) node
- `Shift + L` - Add LLM node
- `Shift + A` - Add annotation node
- `Shift + T` - Add audio (generateAudio) node
- `Shift + W` - Add panorama (worldLabsPano) node
- `H` - Stack selected nodes horizontally
- `V` - Stack selected nodes vertically
- `G` - Arrange selected nodes in grid
- `?` - Show keyboard shortcuts

## Adding New Node Types

1. Define the data interface in `src/types/index.ts`
2. Add to `NodeType` union in `src/types/index.ts`
3. Create default data in `createDefaultNodeData()` in `workflowStore.ts`
4. Add dimensions to `defaultDimensions` in `workflowStore.ts`
5. Create the component in `src/components/nodes/`
6. Export from `src/components/nodes/index.ts`
7. Register in `nodeTypes` in `WorkflowCanvas.tsx`
8. Add minimap color in `WorkflowCanvas.tsx`
9. Update `getConnectedInputs()` if the node produces consumable output
10. Add execution logic in `executeWorkflow()` if the node requires processing
11. Update `ConnectionDropMenu.tsx` to include the node in source/target lists

### Handle Naming Convention

Use descriptive handle IDs matching the data type:
- `id="image"` for primary image data
- `id="image-{name}"` for dynamic/named image inputs (e.g., `image-mask_url`, `image-control_image`)
- `id="text"` for text data
- `id="3d"` for 3D model data
- `id="video"` for video data
- `id="audio"` for audio data
- `id="easeCurve"` for easing curve data

### Validation

- Connection validation: `isValidConnection()` in `WorkflowCanvas.tsx`
- Workflow validation: `validateWorkflow()` in `workflowStore.ts`

## Adding New Kie.ai Models (SOP)

Reference docs: https://docs.kie.ai/llms.txt lists all available model API pages.

### Step 1: Gather API Details
Visit the model's doc page on https://docs.kie.ai/ and collect:
- Model ID(s) (the `model` param sent to the API)
- Capabilities: text-to-image, image-to-image, text-to-video, image-to-video
- API endpoint (standard: `/api/v1/jobs/createTask`, or model-specific like Veo's `/api/v1/veo/generate`)
- All input parameters: name, type, enum values, defaults, required status
- Image/video input parameter name (e.g., `image_urls`, `imageUrls`, `input_urls`)
- Polling endpoint (standard: `/api/v1/jobs/recordInfo`, or model-specific)
- Response format and status field names
- Pricing (per-run cost if available)

### Step 2: Add Model Registry Entry
**File:** `src/app/api/models/route.ts` — Add to `KIE_MODELS` array.
Each model entry needs: `id`, `name`, `description`, `provider: "kie"`, `capabilities`, `pricing`, `pageUrl`.
Use separate entries for each capability variant (e.g., `model/text-to-video` and `model/image-to-video`).

### Step 3: Add Parameter Schema
**File:** `src/app/api/models/[modelId]/route.ts` — Add to `getKieSchema()`.
Define `parameters` (user-configurable settings) and `inputs` (connectable handles like prompt, images).

### Step 4: Add Default Parameters
**File:** `src/app/api/generate/route.ts` — Add case to `getKieModelDefaults()`.
Provide required defaults that must be present even if the user doesn't set them.

### Step 5: Add Image Input Key Mapping
**File:** `src/app/api/generate/route.ts` — Add to `getKieImageInputKey()`.
Map the model to its correct image parameter name if it differs from the default `image_urls`.

### Step 6: Handle Non-Standard API (if applicable)
If the model uses different endpoints than `/api/v1/jobs/createTask` and `/api/v1/jobs/recordInfo`:
- Add a detection function (e.g., `isVeoModel()`)
- Add a model-ID-to-API-model mapping function
- Add a custom polling function for the model's status endpoint
- Add a branch in `generateWithKie()` for the custom request format

## API Routes

All routes in `src/app/api/`:

| Route | Timeout | Purpose |
|-------|---------|---------|
| `/api/generate` | 5 min | Image/video/3D generation via Gemini or Kie.ai |
| `/api/llm` | 1 min | Text generation (Google/OpenAI) |
| `/api/worldlabs` | 5 min | WorldLabs Marble API: upload, generate, poll, getWorld |
| `/api/models` | default | List available models and providers |
| `/api/models/[modelId]` | default | Get model parameter schema |
| `/api/workflow` | default | Save/load workflow files |
| `/api/save-generation` | default | Auto-save generated images |
| `/api/open-directory` | default | Open native OS file explorer at path |
| `/api/browse-directory` | default | Open native OS folder picker dialog |
| `/api/open-file` | default | Reveal file in OS explorer (localhost only) |
| `/api/logs` | default | Session logging |

### Standalone Pages

| Route | Purpose |
|-------|---------|
| `/viewer` | SPZ/PLY 3D Gaussian Splatting viewer (URL param or file upload) |
| `/viewer/[worldId]` | World-specific 3D viewer |
| `/viewer/pano` | Equirectangular panorama viewer with perspective crop capture |

## Splat Viewer (`src/splat-viewer/`)

A standalone Vite + React + Three.js app vendored into node-banana as a **git subtree**, served at `/viewer`. The source of truth is the separate repo **[gitcapoom/splat-viewer](https://github.com/gitcapoom/splat-viewer)** — `src/splat-viewer/` here is a squashed mirror of it.

### Architecture invariant

Everything under `src/splat-viewer/src/` must use **only relative imports (`./…`, `../…`) and npm-package imports** — never `@/…` aliases and never `next/…` imports. This is what lets the same source compile under both Vite (standalone viewer) and Next.js (embedded in node-banana). A single `@/` or `next/` import will break one of the two builds. There is a viewer-local copy of some shared modules (e.g. `src/splat-viewer/src/lib/cinemaCameraPresets.ts` duplicates the repo-root `src/utils/cinemaCameraPresets.ts`) precisely to preserve this isolation — keep them in sync manually when the math changes.

### IMPORTANT — subtree workflow

- **All viewer code changes happen in the gitcapoom/splat-viewer repo**, not here.
- Pull updates into node-banana with:
  ```bash
  git subtree pull --prefix=src/splat-viewer https://github.com/gitcapoom/splat-viewer.git main --squash
  ```
- **Never edit `src/splat-viewer/` directly inside node-banana** — local edits will be clobbered by the next subtree pull and diverge from the source of truth.
- **Never `git subtree push`** — it walks the full repository history and times out. Push changes to gitcapoom/splat-viewer through that repo's own working copy, then pull them here.

### Features

**Loading**
- Loads Gaussian splats (`.spz`, `.ply`) and polygon meshes (`.glb`, `.obj`).
- Input via drag-and-drop, file picker, or URL parameter.

**Camera optics & cinema presets**
- Physically-based camera: horizontal FOV = `2·atan(sensorWidth/(2·focal))`; vertical FOV (Three.js `camera.fov`) = `2·atan(tan(hFOV/2)/aspect)`.
- Sensor presets (7): Super 35mm (default), Full Frame, ARRI Alexa LF, RED Monstro VV, IMAX 65mm, Micro Four Thirds, APS-C.
- Lens focal lengths (13 primes): 14/18/21/24/28/35 (default)/40/50/75/85/100/135/200 mm.
- Aspect-ratio presets (6): 2.39:1 Scope, 1.85:1 Flat, 16:9 (default), 4:3, 1.43:1 IMAX, 1:1 Square.
- UI label helpers `getCameraSummary()` and `getCameraFilenameSegment()`.

**Navigation & scene helpers**
- Fly mode (WASD + Q/E up/down, Shift boost, mouse-look) and Orbit mode; toggle with `F`. Frame button re-fits to the splat; ground-grid and origin-axes toggles.
- Camera reset (restores the exact load-time pose), adjustable far-clip plane (auto `distance × 1000`), camera-scale slider (cm↔m), and a coordinate-system selector.
- Screenshot capture of the current view (button-only; optional same-origin `postMessage` capture-back for node-banana).

**Scene management panel (`MeshPanel.tsx`)** — floating three-tab card (Meshes / Lights / IBL, each with live counts):
- *Meshes*: add `.glb`/`.obj` (button or drop), per-row visibility, select, "always on top" overlay toggle (draw-through vs clip behind splat), expand, delete; expanded row exposes Position XYZ, Rotation° XYZ, single uniform Scale (min 0.0001), and "Capture IBL from mesh".
- *Gizmo toolbar* (when selected): Translate/Rotate/Scale (T/R/S) + World/Local (W/L) space toggle.
- *Lights*: add Point / Spot / Rect; common controls Color, Intensity (0–100), Position XYZ. Spot adds Move Light/Target selector, lock-together, Target XYZ, Angle° (1–89), Penumbra (0–1). Rect adds Width/Height (min 0.1), Rotation° XYZ.
- *IBL*: image-based-lighting probes captured from a mesh or at the camera; per-probe Position XYZ, Radius (0–50, `0` = ∞ global), Ramp falloff (finite radius only), Intensity (0–5), and Lift/Gain/Gamma HDR color-grade sliders (negative-capable).
- `MeshPanel` is a pure controlled component — all state lives in the parent `SplatViewer.tsx`; inputs carry `nodrag nopan`.

**Keyframe animation timeline (`Timeline.tsx` + `cameraAnimation.ts`)**
- Per-keyframe camera position (Vector3) + rotation (Quaternion) + vertical FOV, at a normalized time in [0,1].
- Per-segment interpolation mode keyed off the segment's **starting** keyframe: step / linear / easeInOut / smooth. Position uses Catmull-Rom spline (smooth/easeInOut) or lerp; rotation always SLERP; FOV lerp.
- Full per-keyframe `SceneSnapshot` (splat/mesh/light/IBL transforms, visibility, orbit target) animates geometry alongside the camera; `evaluateSceneAtFrame` is backward-compatible (returns null for camera-only/legacy saves). IBLs are serialized but **not** applied live during playback (too costly per frame).
- Canvas timeline (DPR-aware, ResizeObserver): scrub, drag keyframe diamonds, select; play/stop, loop, prev/next keyframe, add/delete keyframe; editable duration (min 2, max 9999 frames) and FPS dropdown (12/24/25/30/60). JSON serialize/deserialize (tolerant of legacy object forms).
- Keyboard: `K` add keyframe, `Del`/`Backspace` delete selected, `T` toggle timeline, `H` toggle panels, `Ctrl/Cmd+Z` undo.

**Depth of field**
- Real-time thin-lens circle-of-confusion post-pass driven by live aperture/focus/sensor settings; scatter-as-gather weighting, 24-tap golden-angle Vogel disk; `showCoC` debug heatmap. Also bakeable per-frame during export. On/Off toggle + Reset in the Camera panel.

**Lens distortion**
- Forward Brown-Conrady (OpenCV) post-pass via inverse mapping (5 Newton iterations); radial `k1,k2` + tangential `p1,p2` (no `k3`/fisheye). Out-of-bounds samples rendered opaque black. `computeFovMargin()` estimates extra FOV coverage (capped ×2), overridden by measured `DISTORTION_SCALE` when present. On/Off toggle + Reset in the Camera panel.

**Video / depth export (`ExportDialog` + `videoExport.ts`)**
- Camera-path export animating along keyframes; output modes RGB / Depth / Both.
- Resolutions 1280×720, 1920×1080 (default), 3840×2160; FPS 12/24/25/30/60; frame count (min 2, max 9999) with live duration readout.
- Quality presets (all H.264): 20 Mbps (default) / 50 Mbps HQ / 100 Mbps Max.
- Optional Bake DoF pass (off by default, ~1× extra render cost) and lens-distortion post-pass.
- Encoders: WebCodecs `VideoEncoder` + mp4-muxer (avc1.640028, keyframe every 2 s), automatic fallback to MediaRecorder. Global depth-range scan for consistent depth normalization, even-dimension enforcement, full camera-state restore, WebGL vertical flip on read-back. Requires ≥2 keyframes and >0 frames (enforced in UI and backend).

**COLMAP import / export (`colmapIO.ts`)**
- Export: `cameras.txt` + `images.txt` + empty `points3D.txt` zipped via JSZip (shared PINHOLE camera, per-frame `R_w2c`/`t` poses, `frame_NNNNN.png` names) — interoperable with COLMAP / 3DGS trainers / NerfStudio.
- Import: reads `cameras.txt` + `images.txt` (+ optional Nodos `extras.txt` sidecar) into a `CameraPath`, one keyframe per pose (sorted by IMAGE_ID, times uniform over [0,1]); derives FOV from intrinsics (fallback 60°). Parses PINHOLE/SIMPLE_PINHOLE/OPENCV/RADIAL/SIMPLE_RADIAL, extracts `k1,k2,p1,p2` and `DISTORTION_SCALE`.
- World-frame conventions: y-up (identity), y-down (Rx 180°, **default**, raw COLMAP/OpenCV), z-up (Rx −90°, Blender/Unreal). Camera-axis change RDF↔RUB via `D = diag(1,-1,-1)`.

### Build & deploy (OTOSERVE10 Caddy)

```bash
cd src/splat-viewer
npm install
npm run build        # Vite build with base "./"
```

Copy the built `dist/*` to `D:\Projects\AD\_viewer\` on **OTOSERVE10**. Served at **http://OTOSERVE10:8080/_viewer/**. No Caddyfile changes needed — the relative-path build is a drop-in under any subpath.

## WorldLabs Integration

The WorldLabs Marble API enables 3D world generation from images and text. The workflow is split into two node types:

### Panorama Pipeline
1. **WorldLabsPano** → generates an equirectangular panorama (fast, Marble 0.1-mini)
2. **PanoViewer** → opens interactive panorama viewer, user captures perspective crops
3. **PanoCrop** → holds captured perspective snapshots with camera metadata (auto-created by PanoViewer)
4. Image edits on crops (via nanoBanana or annotation)
5. **PanoEditor** → composites edited perspective back onto the equirectangular panorama (WebGL shader)
6. **WorldLabsWorld** → generates full 3D Gaussian Splat world from final panorama (Marble 0.1-plus)
7. **SpzViewer** → opens standalone Spark.js viewer for the 3D world

### Key Architecture Details
- **API proxy**: `src/app/api/worldlabs/route.ts` handles image upload (2-step signed URL), generation, polling, and world retrieval
- **Executors**: `worldLabsPanoExecutor.ts` and `worldLabsWorldExecutor.ts` in `src/store/execution/`
- **Panorama math**: `src/utils/equirectProjection.ts` provides `extractPerspectiveView()` and `compositeOntoEquirect()` for perspective↔equirectangular projection
- **Viewer communication**: Standalone viewer pages use `postMessage` to send captures back to the main canvas, which creates ImageInput or PanoCrop nodes
- **Large data transfer**: Pano data URLs are passed to viewer pages via `sessionStorage` to avoid URL length limits

### WorldLabs API Authentication
The API key is sent via `WLT-Api-Key` header. The route accepts either:
- `X-WorldLabs-Key` request header (from client)
- `WORLDLABS_API_KEY` environment variable

## Mask Painter

The mask painter provides inpainting mask creation with a full-screen Konva.js editor.

### Architecture
- **Node**: `MaskPainterNode.tsx` — displays source image and mask preview
- **Modal**: `MaskPainterModal.tsx` — full-screen painting interface
- **Store**: `maskPainterStore.ts` — Zustand store managing modal state, strokes, undo/redo history
- **Types**: `src/types/maskPainter.ts` — `MaskStroke`, `MaskRect`, `MaskCircle`, `MaskElement`, `MaskTool`

### Tools
- **Brush** — freehand drawing (white on black mask)
- **Eraser** — freehand erasing
- **Rectangle** — filled rectangle shapes
- **Circle** — filled circle/ellipse shapes

### Features
- Adjustable brush size
- Gaussian blur radius (applied as post-processing)
- Invert mask toggle (swap black/white)
- Undo/redo (Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z)
- Real-time CSS blur preview on overlay layer

### Connection to Generator Nodes
When a model schema includes a `mask` input (e.g., `mask_url`), generator nodes display a conditional mask input handle. The mask painter output connects to this handle, routing the mask image to the correct API parameter via `dynamicInputs`.

## localStorage Keys

- `node-banana-workflow-configs` - Project metadata (paths)
- `node-banana-workflow-costs` - Cost tracking per workflow
- `node-banana-nanoBanana-defaults` - Sticky generation settings (legacy)
- `node-banana-node-defaults` - Sticky defaults per node type (new format)
- `node-banana-schema-cache-v3` - Model parameter schema cache (48-hour TTL)

## Git Workflow

- The primary development branch is `develop`, NOT `main` or `master`
- Always checkout `develop` before creating feature branches: `git checkout develop`
- Create feature branches from `develop` using: `feature/<short-description>` or `fix/<short-description>`
- All PRs MUST target `develop`: use `gh pr create --base develop`
- Never push directly to `main`, `master`, or `develop`

## Commits
- Commit after each logical task or unit of work is complete. When implementing a multi-task plan, commit after finishing each task — do NOT batch all tasks into a single commit at the end.
- Each commit should be atomic and self-contained: one task = one commit.
- The .planning directory is untracked, do not attempt to commit any changes to the files in this directory.

