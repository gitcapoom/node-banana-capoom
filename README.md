# Node Banana (Capoom Fork)

A fork of [Shrimbly's Node Banana](https://github.com/shrimbly/node-banana) with additional nodes, features, and fixes for production use on a LAN-accessible workstation.

> **Upstream:** This fork tracks `shrimbly/node-banana` as the `upstream` remote. All additions are layered on top of the upstream feature set.

![Node Banana Screenshot](public/node-banana.png)

---

## What's Different from Upstream

### New Nodes

| Node | Type | Description |
|------|------|-------------|
| **Video Input** | Input | Load video files (MP4, WebM) from disk with thumbnail preview and lazy playback |
| **Video Compare** | Process | Side-by-side video comparison with three modes: Slide (wipe), Blend (opacity), and Difference (pixel diff). Synced playback with wait-for-both restart |
| **Image Compare** (enhanced) | Process | Added Blend and Difference modes with opacity control (upstream only has the slider) |
| **GLB Viewer** (enhanced) | Viewer | Three.js-based 3D model viewer with orbit controls, auto-rotation, background pin visibility toggle, and file persistence across workflow save/reload |
| **Gaussian Splat Viewer** (enhanced) | Viewer | Renamed from "SPZ Viewer". Added XYZ transform controls, camera animation timeline with keyframes, video export (H264/WebM), depth map capture (float-precision), and COLMAP export |
| **Output Node** (enhanced) | Output | Universal input handle accepting all media types. "Output Now" button for one-click export with sidecar JSON. Blob URL conversion for 3D files. Performance-optimized selectors |

### New Features

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
- **AI Providers**: Google Gemini, OpenAI, WorldLabs Marble, Replicate, fal.ai, Kie.ai

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
```

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser (or from another machine on the LAN).

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
| Generate Image | in: image+text, out: image | Gemini, Replicate, fal.ai |
| Generate Video | in: image+text, out: video | Video generation from image+prompt |
| Generate 3D | in: image+text, out: 3d | 3D model generation |
| Generate Audio | in: text, out: audio | Audio/music generation |
| LLM Generate | in: text+image, out: text | Text generation (Gemini, OpenAI) |

### Process Nodes
| Node | Handles | Notes |
|------|---------|-------|
| Annotate | in: image, out: image | Drawing tools overlay |
| Mask Painter | in: image, out: image | Inpainting mask editor |
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
| GLB Viewer | in: 3d | Three.js orbit viewer, auto-rotation |
| Gaussian Splat Viewer | in: 3d | Spark.js splat viewer, camera animation, video export |
| Pano Viewer | in: image | 360 panorama viewer |
| Pano Editor | in: image | Panorama compositing |
| Pano Crop | in: image | Perspective crop from pano |

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
