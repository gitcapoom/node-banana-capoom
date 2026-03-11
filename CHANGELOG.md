# Changelog

All notable changes to Node Banana will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.1.0] - 2026-03-12

### Added

- **Router, Switch & ConditionalSwitch Nodes** - Three new flow-control node types with toggle UI, rule editing, dynamic handles, and dimming integration
- **Gemini Veo Video Generation** - Veo 3.1 video models with full parameter support and error handling
- **Anthropic Claude LLM Provider** - Claude models available in LLM node alongside Gemini and OpenAI
- **Floating Node Headers** - Headers rendered via ViewportPortal with drag-to-move, hover controls, and Browse button
- **ControlPanel** - Centralized parameter editing panel with node-type routing and Run/Apply buttons
- **Full-Bleed Node Layouts** - All major nodes converted to edge-to-edge content with overlay controls
- **Inline Parameters** - Toggle to show model parameters directly on nodes with reactive sync
- **Video Autoplay** - useVideoAutoplay hook integrated into all 5 video node types
- **Inline Variable Highlights** - PromptConstructor highlights template variables inline
- **Minimap Navigation** - Click-to-navigate and scroll-to-zoom on minimap
- **Node Dimming System** - CSS-based visual dimming for disabled Switch/ConditionalSwitch paths
- **Unsaved Changes Warning** - Browser warns before closing tab with unsaved workflow
- **All Nodes Menu** - Floating action bar with All Nodes dropdown and All Models button
- **Provider Filter Icons** - ModelSearchDialog filters by available providers

- **WorldLabs 3D Integration**
  - Panorama Generator node using Marble 0.1-mini for fast equirectangular panorama generation
  - World Generator node using Marble 0.1-plus for full 3D Gaussian Splat world generation
  - WorldLabs API proxy route with signed URL image upload, generation polling, and world retrieval

- **Panorama Pipeline**
  - Panorama Viewer node with interactive perspective crop capture
  - Pano Crop node (auto-created by viewer) holding perspective snapshots with camera metadata
  - Panorama Editor node for compositing edited perspective crops back onto equirectangular panoramas via WebGL shaders
  - Equirectangular projection utilities for perspective-to-equirectangular conversion

- **Mask Painter**
  - Mask Painter node for creating inpainting masks
  - Full-screen mask editor modal with brush, eraser, rectangle, and circle tools
  - Adjustable brush size, Gaussian blur radius, and invert mask toggle
  - Undo/redo support
  - Conditional mask input handle on generator nodes when the selected model supports masking

- **SPZ Viewer**
  - SPZ Viewer node for viewing 3D Gaussian Splat files using Spark.js
  - Standalone viewer pages (/viewer for SPZ/PLY files, /viewer/pano for panoramas)
  - Cinema camera presets with sensor, lens, and aspect ratio choices
  - Capture functionality for extracting images from 3D scenes

- **Dynamic Model Input Handles** - Generator nodes automatically create additional input handles (mask, control image, depth map, etc.) based on the selected model's parameter schema

- **UI Improvements**
  - Reorganized floating action bar with Edit menu (Annotate, Pano Edit, Mask Paint) and Viewer menu (GLB Viewer, Pano Viewer, SPZ Viewer)
  - Reactive edge subscription for Annotation and Mask Painter nodes (update when connected after creation)

### Fixed

- Ease curve outputDuration passthrough through parent-child connections
- Canvas hover state suppressed during panning to prevent re-render cascading
- Node click-to-select failures caused by d3-drag dead zone
- Aspect-fit resize after manual resize aligns with React Flow dimension priority
- Settings panel seamless selection ring, background matching, and z-index layering
- ConditionalSwitch stale input, handle alignment, and text routing
- Veo negative prompt connectable as text handle, error handling, image validation
- API headers scoped to active provider, temperature falsy bug fixed
- Image flicker on settings toggle, presets popup dismiss, modal overlay click-through
- Node paste height compounding, group label anchoring, file input backdrop issues
- Handle visibility on full-bleed and OutputNode, clipped handle resolution
- FloatingNodeHeader width tracking, right-alignment, and Windows drag interception
- Smart cascade made type-aware so text inputs don't rescue dimmed image paths
- RouterNode auto-resize, handle colors, and placeholder styling

### Changed

- EaseCurveNode, SplitGridNode, Generate3DControls, GenerateVideoControls refactored to full-bleed patterns
- ConditionalSwitch execution logic deduplicated with shared evaluateRule utility
- ModelParameters collapsible toggle removed

### Performance

- Selective Zustand subscriptions replace bare useWorkflowStore() calls
- RAF-debounced setHoveredNodeId and BaseNode ResizeObserver
- Edge rendering optimized for large canvases
- FloatingNodeHeader, InlineParameterPanel, ModelParameters wrapped in React.memo
- useShallow for WorkflowCanvas store subscription
- Narrow selectors for ControlPanel and GroupControlsOverlay

### Tests

- Removed redundant and brittle component tests (-1,958 lines)
- Updated assertions for full-bleed nodes, floating action bar, and Gemini video

### Other

- Added MIT license
- Handle diameter increased from 10px to 14px
- Settings redesigned with pill tabs, segmented controls, and toggles
- Multi-layer box-shadow for smooth settings panel shadow

## [1.0.0] - Initial Release

### Added

- Visual node editor with drag-and-drop canvas
- Image Input node for loading images
- Prompt node for text input
- Annotation node with full-screen drawing tools (rectangles, circles, arrows, freehand, text)
- NanoBanana node for AI image generation using Gemini
- LLM Generate node for text generation (Gemini and OpenAI)
- Output node for displaying results
- Workflow save/load as JSON files
- Connection validation (image-to-image, text-to-text)
- Multi-image input support for generation nodes
