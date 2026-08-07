# Node Banana (Capoom Fork)

A fork of [Shrimbly's Node Banana](https://github.com/shrimbly/node-banana) with additional nodes, features, and fixes for production use on a LAN-accessible workstation.

> **Upstream:** This fork tracks `shrimbly/node-banana` as the `upstream` remote. All additions are layered on top of the upstream feature set.

> **Architecture note (splat viewer):** The Gaussian Splat Viewer is a separate project ([`gitcapoom/splat-viewer`](https://github.com/gitcapoom/splat-viewer)) — a dependency, never embedded in this repo. Run **`npm run viewer:install`** to clone + build it into a gitignored `public/_viewer/` folder that `/viewer` serves directly; alternatively point `SPLAT_VIEWER_ORIGIN` at a hosted build to reverse-proxy it. See [Gaussian Splat Viewer setup](#gaussian-splat-viewer-optional).

![Node Banana Screenshot](public/node-banana.png)

---

## What's Different from Upstream

### New Nodes

| Node | Type | Description |
|------|------|-------------|
| **Video Input** | Input | Load video files (MP4, WebM) from disk with thumbnail preview and lazy playback |
| **Roto** | Process | Bezier/polygon shape roto editor producing mattes (full-screen Konva editor, invert toggle) |
| **Composite** | Process | Floating-point clone of Nuke's Merge node: 22 merge ops, per-input affine transforms, external BG/FG alpha pins, matte pin, premultiply/swap/opacity controls, per-input blur/defocus filters |
| **Blur** | Process | GPU blur with five filters (Gaussian, Box, Motion, Zoom, Spin), an optional matte input gating where the blur lands, invert + mix controls |
| **Color Grade** | Process | Nuke-style grade (blackpoint/whitepoint/lift/gain/multiply/offset/gamma) on the float GPU chain |
| **HSV Color Correct** | Process | Hue shift / saturation / value on the float GPU chain |
| **Contrast Adjust** | Process | S-curve contrast with roll-off and pivot on the float GPU chain |
| **Image Crop** | Process | Persistent relative-coordinate crop region with aspect lock |
| **Mirror** | Process | Horizontal / vertical flips |
| **Reformat** | Process | Resize to target resolution with fill/fit modes and filter choice |
| **Cube ⇄ Pano / Cube ⇄ Faces** | Process | Cubemap cross ↔ equirectangular, and cubemap ↔ six face images |
| **Pano Shift** | Process | Horizontal panorama shift with seam wrap-around |
| **Upscale (Grid)** | Generate | Grid-split upscaling through generator models |
| **Image to Splat** | Generate | Single image → 3D Gaussian Splat (feeds the splat viewer) |
| **Sphere Light Render** | Generate | Locally-rendered lit grey sphere from rotation/elevation/intensity (lighting reference) |
| **Video Compare** | Process | Side-by-side video comparison with three modes: Slide (wipe), Blend (opacity), and Difference (pixel diff). Synced playback with wait-for-both restart |
| **Image Compare** (enhanced) | Process | Added Blend and Difference modes with opacity control (upstream only has the slider) |
| **GLB Viewer** (enhanced) | Viewer | Three.js-based 3D model viewer with orbit controls, auto-rotation, background pin visibility toggle, and file persistence across workflow save/reload |
| **Gaussian Splat Viewer** (enhanced) | Viewer | Renamed from "SPZ Viewer". Added XYZ transform controls, camera animation timeline with keyframes, video export (H264/WebM), depth map capture (float-precision), and COLMAP export |
| **Output Node** (enhanced) | Output | Universal input handle accepting all media types. "Output Now" button for one-click export with sidecar JSON. Blob URL conversion for 3D files. Performance-optimized selectors |

### New Features

#### Float Color Pipeline
- Color Grade / HSV / Contrast / Blur / Composite chain through **16-bit float GPU textures** (WebGL2), so out-of-range values survive between nodes — no 8-bit clamp until the final consumer
- Live in-node GPU previews at 60 fps; 8-bit PNG committed only after sliders settle
- Composite inputs can each be pre-filtered (blur/defocus) before the merge, float-preserving

#### Dynamic Model Input Pins
- Generator nodes grow input pins from the selected model's schema (mask, control image, multiple image slots, etc.)
- Stable slot ids survive model switches and reloads; a single edge-conformance pass guarantees edges always match rendered pins (no ghost edges)

#### Reliability
- **Crash-safe workflow saves**: writes go to a temp file, fsync, then atomic rename; the previous good save is kept as a rolling `.bak`; the loader falls back to the `.bak` (with a warning toast) if the main file is ever corrupt
- Auto-save handles multi-hundred-MB media via chunked content hashing and URL-only handling for large provider videos
- Per-node runs re-execute cheap local processors upstream first, so generators never read stale inputs

#### Output Now (Export Pipeline)
- One-click export of any connected media (image, video, audio, 3D model) to a user-chosen directory
- Automatically generates a sidecar `.json` file containing the upstream workflow (trimmed of carousel history)
- Sidecar JSON can be re-imported by dragging onto the canvas, reconstructing the full upstream pipeline
- Blob URLs are converted to base64 client-side before saving (server can't fetch blob URLs)
- Workflow file stays small after export by externalizing all media fields

#### LAN / Network Access
- Server binds to `0.0.0.0` for LAN access from other machines
- `allowedDevOrigins` configured for cross-machine dev server access
- Network path hints (`\\server\share`) in project setup
- Web-based directory browser (replaced native OS picker for cross-network compatibility)
- Client-side `file://` URL opening with clipboard copy fallback for non-secure contexts

#### Cost Tracking
- Per-generation cost display on all generator nodes using fal.ai Cost Estimation API
- Session cost accumulator in the header
- Generate3D and GenerateAudio nodes included in workflow cost breakdown

#### Media Handling
- Videos and audio externalized during workflow save (keeps `.json` files small)
- 3D models and audio cleared from output node data on save
- Auto-restore of 3D models in GLB viewers after workflow reload
- `MediaOverlay` component for consistent video/image overlay viewing
- `mediaCapture` and `mediaStorage` utilities for thumbnail generation and disk persistence

#### WorldLabs Enhancements
- Panorama preview with azimuth dropdowns and standalone viewer URL
- Multi-image upload with azimuth metadata
- `is_pano` checkbox on World Generator node
- Auto-save SPZ and panorama files to generations folder
- SessionStorage quota fix for large panorama data

#### Panorama Pipeline
- Panorama Editor node with WebGL compositing
- Perspective crop capture from panorama viewer
- Focus viewer button and cleanup

### Bug Fixes (Beyond Upstream)

- **Replicate**: Polling timeout fix for queued predictions
- **Image display**: `object-contain` instead of `object-cover` (images fit, not fill)
- **Output node**: Fixed 5+ issues — folder creation, 3D input routing, reactive content detection, infinite loop from megabyte-length selector strings, invisible context menu edges (wrong handle IDs)
- **Edge routing**: Images through "universal" handle were silently dropped; fixed with `type === "image"` fallback
- **Workflow inflation**: Output node externalization now clears all media fields (was missing `model3d`, `audio`)
- **Sidecar JSON bloat**: `extractUpstreamWorkflow` trims `generate3d` carousel history
- **3D context menu**: Renamed "GLB Viewer" to "3D Viewer", removed "Gaussian Splat Viewer", added "Output"
- **Depth map artifacts**: Float render target, edge-preserving filter, morphological dilation, stochastic accumulation
- **Path handling**: Mixed path separators, stale project directory after settings change, UNC path image loading

### Removed from Upstream

- **Apple SHARP node** — replaced by `sharp-ml` on Replicate

---

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Node Editor**: @xyflow/react (React Flow v12)
- **Canvas**: Konva.js / react-konva
- **3D**: Three.js (GLB viewer, panorama viewer), @sparkjsdev/spark (Gaussian Splatting)
- **State Management**: Zustand
- **Styling**: Tailwind CSS
- **AI Providers**: Google Gemini, OpenAI, WorldLabs Marble, Replicate, fal.ai, Kie.ai, MuAPI, WaveSpeed

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Environment Variables

Create a `.env.local` file in the root directory:

```env
GEMINI_API_KEY=your_gemini_api_key
OPENAI_API_KEY=your_openai_api_key          # Optional, for OpenAI LLM provider
KIE_API_KEY=your_kie_api_key                # Optional, for Kie.ai models (Sora, Veo, Kling, etc.)
WORLDLABS_API_KEY=your_worldlabs_api_key    # Optional, for WorldLabs Marble 3D generation
REPLICATE_API_KEY=your_replicate_api_key    # Optional
FAL_API_KEY=your_fal_api_key                # Optional
MUAPI_API_KEY=your_muapi_api_key            # Optional, for MuAPI models
WAVESPEED_API_KEY=your_wavespeed_api_key    # Optional, for WaveSpeed models
# PORT=3001                                 # Optional, dev/prod server port (default 3000)
# SPLAT_VIEWER_ORIGIN=http://host:8080      # Optional, hosted splat-viewer build to proxy
                                            # (not needed if you run `npm run viewer:install`)
```

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser (or from another machine on the LAN). Set `PORT` in `.env.local` to change the port.

### Gaussian Splat Viewer (optional)

The `/viewer` page (Gaussian splat viewing, camera animation, video export) comes from the separate [`gitcapoom/splat-viewer`](https://github.com/gitcapoom/splat-viewer) project. It is a dependency — never embedded in this repo. One command installs it:

```bash
npm run viewer:install
```

This clones the viewer, builds it, and places the build in `public/_viewer/` (gitignored). Restart the dev server and `/viewer` serves it locally. Re-run the command any time to update. Requires `git` on PATH.

Alternative for multi-app setups: host one build anywhere and set `SPLAT_VIEWER_ORIGIN=http://host:port` — node-banana reverse-proxies it under its own origin. Everything else works without the viewer installed.

### Build

```bash
npm run build
npm run start
```

---

## Node Reference

### Input Nodes
| Node | Handles | Notes |
|------|---------|-------|
| Image Input | out: image | Load images from disk or paste |
| Audio Input | out: audio | Load audio files |
| Video Input | out: video | Load MP4/WebM, thumbnail preview |
| Prompt | out: text | Text prompt with variable support |
| Array | out: text | Array of text values |
| Prompt Constructor | in: text, out: text | Template with variable interpolation |

### Generator Nodes
| Node | Handles | Notes |
|------|---------|-------|
| Generate Image | in: image+text (+dynamic), out: image | Gemini, Replicate, fal.ai, Kie.ai, MuAPI, WaveSpeed. Extra pins appear from the selected model's schema (mask, control image, …) |
| Upscale (Grid) | in: image+text, out: image | Grid-split upscaling through generator models |
| Generate Video | in: image+text (+dynamic), out: video | Video generation from image+prompt |
| Generate 3D | in: image+text (+dynamic), out: 3d | 3D model generation |
| Image to Splat | in: image, out: 3d | Single image → Gaussian Splat |
| Generate Audio | in: text, out: audio | Audio/music generation |
| LLM Generate | in: text+image+video, out: text | Text generation (Gemini, OpenAI, Claude); video input analyzed by Gemini models only |
| Generate Panorama | in: image+text, out: image+text | WorldLabs Marble equirectangular pano |
| Generate World | in: image, out: 3d+image | WorldLabs Marble 3D Gaussian Splat world |
| Sphere Light Render | out: image | Locally-rendered lit sphere (lighting reference) |

### Process Nodes
| Node | Handles | Notes |
|------|---------|-------|
| Annotate | in: image, out: image | Drawing tools overlay |
| Pano Edit | in: image ×2 + text, out: image | Composite an edited perspective back onto an equirect pano |
| Mask Painter | in: image, out: image | Inpainting mask editor (brush/eraser/shapes, blur, invert) |
| Roto | in: image, out: image | Bezier/polygon roto shapes → matte |
| Composite | in: image ×5 (BG, BG α, FG, FG α, Matte), out: image | Nuke-style Merge: 22 ops, per-input transforms + blur/defocus filters, float pipeline |
| Blur | in: image + matte, out: image | Gaussian/Box/Motion/Zoom/Spin, matte-gated, mix control, float pipeline |
| Color Grade | in: image, out: image | Blackpoint/whitepoint/lift/gain/multiply/offset/gamma (float chain) |
| HSV Color Correct | in: image, out: image | Hue/saturation/value (float chain) |
| Contrast Adjust | in: image, out: image | S-curve contrast with roll-off + pivot (float chain) |
| Image Crop | in: image, out: image | Persistent relative crop region, aspect lock |
| Mirror | in: image, out: image | Horizontal/vertical flip |
| Reformat | in: image, out: image | Resize with fill/fit modes |
| Cube ⇄ Pano | in: image, out: image | Cubemap cross ↔ equirectangular |
| Cube ⇄ Faces | in/out: image ×6 | Cubemap ↔ six face images |
| Pano Shift | in: image, out: image | Horizontal shift with seam wrap |
| Split Grid | in: image, out: reference | Grid subdivision |
| Video Stitch | in: video+audio, out: video | Concatenate video clips |
| Video Trim | in: video, out: video | Trim video start/end |
| Ease Curve | in: video, out: video | Speed ramp with bezier curves |
| Frame Grab | in: video, out: image | Extract frame from video |
| Image Compare | in: image x2 | Slide, Blend, Difference modes |
| Video Compare | in: video x2 | Slide, Blend, Difference modes |

### Viewer Nodes
| Node | Handles | Notes |
|------|---------|-------|
| 3D Viewer (GLB) | in: 3d | Three.js orbit viewer, auto-rotation |
| Gaussian Splat Viewer | in: 3d | Opens the standalone splat viewer (`/viewer`): camera animation, DoF, lens distortion, video/depth export, COLMAP I/O |
| Pano Viewer | in: image | 360 panorama viewer; captures perspective crops |
| Pano Crop | auto-created | Perspective snapshot from the pano viewer, with camera metadata |

### Output Nodes
| Node | Handles | Notes |
|------|---------|-------|
| Output | in: universal | Export any media type with sidecar JSON |
| Output Gallery | in: image | Collect multiple images |

### Route Nodes
| Node | Handles | Notes |
|------|---------|-------|
| Router | in/out: any | Pass-through routing |
| Switch | in: any, out: switched | Toggle outputs |
| Conditional Switch | in: text, out: rule-based | Route by text matching |

---

## Example Workflows

The `/examples` directory contains example workflow files. To use them:

1. Start the dev server with `npm run dev`
2. Drag any `.json` file from `/examples` into the browser window
3. Review prompts before running — they're tuned for specific examples

---

## Testing

```bash
npm test              # Watch mode
npm run test:run      # Single run
npm run test:coverage # With coverage report
```

---

## License

MIT
