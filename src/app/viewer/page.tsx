"use client";

/**
 * Standalone SPZ Viewer
 *
 * Loads and displays 3D Gaussian Splatting (.spz) files.
 * Two modes:
 *   1. URL mode: ?url=https://...scene.spz → loads SPZ directly
 *   2. Upload mode: no URL → shows file upload / drag-and-drop
 *
 * Features:
 *   - Cinematic camera presets (sensor/lens/aspect)
 *   - Screenshot capture → sends to parent window or downloads
 *   - Quality-agnostic (single URL, no quality switching)
 *   - Fly mode (WASD + mouse look) and Orbit mode (OrbitControls)
 */

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  SENSOR_PRESETS,
  LENS_FOCAL_LENGTHS,
  ASPECT_RATIO_PRESETS,
  DEFAULT_SENSOR_INDEX,
  DEFAULT_LENS_INDEX,
  DEFAULT_ASPECT_RATIO_INDEX,
  calculateCameraFOV,
  getCameraFilenameSegment,
} from "@/utils/cinemaCameraPresets";
import type { CameraPath, CameraKeyframe, InterpolationMode } from "./cameraAnimation";
import {
  createEmptyPath,
  addKeyframe,
  removeKeyframe,
  updateKeyframe,
  evaluateCameraPath,
  frameToTime,
} from "./cameraAnimation";
import { exportColmap, importColmap } from "./colmapIO";
import { createDistortionPass, computeFovMargin } from "./distortionShader";
import { exportVideo } from "./videoExport";
import type { ExportSettings } from "./ExportDialog";
import Timeline from "./Timeline";
import ExportDialog from "./ExportDialog";

// ─── Helpers ────────────────────────────────────────────────────

/** Trigger a browser download for a Blob */
function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

interface SavedMeshState {
  mesh: THREE.Mesh;
  onBeforeRender: typeof THREE.Object3D.prototype.onBeforeRender;
  depthWrite: boolean;
  transparent: boolean;
  stochastic: boolean | null; // Spark.js stochastic uniform (null if not a Spark mesh)
  timeValue: number | null;   // Spark.js time uniform (null if not a Spark mesh)
  minAlpha: number | null;    // Spark.js minAlpha uniform (null if not a Spark mesh)
}

/** Depth capture minAlpha — reject low-confidence splats that would appear as floaters. */
const DEPTH_MIN_ALPHA = 0.15;

/**
 * Edge-preserving depth cleanup. Removes truly isolated floating splat pixels
 * without softening sharp depth edges (foreground/background boundaries).
 *
 * A pixel is only removed if it has NO neighbors at a similar depth — meaning
 * it's a lone floater in empty space, not part of a surface edge. Pixels at
 * depth discontinuities (e.g. building edges) are preserved because they have
 * same-surface neighbors on one side.
 *
 * @param data  Float32Array of RGBA pixels (R = linearized depth, -1 = background)
 * @param w     Image width
 * @param h     Image height
 */
function cleanDepthFloaters(data: Float32Array, w: number, h: number) {
  const src = new Float32Array(data);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      const center = src[idx];
      if (center < 0) continue; // skip background

      // Count neighbors at a similar depth (same surface)
      let similarCount = 0;
      const depthThreshold = center * 0.08; // 8% relative depth similarity
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dy === 0 && dx === 0) continue; // skip self
          const ni = ((y + dy) * w + (x + dx)) * 4;
          const nd = src[ni];
          if (nd >= 0 && Math.abs(nd - center) < depthThreshold) {
            similarCount++;
          }
        }
      }

      // Only remove if NO similar-depth neighbors (true isolated floater).
      // Edge pixels have similar-depth neighbors on the surface side → preserved.
      if (similarCount === 0) {
        data[idx] = -1;
      }
    }
  }
}

/**
 * Morphological dilation of depth values into adjacent background pixels.
 * At splat silhouette edges, gaps exist where no splat wrote depth. Each
 * iteration expands the foreground boundary by 1 pixel, filling with the
 * minimum (closest-to-camera) neighbor depth so background doesn't bleed
 * forward over foreground.
 */
function dilateDepth(data: Float32Array, w: number, h: number, iterations = 2) {
  for (let iter = 0; iter < iterations; iter++) {
    const src = new Float32Array(data);
    let filled = 0;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = (y * w + x) * 4;
        if (src[idx] >= 0) continue; // already has depth

        // Find the closest-to-camera (minimum) foreground neighbor
        let minDepth = Infinity;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dy === 0 && dx === 0) continue;
            const ni = ((y + dy) * w + (x + dx)) * 4;
            if (src[ni] >= 0 && src[ni] < minDepth) {
              minDepth = src[ni];
            }
          }
        }

        if (minDepth < Infinity) {
          data[idx] = minDepth;
          filled++;
        }
      }
    }

    if (filled === 0) break;
  }
}

/**
 * Force depthWrite on ALL meshes in a scene for a depth-capture render pass.
 *
 * Spark.js SplatMesh is an Object3D (not a Mesh) — the actual rendering is
 * done by SparkRenderer, a dynamically-created Mesh added to the scene.
 * SparkRenderer's onBeforeRender resets depthWrite every frame, so we must:
 *   1. Traverse the entire scene (not just splatMesh) to find SparkRenderer
 *   2. Temporarily disable onBeforeRender so it doesn't reset our override
 *   3. Force depthWrite=true & transparent=false on the material
 *   4. Enable stochastic mode so the shader does per-fragment alpha testing
 *      instead of writing full opaque depth for entire splat footprints
 *      (eliminates visible blob/disc artifacts at splat edges)
 *
 * Returns saved state array to pass to restoreSceneDepthWrite().
 */
function forceSceneDepthWrite(scene: THREE.Scene): SavedMeshState[] {
  const saved: SavedMeshState[] = [];
  scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.material) {
      const mat = mesh.material as THREE.ShaderMaterial;
      const hasStochastic = mat.uniforms?.stochastic !== undefined;
      const hasTime = mat.uniforms?.time !== undefined;
      const hasMinAlpha = mat.uniforms?.minAlpha !== undefined;
      saved.push({
        mesh,
        onBeforeRender: mesh.onBeforeRender,
        depthWrite: mat.depthWrite,
        transparent: mat.transparent,
        stochastic: hasStochastic ? mat.uniforms.stochastic.value : null,
        timeValue: hasTime ? mat.uniforms.time.value : null,
        minAlpha: hasMinAlpha ? mat.uniforms.minAlpha.value : null,
      });
      // Disable onBeforeRender to prevent SparkRenderer from resetting depthWrite
      mesh.onBeforeRender = () => {};
      mat.depthWrite = true;
      mat.transparent = false;
      // Enable stochastic mode: fragments are randomly kept/discarded based on
      // alpha, so low-alpha splat edges get discarded instead of writing as
      // solid opaque discs in the depth buffer.
      if (hasStochastic) {
        mat.uniforms.stochastic.value = true;
      }
      // Raise minAlpha to reject low-confidence floating splats
      if (hasMinAlpha) {
        mat.uniforms.minAlpha.value = DEPTH_MIN_ALPHA;
      }
      mat.needsUpdate = true;
    }
  });
  return saved;
}

/** Restore mesh states saved by forceSceneDepthWrite(). */
function restoreSceneDepthWrite(saved: SavedMeshState[]) {
  for (const { mesh, onBeforeRender, depthWrite, transparent, stochastic, timeValue, minAlpha } of saved) {
    mesh.onBeforeRender = onBeforeRender;
    const mat = mesh.material as THREE.ShaderMaterial;
    mat.depthWrite = depthWrite;
    mat.transparent = transparent;
    if (stochastic !== null && mat.uniforms?.stochastic !== undefined) {
      mat.uniforms.stochastic.value = stochastic;
    }
    if (timeValue !== null && mat.uniforms?.time !== undefined) {
      mat.uniforms.time.value = timeValue;
    }
    if (minAlpha !== null && mat.uniforms?.minAlpha !== undefined) {
      mat.uniforms.minAlpha.value = minAlpha;
    }
    mat.needsUpdate = true;
  }
}

/**
 * Capture depth image from the current scene.
 * Extracted as a standalone function so it can be reused by video export.
 *
 * Returns a data URL (PNG) of the depth image, or null if depth data is unavailable.
 * The caller must provide all the pre-initialized depth rendering resources.
 */
/**
 * Capture depth as raw ImageData (for video export — no async data URL decoding needed).
 */
/** Shared helper: render depth and read float pixels */
function renderDepthFloat(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  depthTarget: THREE.WebGLRenderTarget,
  depthMat: THREE.ShaderMaterial,
  depthScene: THREE.Scene,
  depthCam: THREE.OrthographicCamera,
  depthVisTarget: THREE.WebGLRenderTarget,
  w: number,
  h: number
): Float32Array | null {
  depthMat.uniforms.cameraNear.value = camera.near;
  depthMat.uniforms.cameraFar.value = camera.far;

  const savedStates = forceSceneDepthWrite(scene);
  const NUM_DEPTH_PASSES = 16;
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;

  renderer.setRenderTarget(depthTarget);
  renderer.clear(true, true, true);
  for (let pass = 0; pass < NUM_DEPTH_PASSES; pass++) {
    for (const s of savedStates) {
      const mat = s.mesh.material as THREE.ShaderMaterial;
      if (mat.uniforms?.time !== undefined) {
        mat.uniforms.time.value = pass * 0.123;
      }
    }
    renderer.render(scene, camera);
  }
  renderer.setRenderTarget(null);
  renderer.autoClear = prevAutoClear;
  restoreSceneDepthWrite(savedStates);

  renderer.setRenderTarget(depthVisTarget);
  renderer.clear(true, true, true);
  renderer.render(depthScene, depthCam);
  renderer.setRenderTarget(null);

  const floatPixels = new Float32Array(w * h * 4);
  const _gl = renderer.getContext() as WebGL2RenderingContext;
  if (_gl.PIXEL_PACK_BUFFER) _gl.bindBuffer(_gl.PIXEL_PACK_BUFFER, null);
  renderer.readRenderTargetPixels(depthVisTarget, 0, 0, w, h, floatPixels);

  cleanDepthFloaters(floatPixels, w, h);
  dilateDepth(floatPixels, w, h);

  return floatPixels;
}

/** Extract min/max depth from float pixels (for global range scan) */
export function getDepthMinMax(floatPixels: Float32Array): { min: number; max: number } | null {
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  let hasData = false;
  for (let i = 0; i < floatPixels.length; i += 4) {
    const d = floatPixels[i];
    if (d >= 0) {
      hasData = true;
      if (d < minDepth) minDepth = d;
      if (d > maxDepth) maxDepth = d;
    }
  }
  return hasData ? { min: minDepth, max: maxDepth } : null;
}

/** Normalize float depth pixels to 8-bit grayscale ImageData using a provided range */
export function normalizeDepthToImageData(
  floatPixels: Float32Array,
  w: number,
  h: number,
  minDepth: number,
  maxDepth: number
): ImageData {
  const depthRange = maxDepth - minDepth;
  const imageData = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4;
    const dstRow = y * w * 4;
    for (let x = 0; x < w; x++) {
      const srcIdx = srcRow + x * 4;
      const dstIdx = dstRow + x * 4;
      const d = floatPixels[srcIdx];
      let brightness: number;
      if (d < 0) {
        brightness = 0;
      } else if (depthRange > 0) {
        brightness = Math.max(0, Math.min(255, Math.round((1 - (d - minDepth) / depthRange) * 255)));
      } else {
        brightness = 255;
      }
      imageData.data[dstIdx] = brightness;
      imageData.data[dstIdx + 1] = brightness;
      imageData.data[dstIdx + 2] = brightness;
      imageData.data[dstIdx + 3] = 255;
    }
  }
  return imageData;
}

/**
 * Capture depth as ImageData with per-frame auto-ranging (for single captures).
 */
export function captureDepthImageDataWithTarget(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  depthTarget: THREE.WebGLRenderTarget,
  depthMat: THREE.ShaderMaterial,
  depthScene: THREE.Scene,
  depthCam: THREE.OrthographicCamera,
  depthVisTarget: THREE.WebGLRenderTarget,
  w: number,
  h: number
): ImageData | null {
  const floatPixels = renderDepthFloat(renderer, scene, camera, depthTarget, depthMat, depthScene, depthCam, depthVisTarget, w, h);
  if (!floatPixels) return null;
  const range = getDepthMinMax(floatPixels);
  if (!range) return null;
  return normalizeDepthToImageData(floatPixels, w, h, range.min, range.max);
}

/**
 * Capture depth as raw ImageData (creates its own float target — for single-frame use).
 */
export function captureDepthImageData(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  depthTarget: THREE.WebGLRenderTarget,
  depthMat: THREE.ShaderMaterial,
  depthScene: THREE.Scene,
  depthCam: THREE.OrthographicCamera,
  w: number,
  h: number
): ImageData | null {
  depthMat.uniforms.cameraNear.value = camera.near;
  depthMat.uniforms.cameraFar.value = camera.far;

  const savedStates = forceSceneDepthWrite(scene);
  const NUM_DEPTH_PASSES = 16;
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;

  renderer.setRenderTarget(depthTarget);
  renderer.clear(true, true, true);
  for (let pass = 0; pass < NUM_DEPTH_PASSES; pass++) {
    for (const s of savedStates) {
      const mat = s.mesh.material as THREE.ShaderMaterial;
      if (mat.uniforms?.time !== undefined) {
        mat.uniforms.time.value = pass * 0.123;
      }
    }
    renderer.render(scene, camera);
  }
  renderer.setRenderTarget(null);
  renderer.autoClear = prevAutoClear;
  restoreSceneDepthWrite(savedStates);

  // Float target for depth visualization
  const depthVisTarget = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  renderer.setRenderTarget(depthVisTarget);
  renderer.render(depthScene, depthCam);
  renderer.setRenderTarget(null);

  const floatPixels = new Float32Array(w * h * 4);
  const _gl = renderer.getContext() as WebGL2RenderingContext;
  if (_gl.PIXEL_PACK_BUFFER) _gl.bindBuffer(_gl.PIXEL_PACK_BUFFER, null);
  renderer.readRenderTargetPixels(depthVisTarget, 0, 0, w, h, floatPixels);
  depthVisTarget.dispose();

  cleanDepthFloaters(floatPixels, w, h);
  dilateDepth(floatPixels, w, h);

  // Find min/max depth
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  let hasDepthData = false;
  for (let i = 0; i < floatPixels.length; i += 4) {
    const d = floatPixels[i];
    if (d >= 0) {
      hasDepthData = true;
      if (d < minDepth) minDepth = d;
      if (d > maxDepth) maxDepth = d;
    }
  }
  if (!hasDepthData) return null;

  // Normalize to 8-bit grayscale ImageData (closer = brighter)
  const depthRange = maxDepth - minDepth;
  const imageData = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4; // flip vertically
    const dstRow = y * w * 4;
    for (let x = 0; x < w; x++) {
      const srcIdx = srcRow + x * 4;
      const dstIdx = dstRow + x * 4;
      const d = floatPixels[srcIdx];
      let brightness: number;
      if (d < 0) {
        brightness = 0;
      } else if (depthRange > 0) {
        brightness = Math.round((1 - (d - minDepth) / depthRange) * 255);
      } else {
        brightness = 255;
      }
      imageData.data[dstIdx] = brightness;
      imageData.data[dstIdx + 1] = brightness;
      imageData.data[dstIdx + 2] = brightness;
      imageData.data[dstIdx + 3] = 255;
    }
  }
  return imageData;
}

export function captureDepthImage(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  depthTarget: THREE.WebGLRenderTarget,
  depthMat: THREE.ShaderMaterial,
  depthScene: THREE.Scene,
  depthCam: THREE.OrthographicCamera,
  canvasW: number,
  canvasH: number,
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number
): string | null {
  // Update depth material uniforms with current camera values
  depthMat.uniforms.cameraNear.value = camera.near;
  depthMat.uniforms.cameraFar.value = camera.far;

  // Force depth writing on all scene meshes (including SparkRenderer)
  const savedStates = forceSceneDepthWrite(scene);

  // Multi-pass stochastic rendering: 16 passes with different random seeds
  const NUM_DEPTH_PASSES = 16;
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;

  renderer.setRenderTarget(depthTarget);
  renderer.clear(true, true, true);

  for (let pass = 0; pass < NUM_DEPTH_PASSES; pass++) {
    for (const s of savedStates) {
      const mat = s.mesh.material as THREE.ShaderMaterial;
      if (mat.uniforms?.time !== undefined) {
        mat.uniforms.time.value = pass * 0.123;
      }
    }
    renderer.render(scene, camera);
  }

  renderer.setRenderTarget(null);
  renderer.autoClear = prevAutoClear;

  // Restore original material states
  restoreSceneDepthWrite(savedStates);

  // Render depth visualization to float target for full precision
  const depthVisTarget = new THREE.WebGLRenderTarget(canvasW, canvasH, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  renderer.setRenderTarget(depthVisTarget);
  renderer.render(depthScene, depthCam);
  renderer.setRenderTarget(null);

  // Read float pixels (R = linearized depth, background = -1)
  const floatPixels = new Float32Array(canvasW * canvasH * 4);
  const _gl3 = renderer.getContext() as WebGL2RenderingContext;
  if (_gl3.PIXEL_PACK_BUFFER) _gl3.bindBuffer(_gl3.PIXEL_PACK_BUFFER, null);
  renderer.readRenderTargetPixels(depthVisTarget, 0, 0, canvasW, canvasH, floatPixels);
  depthVisTarget.dispose();

  // Remove isolated floating splat pixels (edge-preserving)
  cleanDepthFloaters(floatPixels, canvasW, canvasH);
  // Dilate depth into edge gaps
  dilateDepth(floatPixels, canvasW, canvasH);

  // Find min/max linearized depth across all foreground pixels
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  let hasDepthData = false;
  for (let i = 0; i < floatPixels.length; i += 4) {
    const d = floatPixels[i];
    if (d >= 0) {
      hasDepthData = true;
      if (d < minDepth) minDepth = d;
      if (d > maxDepth) maxDepth = d;
    }
  }

  if (!hasDepthData) return null;

  // Normalize float depth → 8-bit grayscale (closer = brighter, background = black)
  const depthRange = maxDepth - minDepth;
  const depthCanvas = document.createElement("canvas");
  depthCanvas.width = canvasW;
  depthCanvas.height = canvasH;
  const depthCtx = depthCanvas.getContext("2d");
  if (!depthCtx) return null;

  const imageData = depthCtx.createImageData(canvasW, canvasH);
  for (let y = 0; y < canvasH; y++) {
    // Flip vertically: WebGL pixel row 0 is the bottom
    const srcRow = (canvasH - 1 - y) * canvasW * 4;
    const dstRow = y * canvasW * 4;
    for (let x = 0; x < canvasW; x++) {
      const srcIdx = srcRow + x * 4;
      const dstIdx = dstRow + x * 4;
      const d = floatPixels[srcIdx];
      let brightness: number;
      if (d < 0) {
        brightness = 0;
      } else if (depthRange > 0) {
        const t = (d - minDepth) / depthRange;
        brightness = Math.round((1 - t) * 255);
      } else {
        brightness = 255;
      }
      imageData.data[dstIdx] = brightness;
      imageData.data[dstIdx + 1] = brightness;
      imageData.data[dstIdx + 2] = brightness;
      imageData.data[dstIdx + 3] = 255;
    }
  }
  depthCtx.putImageData(imageData, 0, 0);

  // Crop to requested region
  const depthCropped = document.createElement("canvas");
  depthCropped.width = cropW;
  depthCropped.height = cropH;
  const depthCropCtx = depthCropped.getContext("2d");
  if (!depthCropCtx) return null;
  depthCropCtx.drawImage(depthCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  return depthCropped.toDataURL("image/png");
}

// ─── Page Component ─────────────────────────────────────────────

export default function StandaloneViewerPage() {
  // Parse URL params on client
  const [spzUrl, setSpzUrl] = useState<string | null>(null);
  const [worldName, setWorldName] = useState("Gaussian Splat Viewer");
  const [worldId, setWorldId] = useState<string | null>(null);

  // State
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sensorIndex, setSensorIndex] = useState(DEFAULT_SENSOR_INDEX);
  const [lensIndex, setLensIndex] = useState(DEFAULT_LENS_INDEX);
  const [aspectIndex, setAspectIndex] = useState(DEFAULT_ASPECT_RATIO_INDEX);
  const [splatLoaded, setSplatLoaded] = useState(false);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [navMode, setNavMode] = useState<"orbit" | "fly">("fly");

  // Animation state
  const [cameraPath, setCameraPath] = useState<CameraPath>(createEmptyPath(120, 24));
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [isTimelineVisible, setIsTimelineVisible] = useState(false);
  const [selectedKeyframe, setSelectedKeyframe] = useState<number | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ frame: number; total: number } | null>(null);

  // Viewer container size (for responsive framing overlay)
  const [viewerSize, setViewerSize] = useState({ w: 1280, h: 720 });

  // Transform state (applied to splat mesh)
  const [showTransform, setShowTransform] = useState(false);
  const defaultTransform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
  const [transform, setTransform] = useState(defaultTransform);

  // Lens distortion (Brown-Conrady / OpenCV model). Auto-populated from
  // an imported COLMAP cameras.txt; user can override via sliders.
  // Identity (zero coefficients) → renderer skips the distortion pass.
  interface DistortionState {
    enabled: boolean;
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    k1: number;
    k2: number;
    p1: number;
    p2: number;
    imageWidth: number;
    imageHeight: number;
  }
  const [distortion, setDistortion] = useState<DistortionState>({
    enabled: false,
    fx: 1000, fy: 1000, cx: 960, cy: 540,
    k1: 0, k2: 0, p1: 0, p2: 0,
    imageWidth: 1920, imageHeight: 1080,
  });

  // Optional measured FOV margin from extras.txt DISTORTION_SCALE. When set,
  // overrides the heuristic computeFovMargin() in render + export paths.
  const [distortionScale, setDistortionScale] = useState<number | null>(null);

  // Camera-translation scale (cm ↔ m). Multiplies imported COLMAP positions
  // and rescales any keyframes/live-camera position when changed.
  const [cameraScale, setCameraScale] = useState(1.0);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animationIdRef = useRef<number>(0);
  const splatMeshRef = useRef<unknown>(null);
  const initRef = useRef(false);

  // Depth capture refs
  const depthRenderTargetRef = useRef<THREE.WebGLRenderTarget | null>(null);

  // Distortion pass refs
  const distortionRef = useRef<DistortionState>(distortion);
  const distortionPassRef = useRef<ReturnType<typeof createDistortionPass> | null>(null);
  const distortionTargetRef = useRef<THREE.WebGLRenderTarget | null>(null);
  useEffect(() => { distortionRef.current = distortion; }, [distortion]);

  // Track current values for use inside the imperative animate loop.
  const distortionScaleRef = useRef<number | null>(distortionScale);
  useEffect(() => { distortionScaleRef.current = distortionScale; }, [distortionScale]);
  const cameraScaleRef = useRef<number>(cameraScale);
  useEffect(() => { cameraScaleRef.current = cameraScale; }, [cameraScale]);
  const depthMaterialRef = useRef<THREE.ShaderMaterial | null>(null);
  const depthSceneRef = useRef<THREE.Scene | null>(null);
  const depthCameraRef = useRef<THREE.OrthographicCamera | null>(null);

  // Animation refs
  const cameraPathRef = useRef(cameraPath);
  const currentFrameRef = useRef(0);
  const isPlayingRef = useRef(false);
  const isLoopingRef = useRef(false);
  const lastPlayTimeRef = useRef(0);
  const colmapInputRef = useRef<HTMLInputElement>(null);

  // Fly mode refs
  const keysPressedRef = useRef<Set<string>>(new Set());
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const isMouseDraggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const navModeRef = useRef<"orbit" | "fly">("fly");

  // Keep navModeRef in sync
  useEffect(() => {
    navModeRef.current = navMode;

    if (controlsRef.current) {
      controlsRef.current.enabled = navMode === "orbit";
    }

    if (navMode === "fly" && cameraRef.current) {
      // Extract yaw/pitch from current camera quaternion
      const euler = new THREE.Euler();
      euler.setFromQuaternion(cameraRef.current.quaternion, "YXZ");
      yawRef.current = euler.y;
      pitchRef.current = euler.x;
    } else if (navMode === "orbit" && cameraRef.current && controlsRef.current) {
      // Set orbit target 1 unit in front of camera
      const dir = new THREE.Vector3();
      cameraRef.current.getWorldDirection(dir);
      controlsRef.current.target.copy(
        cameraRef.current.position.clone().add(dir)
      );
      controlsRef.current.update();
    }
  }, [navMode]);

  // Always-on-top: re-focus viewer popup when it loses focus
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  useEffect(() => {
    if (!window.opener || !alwaysOnTop) return;
    let refocusTimer: ReturnType<typeof setTimeout> | null = null;
    const handleBlurRefocus = () => {
      refocusTimer = setTimeout(() => { window.focus(); }, 200);
    };
    window.addEventListener("blur", handleBlurRefocus);
    return () => {
      window.removeEventListener("blur", handleBlurRefocus);
      if (refocusTimer) clearTimeout(refocusTimer);
    };
  }, [alwaysOnTop]);

  // Keep animation refs in sync with state
  useEffect(() => { cameraPathRef.current = cameraPath; }, [cameraPath]);
  useEffect(() => { currentFrameRef.current = currentFrame; }, [currentFrame]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { isLoopingRef.current = isLooping; }, [isLooping]);

  // Camera settings
  const sensor = SENSOR_PRESETS[sensorIndex];
  const focalLength = LENS_FOCAL_LENGTHS[lensIndex];
  const aspectRatio = ASPECT_RATIO_PRESETS[aspectIndex];
  const vFov = calculateCameraFOV(sensor.widthMm, focalLength, aspectRatio.ratio);
  const selectedAspectRef = useRef(aspectRatio.ratio);

  // ─── Parse URL params on mount ──────────────────────────────────

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get("url");
    const name = params.get("name");
    const wId = params.get("worldId");

    if (url) setSpzUrl(url);
    if (name) setWorldName(name);
    if (wId) setWorldId(wId);
  }, []);

  // ─── Center camera helper ────────────────────────────────────────

  const centerCamera = useCallback(() => {
    if (!cameraRef.current) return;

    if (navModeRef.current === "fly") {
      cameraRef.current.position.set(0, 1.5, 0);
      yawRef.current = 0;
      pitchRef.current = 0;
      cameraRef.current.quaternion.setFromEuler(new THREE.Euler(0, 0, 0, "YXZ"));
    } else if (controlsRef.current) {
      cameraRef.current.position.set(0, 1.5, 0.01);
      controlsRef.current.target.set(0, 1.5, -1);
      controlsRef.current.update();
    }
  }, []);

  // ─── Initialize Three.js scene ─────────────────────────────────

  const initScene = useCallback(() => {
    if (!containerRef.current || initRef.current) return;
    initRef.current = true;

    const container = containerRef.current;

    // Renderer
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x111111);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Distortion post-pass + an off-screen target the scene renders into
    // when distortion is enabled. Both are persistent — sized lazily during
    // animate() to match the active viewport.
    const distortionPass = createDistortionPass();
    distortionPassRef.current = distortionPass;
    const distortionTarget = new THREE.WebGLRenderTarget(2, 2, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    distortionTargetRef.current = distortionTarget;

    // Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Camera — use selected aspect ratio (not window aspect) so FOV stays fixed on resize
    const camera = new THREE.PerspectiveCamera(
      vFov,
      aspectRatio.ratio,
      0.01,
      1000
    );
    camera.position.set(0, 1.5, 0);
    cameraRef.current = camera;

    // OrbitControls (disabled in fly mode)
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.8;
    controls.panSpeed = 0.5;
    controls.enabled = navModeRef.current === "orbit";
    controlsRef.current = controls;

    // Ambient light
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));

    // ─── Depth capture setup ───────────────────────────────
    const depthTarget = new THREE.WebGLRenderTarget(
      container.clientWidth * Math.min(window.devicePixelRatio, 2),
      container.clientHeight * Math.min(window.devicePixelRatio, 2)
    );
    depthTarget.depthTexture = new THREE.DepthTexture(
      depthTarget.width,
      depthTarget.height
    );
    depthTarget.depthTexture.format = THREE.DepthFormat;
    depthTarget.depthTexture.type = THREE.UnsignedIntType;
    depthRenderTargetRef.current = depthTarget;

    // Depth visualization shader — renders depth buffer as grayscale
    const depthMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDepth;
        uniform float cameraNear;
        uniform float cameraFar;
        varying vec2 vUv;

        float linearizeDepth(float depth) {
          float z = depth * 2.0 - 1.0;
          return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
        }

        void main() {
          float rawDepth = texture2D(tDepth, vUv).r;
          if (rawDepth >= 1.0) {
            // Background (no geometry) — mark with negative value
            gl_FragColor = vec4(-1.0, 0.0, 0.0, 1.0);
            return;
          }
          // Output raw linearized depth as a float — no 8-bit normalization.
          // Auto-ranging happens on CPU after reading the float render target.
          float linear = linearizeDepth(rawDepth);
          gl_FragColor = vec4(linear, 0.0, 0.0, 1.0);
        }
      `,
      uniforms: {
        tDepth: { value: depthTarget.depthTexture },
        cameraNear: { value: camera.near },
        cameraFar: { value: camera.far },
      },
    });
    depthMaterialRef.current = depthMaterial;

    // Fullscreen quad scene for depth visualization
    const depthScene = new THREE.Scene();
    const depthQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      depthMaterial
    );
    depthScene.add(depthQuad);
    depthSceneRef.current = depthScene;

    const depthCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    depthCameraRef.current = depthCamera;

    // ─── Fly mode mouse listeners ────────────────────────────
    const canvas = renderer.domElement;

    const onMouseDown = (e: MouseEvent) => {
      if (navModeRef.current !== "fly") return;
      isMouseDraggingRef.current = true;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isMouseDraggingRef.current || navModeRef.current !== "fly") return;
      const dx = e.clientX - lastMouseRef.current.x;
      const dy = e.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };

      const sensitivity = 0.003;
      yawRef.current -= dx * sensitivity;
      pitchRef.current -= dy * sensitivity;
      pitchRef.current = Math.max(
        -Math.PI / 2 + 0.01,
        Math.min(Math.PI / 2 - 0.01, pitchRef.current)
      );
    };
    const onMouseUp = () => {
      isMouseDraggingRef.current = false;
    };

    const onWheel = (e: WheelEvent) => {
      if (navModeRef.current !== "fly") return;
      e.preventDefault();
      if (!cameraRef.current) return;
      const dir = new THREE.Vector3();
      cameraRef.current.getWorldDirection(dir);
      cameraRef.current.position.addScaledVector(dir, -e.deltaY * 0.01);
    };

    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // Animation loop
    function animate(time: number) {
      animationIdRef.current = requestAnimationFrame(animate);

      // ─── Camera path playback ───────────────────────
      if (isPlayingRef.current) {
        const path = cameraPathRef.current;
        if (path.keyframes.length >= 2) {
          if (lastPlayTimeRef.current === 0) lastPlayTimeRef.current = time;
          const elapsed = (time - lastPlayTimeRef.current) / 1000; // seconds
          const frameDelta = elapsed * path.fps;
          const newFrame = Math.min(
            currentFrameRef.current + frameDelta,
            path.durationFrames - 1
          );
          lastPlayTimeRef.current = time;

          const frame = Math.round(newFrame);
          currentFrameRef.current = frame;

          // Apply camera from path
          const evaluated = evaluateCameraPath(path, frame);
          if (evaluated) {
            camera.position.copy(evaluated.position);
            camera.quaternion.copy(evaluated.quaternion);
            camera.fov = evaluated.fov;
            camera.updateProjectionMatrix();

            // Sync yaw/pitch for fly mode
            const euler = new THREE.Euler();
            euler.setFromQuaternion(camera.quaternion, "YXZ");
            yawRef.current = euler.y;
            pitchRef.current = euler.x;
          }

          // Batch state updates via postMessage to avoid excessive renders
          if (frame % 2 === 0) {
            // @ts-expect-error — __setCurrentFrame injected below
            if (typeof window.__setCurrentFrame === "function") window.__setCurrentFrame(frame);
          }

          // End of animation — loop or stop
          if (frame >= path.durationFrames - 1) {
            if (isLoopingRef.current) {
              // Reset to beginning and continue playing
              currentFrameRef.current = 0;
              lastPlayTimeRef.current = 0;
              // @ts-expect-error — __setCurrentFrame injected below
              if (typeof window.__setCurrentFrame === "function") window.__setCurrentFrame(0);
            } else {
              isPlayingRef.current = false;
              lastPlayTimeRef.current = 0;
              // @ts-expect-error
              if (typeof window.__setIsPlaying === "function") window.__setIsPlaying(false);
            }
          }
        }
      } else if (navModeRef.current === "fly") {
        // Apply yaw/pitch
        const euler = new THREE.Euler(
          pitchRef.current,
          yawRef.current,
          0,
          "YXZ"
        );
        camera.quaternion.setFromEuler(euler);

        // WASD translation
        const keys = keysPressedRef.current;
        if (keys.size > 0) {
          const speed = keys.has("shift") ? 0.15 : 0.05;
          const dir = new THREE.Vector3();
          camera.getWorldDirection(dir);
          const right = new THREE.Vector3()
            .crossVectors(dir, camera.up)
            .normalize();
          const move = new THREE.Vector3();

          if (keys.has("w")) move.add(dir);
          if (keys.has("s")) move.sub(dir);
          if (keys.has("a")) move.sub(right);
          if (keys.has("d")) move.add(right);
          if (keys.has("e")) move.y += 1;
          if (keys.has("q")) move.y -= 1;

          if (move.lengthSq() > 0) {
            move.normalize().multiplyScalar(speed);
            camera.position.add(move);
          }
        }
      } else {
        controls.update();
      }

      // Render with viewport/scissor to maintain square pixels
      // The camera aspect is locked to the selected ratio; we render into
      // a centered viewport that matches that ratio inside the window.
      const canvasW = renderer.domElement.clientWidth;
      const canvasH = renderer.domElement.clientHeight;
      const selAspect = selectedAspectRef.current;
      let vpW: number, vpH: number;
      if (canvasW / canvasH > selAspect) {
        vpH = canvasH;
        vpW = Math.round(canvasH * selAspect);
      } else {
        vpW = canvasW;
        vpH = Math.round(canvasW / selAspect);
      }
      const vpX = Math.round((canvasW - vpW) / 2);
      const vpY = Math.round((canvasH - vpH) / 2);

      const dist = distortionRef.current;
      const useDistortion = dist.enabled && (dist.k1 !== 0 || dist.k2 !== 0 || dist.p1 !== 0 || dist.p2 !== 0);

      // Always start from a fully cleared canvas.
      renderer.setRenderTarget(null);
      renderer.setScissorTest(false);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();

      if (useDistortion && distortionPassRef.current && distortionTargetRef.current) {
        // 1) Render the scene to an off-screen RT at viewport size, with a
        //    slight FOV margin so distortion has source pixels at the edges.
        const target = distortionTargetRef.current;
        if (target.width !== vpW || target.height !== vpH) {
          target.setSize(Math.max(2, vpW), Math.max(2, vpH));
        }
        // Prefer a measured DISTORTION_SCALE (Nodos extras.txt) when present;
        // fall back to the heuristic estimate otherwise.
        const measured = distortionScaleRef.current;
        const margin = (measured && measured > 0)
          ? measured
          : computeFovMargin({
              width: dist.imageWidth, height: dist.imageHeight,
              fx: dist.fx, fy: dist.fy, cx: dist.cx, cy: dist.cy,
              k1: dist.k1, k2: dist.k2, p1: dist.p1, p2: dist.p2,
            });
        const baseFov = camera.fov;
        if (margin > 1) {
          // Wider FOV = smaller focal. tan(newHalf) = margin * tan(oldHalf).
          const halfRad = THREE.MathUtils.degToRad(baseFov / 2);
          const newHalf = Math.atan(margin * Math.tan(halfRad));
          camera.fov = THREE.MathUtils.radToDeg(newHalf) * 2;
          camera.updateProjectionMatrix();
        }
        renderer.setRenderTarget(target);
        renderer.setViewport(0, 0, vpW, vpH);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
        renderer.render(scene, camera);
        if (margin > 1) {
          camera.fov = baseFov;
          camera.updateProjectionMatrix();
        }

        // 2) Distortion pass — sample the RT, write distorted result to the
        //    canvas inside the active viewport.
        const pass = distortionPassRef.current;
        // COLMAP intrinsics are in source-image pixels; scale to RT size.
        const sx = vpW / dist.imageWidth;
        const sy = vpH / dist.imageHeight;
        pass.uniforms.tDiffuse.value = target.texture;
        pass.uniforms.resolution.value.set(vpW, vpH);
        // Bake the FOV margin into fx/fy so the lookup hits the correct
        // source pixels even though the RT was rendered at a wider FOV.
        pass.uniforms.fx.value = (dist.fx * sx) * margin;
        pass.uniforms.fy.value = (dist.fy * sy) * margin;
        pass.uniforms.cx.value = dist.cx * sx;
        pass.uniforms.cy.value = dist.cy * sy;
        pass.uniforms.k1.value = dist.k1;
        pass.uniforms.k2.value = dist.k2;
        pass.uniforms.p1.value = dist.p1;
        pass.uniforms.p2.value = dist.p2;
        pass.uniforms.enabled.value = 1;

        renderer.setRenderTarget(null);
        renderer.setViewport(vpX, vpY, vpW, vpH);
        renderer.setScissor(vpX, vpY, vpW, vpH);
        renderer.setScissorTest(true);
        renderer.render(pass.scene, pass.camera);
        renderer.setScissorTest(false);
      } else {
        // Distortion off → original direct path.
        renderer.setViewport(vpX, vpY, vpW, vpH);
        renderer.setScissor(vpX, vpY, vpW, vpH);
        renderer.setScissorTest(true);
        renderer.render(scene, camera);
        renderer.setScissorTest(false);
      }
      // Reset viewport for any subsequent readPixels / UI
      renderer.setViewport(0, 0, canvasW, canvasH);
    }
    animate(0);

    // Resize handler — only resize the renderer, NOT the camera aspect
    // Camera aspect is locked to the selected aspect ratio so FOV stays fixed
    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      setViewerSize({ w, h });

      // Resize depth render target to match
      const pixelRatio = Math.min(window.devicePixelRatio, 2);
      depthTarget.setSize(w * pixelRatio, h * pixelRatio);
    };
    window.addEventListener("resize", handleResize);
    // Set initial size
    setViewerSize({ w: container.clientWidth, h: container.clientHeight });

    return () => {
      cancelAnimationFrame(animationIdRef.current);
      window.removeEventListener("resize", handleResize);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
      controls.dispose();
      depthTarget.dispose();
      depthMaterial.dispose();
      distortionTarget.dispose();
      distortionPass.dispose();
      distortionPassRef.current = null;
      distortionTargetRef.current = null;
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Load SPZ from URL ──────────────────────────────────────────

  const loadSplatFromUrl = useCallback(async (url: string) => {
    if (!sceneRef.current) {
      initScene();
      // Wait for scene to initialize
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const scene = sceneRef.current;
    if (!scene) return;

    setLoading(true);
    setError(null);
    setSplatLoaded(false);
    setTransform(defaultTransform);

    try {
      const { SplatMesh } = await import("@sparkjsdev/spark");

      // Remove old splat if any
      if (splatMeshRef.current) {
        scene.remove(splatMeshRef.current as THREE.Object3D);
        (splatMeshRef.current as { dispose?: () => void })?.dispose?.();
      }

      const splatMesh = new SplatMesh({
        url,
        onLoad: () => {
          setSplatLoaded(true);
          setLoading(false);

          // Center camera at origin
          centerCamera();
        },
      });

      await splatMesh.initialized;
      scene.add(splatMesh);
      splatMeshRef.current = splatMesh;
    } catch (err) {
      console.error("Failed to load splat:", err);
      setError(`Failed to load 3D scene: ${err instanceof Error ? err.message : "Unknown error"}`);
      setLoading(false);
    }
  }, [initScene, centerCamera]);

  // ─── Load SPZ from file (drag-and-drop or file picker) ─────────

  const loadSplatFromFile = useCallback(async (file: File) => {
    if (!sceneRef.current) {
      initScene();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const scene = sceneRef.current;
    if (!scene) return;

    setLoading(true);
    setError(null);
    setSplatLoaded(false);
    setTransform(defaultTransform);
    setWorldName(file.name.replace(/\.spz$/i, ""));

    try {
      const { SplatMesh } = await import("@sparkjsdev/spark");

      // Remove old splat if any
      if (splatMeshRef.current) {
        scene.remove(splatMeshRef.current as THREE.Object3D);
        (splatMeshRef.current as { dispose?: () => void })?.dispose?.();
      }

      // Create object URL from file
      const objectUrl = URL.createObjectURL(file);

      const splatMesh = new SplatMesh({
        url: objectUrl,
        onLoad: () => {
          setSplatLoaded(true);
          setLoading(false);
          URL.revokeObjectURL(objectUrl);

          // Center camera at origin
          centerCamera();
        },
      });

      await splatMesh.initialized;
      scene.add(splatMesh);
      splatMeshRef.current = splatMesh;
    } catch (err) {
      console.error("Failed to load splat file:", err);
      setError(`Failed to load file: ${err instanceof Error ? err.message : "Unknown error"}`);
      setLoading(false);
    }
  }, [initScene, centerCamera]);

  // ─── Auto-load if URL param present ─────────────────────────────

  useEffect(() => {
    if (spzUrl) {
      initScene();
      // Small delay to ensure scene is ready
      const timer = setTimeout(() => loadSplatFromUrl(spzUrl), 150);
      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spzUrl]);

  // ─── Update camera FOV when settings change ────────────────────

  useEffect(() => {
    selectedAspectRef.current = aspectRatio.ratio;
    if (!cameraRef.current) return;
    cameraRef.current.fov = vFov;
    cameraRef.current.aspect = aspectRatio.ratio;
    cameraRef.current.updateProjectionMatrix();
  }, [vFov, aspectRatio.ratio]);

  // ─── Apply transform to splat mesh ─────────────────────────────

  useEffect(() => {
    const mesh = splatMeshRef.current as THREE.Object3D | null;
    if (!mesh) return;
    mesh.position.set(transform.position.x, transform.position.y, transform.position.z);
    mesh.rotation.set(
      THREE.MathUtils.degToRad(transform.rotation.x),
      THREE.MathUtils.degToRad(transform.rotation.y),
      THREE.MathUtils.degToRad(transform.rotation.z)
    );
    mesh.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
  }, [transform]);

  // ─── Capture screenshot ────────────────────────────────────────

  const handleCapture = useCallback(() => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!renderer || !camera || !scene) return;

    // ─── 1. Capture RGB image (existing) ─────────────────────
    renderer.render(scene, camera);

    const canvas = renderer.domElement;
    const selectedAspect = aspectRatio.ratio;
    const canvasW = canvas.width;
    const canvasH = canvas.height;
    const canvasAspect = canvasW / canvasH;

    // Crop to selected aspect ratio
    let cropX = 0, cropY = 0, cropW = canvasW, cropH = canvasH;
    if (selectedAspect > canvasAspect) {
      // Letterbox: crop top/bottom
      cropH = Math.round(canvasW / selectedAspect);
      cropY = Math.round((canvasH - cropH) / 2);
    } else if (selectedAspect < canvasAspect) {
      // Pillarbox: crop left/right
      cropW = Math.round(canvasH * selectedAspect);
      cropX = Math.round((canvasW - cropW) / 2);
    }

    // Create offscreen canvas at cropped dimensions for RGB
    const offscreen = document.createElement("canvas");
    offscreen.width = cropW;
    offscreen.height = cropH;
    const offCtx = offscreen.getContext("2d");
    if (!offCtx) return;
    offCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    const image = offscreen.toDataURL("image/png");
    const captureId = Math.random().toString(36).substring(2, 6);
    const cameraSegment = getCameraFilenameSegment(sensor, focalLength);
    const nameSlug = worldName.replace(/[^a-zA-Z0-9]/g, "");
    const filename = `${nameSlug}_${cameraSegment}_${captureId}`;

    // ─── 2. Capture depth image ──────────────────────────────
    let depthImage: string | null = null;
    const depthTarget = depthRenderTargetRef.current;
    const depthMat = depthMaterialRef.current;
    const dScene = depthSceneRef.current;
    const depthCam = depthCameraRef.current;

    if (depthTarget && depthMat && dScene && depthCam) {
      depthImage = captureDepthImage(
        renderer, scene, camera,
        depthTarget, depthMat, dScene, depthCam,
        canvasW, canvasH,
        cropX, cropY, cropW, cropH
      );
    }

    // Re-render to screen so display isn't disrupted
    renderer.render(scene, camera);

    // ─── 3. Flash effect ──────────────────────────────────────
    setCaptureFlash(true);
    setTimeout(() => setCaptureFlash(false), 200);

    // ─── 4. Send results ──────────────────────────────────────
    if (window.opener && worldId) {
      window.opener.postMessage(
        {
          type: "worldlabs-capture",
          worldId,
          image,
          depthImage,
          filename,
          width: cropW,
          height: cropH,
        },
        window.location.origin
      );
    } else {
      // Download directly if no parent window
      const link = document.createElement("a");
      link.download = `${filename}.png`;
      link.href = image;
      link.click();

      // Also download depth if available
      if (depthImage) {
        const depthLink = document.createElement("a");
        depthLink.download = `${filename}_depth.png`;
        depthLink.href = depthImage;
        setTimeout(() => depthLink.click(), 100);
      }
    }
  }, [worldId, worldName, sensor, focalLength, aspectRatio.ratio]);

  // ─── Animation callbacks ─────────────────────────────────────────

  // Expose state setters to the rAF loop (avoids stale closures)
  useEffect(() => {
    // @ts-expect-error — bridge between rAF loop and React state
    window.__setCurrentFrame = setCurrentFrame;
    // @ts-expect-error
    window.__setIsPlaying = setIsPlaying;
    return () => {
      // @ts-expect-error
      delete window.__setCurrentFrame;
      // @ts-expect-error
      delete window.__setIsPlaying;
    };
  }, []);

  const handlePlay = useCallback(() => {
    if (cameraPath.keyframes.length < 2) return;
    // If at end, reset to beginning
    if (currentFrame >= cameraPath.durationFrames - 1) {
      setCurrentFrame(0);
      currentFrameRef.current = 0;
    }
    lastPlayTimeRef.current = 0;
    setIsPlaying(true);
  }, [cameraPath, currentFrame]);

  const handleStop = useCallback(() => {
    setIsPlaying(false);
    lastPlayTimeRef.current = 0;
  }, []);

  const handleScrub = useCallback(
    (frame: number) => {
      const clamped = Math.max(0, Math.min(frame, cameraPath.durationFrames - 1));
      setCurrentFrame(clamped);
      currentFrameRef.current = clamped;
      setIsPlaying(false);

      // Apply camera at this frame
      const camera = cameraRef.current;
      if (!camera) return;
      const evaluated = evaluateCameraPath(cameraPath, clamped);
      if (evaluated) {
        camera.position.copy(evaluated.position);
        camera.quaternion.copy(evaluated.quaternion);
        camera.fov = evaluated.fov;
        camera.updateProjectionMatrix();

        // Sync fly mode refs
        const euler = new THREE.Euler();
        euler.setFromQuaternion(camera.quaternion, "YXZ");
        yawRef.current = euler.y;
        pitchRef.current = euler.x;
      }
    },
    [cameraPath]
  );

  const handleAddKeyframe = useCallback(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const kf: CameraKeyframe = {
      time: frameToTime(currentFrame, cameraPath.durationFrames),
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      fov: camera.fov,
    };
    setCameraPath((prev) => addKeyframe(prev, kf));
  }, [currentFrame, cameraPath.durationFrames]);

  const handleRemoveKeyframe = useCallback(
    (index: number) => {
      setCameraPath((prev) => removeKeyframe(prev, index));
      setSelectedKeyframe(null);
    },
    []
  );

  const handleMoveKeyframe = useCallback(
    (index: number, newTime: number) => {
      setCameraPath((prev) => updateKeyframe(prev, index, { time: newTime }));
    },
    []
  );

  const handleSetInterpolation = useCallback(
    (index: number, mode: InterpolationMode) => {
      setCameraPath((prev) => updateKeyframe(prev, index, { interpolation: mode }));
    },
    []
  );

  const handleChangeDuration = useCallback(
    (frames: number) => {
      setCameraPath((prev) => ({ ...prev, durationFrames: frames }));
    },
    []
  );

  const handleChangeFps = useCallback(
    (fps: number) => {
      // Frame count stays the same — only the playback rate changes.
      setCameraPath((prev) => ({ ...prev, fps }));
    },
    []
  );

  /**
   * Camera-scale slider handler. Multiplies every keyframe's position by
   * `next / prev` and rescales the live camera position the same way, so
   * the existing camera path stretches/shrinks around the world origin
   * without touching the splat. Pure translation rescale — rotation/FOV
   * untouched.
   */
  const handleChangeCameraScale = useCallback(
    (next: number) => {
      if (!Number.isFinite(next) || next <= 0) return;
      const prev = cameraScaleRef.current;
      if (next === prev) return;
      const factor = next / prev;
      setCameraPath((path) => ({
        ...path,
        keyframes: path.keyframes.map((kf) => ({
          ...kf,
          position: kf.position.clone().multiplyScalar(factor),
        })),
      }));
      if (cameraRef.current) {
        cameraRef.current.position.multiplyScalar(factor);
      }
      setCameraScale(next);
    },
    []
  );

  // ─── Depth capture helper for video export ──────────────────────

  // Reusable float render target for depth visualization during export
  const depthVisExportTargetRef = useRef<THREE.WebGLRenderTarget | null>(null);

  const captureDepthFrameForExport = useCallback(
    (
      renderer: THREE.WebGLRenderer,
      scene: THREE.Scene,
      camera: THREE.PerspectiveCamera,
      w: number,
      h: number,
      globalRange?: { min: number; max: number }
    ): { imageData: ImageData | null; min: number; max: number } | null => {
      const depthTarget = depthRenderTargetRef.current;
      const depthMat = depthMaterialRef.current;
      const dScene = depthSceneRef.current;
      const depthCam = depthCameraRef.current;
      if (!depthTarget || !depthMat || !dScene || !depthCam) return null;

      depthTarget.setSize(w, h);

      if (!depthVisExportTargetRef.current ||
          depthVisExportTargetRef.current.width !== w ||
          depthVisExportTargetRef.current.height !== h) {
        depthVisExportTargetRef.current?.dispose();
        depthVisExportTargetRef.current = new THREE.WebGLRenderTarget(w, h, {
          type: THREE.FloatType,
          format: THREE.RGBAFormat,
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
        });
      }

      const floatPixels = renderDepthFloat(
        renderer, scene, camera,
        depthTarget, depthMat, dScene, depthCam,
        depthVisExportTargetRef.current,
        w, h
      );
      if (!floatPixels) return null;

      const range = getDepthMinMax(floatPixels);
      if (!range) return null;

      // If global range provided, normalize with it; otherwise use per-frame range
      const normRange = globalRange || range;
      const imageData = normalizeDepthToImageData(floatPixels, w, h, normRange.min, normRange.max);

      return { imageData, min: range.min, max: range.max };
    },
    []
  );

  // ─── Export handler ─────────────────────────────────────────────

  const handleExport = useCallback(
    async (settings: ExportSettings) => {
      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      if (!renderer || !scene || !camera) return;

      setIsExporting(true);
      setExportProgress({ frame: 0, total: settings.durationFrames });

      try {
        // Update path with export settings
        const exportPath: CameraPath = {
          ...cameraPath,
          fps: settings.fps,
          durationFrames: settings.durationFrames,
        };

        // Map codec preset to bitrate
        const codecBitrates: Record<string, number> = {
          "h264": 20_000_000,
          "h264-hq": 50_000_000,
          "h264-max": 100_000_000,
        };
        const bitrate = codecBitrates[settings.codec] || 20_000_000;

        // If distortion is on, build a post-process pass that mirrors the
        // viewer's live distortion: render the scene at a slight FOV margin,
        // then warp through the inverse Brown-Conrady shader before readback.
        const distSnap = distortionRef.current;
        const useDistortion = distSnap.enabled && (
          distSnap.k1 !== 0 || distSnap.k2 !== 0 || distSnap.p1 !== 0 || distSnap.p2 !== 0
        );
        let exportPostProcess: Parameters<typeof exportVideo>[0]["postProcess"];
        if (useDistortion) {
          const exportPass = createDistortionPass();
          // Prefer measured DISTORTION_SCALE over heuristic estimate.
          const measuredMargin = distortionScaleRef.current;
          const margin = (measuredMargin && measuredMargin > 0)
            ? measuredMargin
            : computeFovMargin({
                width: distSnap.imageWidth,
                height: distSnap.imageHeight,
                fx: distSnap.fx, fy: distSnap.fy,
                cx: distSnap.cx, cy: distSnap.cy,
                k1: distSnap.k1, k2: distSnap.k2,
                p1: distSnap.p1, p2: distSnap.p2,
              });
          exportPostProcess = {
            prepareCamera: () => {
              if (margin <= 1) return null;
              const baseFov = camera.fov;
              const halfRad = THREE.MathUtils.degToRad(baseFov / 2);
              const newHalf = Math.atan(margin * Math.tan(halfRad));
              return THREE.MathUtils.radToDeg(newHalf) * 2;
            },
            apply: (rendererArg, src, dst, w, h) => {
              const sx = w / distSnap.imageWidth;
              const sy = h / distSnap.imageHeight;
              exportPass.uniforms.tDiffuse.value = src.texture;
              exportPass.uniforms.resolution.value.set(w, h);
              exportPass.uniforms.fx.value = (distSnap.fx * sx) * margin;
              exportPass.uniforms.fy.value = (distSnap.fy * sy) * margin;
              exportPass.uniforms.cx.value = distSnap.cx * sx;
              exportPass.uniforms.cy.value = distSnap.cy * sy;
              exportPass.uniforms.k1.value = distSnap.k1;
              exportPass.uniforms.k2.value = distSnap.k2;
              exportPass.uniforms.p1.value = distSnap.p1;
              exportPass.uniforms.p2.value = distSnap.p2;
              exportPass.uniforms.enabled.value = 1;
              rendererArg.setRenderTarget(dst);
              rendererArg.setViewport(0, 0, w, h);
              rendererArg.setClearColor(0x000000, 1);
              rendererArg.clear();
              rendererArg.render(exportPass.scene, exportPass.camera);
            },
          };
        }

        const result = await exportVideo({
          renderer,
          scene,
          camera,
          path: exportPath,
          mode: settings.mode,
          resolution: settings.resolution,
          bitrate,
          captureDepthFrame:
            settings.mode === "depth" || settings.mode === "both"
              ? captureDepthFrameForExport
              : undefined,
          postProcess: exportPostProcess,
          onProgress: (frame, total) => {
            setExportProgress({ frame, total });
          },
        });

        // Save video(s) to generations folder via FormData upload
        const nameSlug = worldName.replace(/[^a-zA-Z0-9]/g, "") || "spz";
        const saveToGenerations = async (blob: Blob, filename: string, mimeType: string) => {
          const formData = new FormData();
          const ext = mimeType.includes("webm") ? "webm" : "mp4";
          formData.append("file", new File([blob], `${filename}.${ext}`, { type: mimeType }));
          formData.append("directoryPath", "generations");
          formData.append("customFilename", filename);
          formData.append("createDirectory", "true");
          const res = await fetch("/api/save-generation", {
            method: "POST",
            body: formData,
          });
          if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`Save failed: ${res.statusText} - ${errBody}`);
          }
          return await res.json();
        };

        let savedRgb: { filePath?: string; filename?: string; imageId?: string } | null = null;
        if (result.rgb) {
          savedRgb = await saveToGenerations(result.rgb, `${nameSlug}_rgb`, result.rgb.type || "video/mp4");
          // Browser download fallback
          triggerDownload(result.rgb, `${nameSlug}_rgb.${result.rgb.type?.includes("webm") ? "webm" : "mp4"}`);
        }
        if (result.depth) {
          await saveToGenerations(result.depth, `${nameSlug}_depth`, result.depth.type || "video/mp4");
          triggerDownload(result.depth, `${nameSlug}_depth.${result.depth.type?.includes("webm") ? "webm" : "mp4"}`);
        }

        // Export COLMAP data if requested
        if (settings.includeColmap) {
          const colmapBlob = await exportColmap(
            exportPath,
            settings.resolution.width,
            settings.resolution.height,
            sensor.widthMm,
            focalLength
          );
          // Download COLMAP zip to browser
          triggerDownload(colmapBlob, `${nameSlug}_colmap.zip`);
          // Also save to generations folder
          const colmapFormData = new FormData();
          colmapFormData.append("file", new File([colmapBlob], `${nameSlug}_colmap.zip`, { type: "application/zip" }));
          colmapFormData.append("directoryPath", "generations");
          colmapFormData.append("customFilename", `${nameSlug}_colmap`);
          colmapFormData.append("createDirectory", "true");
          const colmapRes = await fetch("/api/save-generation", {
            method: "POST",
            body: colmapFormData,
          });
          if (!colmapRes.ok) {
            console.warn("COLMAP save to generations failed:", colmapRes.statusText);
          }
        }

        setShowExportDialog(false);
      } catch (err) {
        console.error("Export failed:", err);
        alert(`Export failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      } finally {
        setIsExporting(false);
        setExportProgress(null);
      }
    },
    [cameraPath, worldName, sensor.widthMm, focalLength, captureDepthFrameForExport]
  );

  // ─── COLMAP import handler ──────────────────────────────────────

  const handleColmapImport = useCallback(async (file: File) => {
    try {
      const blob = new Blob([await file.arrayBuffer()]);
      const { path: importedPath, cameraParams } = await importColmap(blob, cameraPath.fps);

      // Apply the current camera-scale to imported translations. Lets the user
      // set "100" once for cm-scale shoots and have every subsequent import
      // auto-scale into the metre-scale splat world.
      const scale = cameraScaleRef.current;
      const scaledPath: CameraPath = scale === 1
        ? importedPath
        : {
            ...importedPath,
            keyframes: importedPath.keyframes.map((kf) => ({
              ...kf,
              position: kf.position.clone().multiplyScalar(scale),
            })),
          };
      setCameraPath(scaledPath);
      setCurrentFrame(0);
      setIsTimelineVisible(true);

      // Restore camera intrinsics from COLMAP data
      if (cameraParams) {
        // Find the closest matching sensor preset by width
        const bestSensor = SENSOR_PRESETS.reduce((bestIdx, preset, idx) => {
          const diff = Math.abs(preset.widthMm - cameraParams.width * (SENSOR_PRESETS[bestIdx].widthMm / cameraParams.width));
          return diff < Math.abs(SENSOR_PRESETS[bestIdx].widthMm - cameraParams.width * (SENSOR_PRESETS[bestIdx].widthMm / cameraParams.width)) ? idx : bestIdx;
        }, 0);
        setSensorIndex(bestSensor);

        // Compute focal length in mm from pixel focal length: focalMm = fx * sensorWidthMm / imageWidth
        const sensorW = SENSOR_PRESETS[bestSensor].widthMm;
        const focalMm = cameraParams.fx * sensorW / cameraParams.width;
        // Find closest lens preset
        const bestLens = LENS_FOCAL_LENGTHS.reduce((bestIdx, fl, idx) =>
          Math.abs(fl - focalMm) < Math.abs(LENS_FOCAL_LENGTHS[bestIdx] - focalMm) ? idx : bestIdx
        , 0);
        setLensIndex(bestLens);

        // Find closest aspect ratio preset
        const importedAspect = cameraParams.width / cameraParams.height;
        const bestAspect = ASPECT_RATIO_PRESETS.reduce((bestIdx, preset, idx) =>
          Math.abs(preset.ratio - importedAspect) < Math.abs(ASPECT_RATIO_PRESETS[bestIdx].ratio - importedAspect) ? idx : bestIdx
        , 0);
        setAspectIndex(bestAspect);

        // Lens distortion — populate from imported intrinsics. Auto-enable
        // when the COLMAP camera carried non-zero coefficients.
        const hasDistortion =
          cameraParams.k1 !== 0 || cameraParams.k2 !== 0 ||
          cameraParams.p1 !== 0 || cameraParams.p2 !== 0;
        setDistortion({
          enabled: hasDistortion,
          fx: cameraParams.fx,
          fy: cameraParams.fy,
          cx: cameraParams.cx,
          cy: cameraParams.cy,
          k1: cameraParams.k1,
          k2: cameraParams.k2,
          p1: cameraParams.p1,
          p2: cameraParams.p2,
          imageWidth: cameraParams.width,
          imageHeight: cameraParams.height,
        });

        // Optional measured FOV margin from extras.txt → use directly in the
        // render and export paths instead of the heuristic estimate.
        setDistortionScale(
          typeof cameraParams.distortionScale === "number" ? cameraParams.distortionScale : null,
        );
      }

      // Apply first keyframe camera (already pre-scaled in scaledPath).
      if (scaledPath.keyframes.length > 0 && cameraRef.current) {
        const kf = scaledPath.keyframes[0];
        cameraRef.current.position.copy(kf.position);
        cameraRef.current.quaternion.copy(kf.quaternion);
        cameraRef.current.fov = kf.fov;
        cameraRef.current.updateProjectionMatrix();

        const euler = new THREE.Euler();
        euler.setFromQuaternion(cameraRef.current.quaternion, "YXZ");
        yawRef.current = euler.y;
        pitchRef.current = euler.x;
      }
    } catch (err) {
      console.error("COLMAP import failed:", err);
      alert(`COLMAP import failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }, [cameraPath.fps]);

  // ─── Keyboard shortcuts + WASD navigation ──────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Capture
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        handleCapture();
      }
      // Toggle controls visibility
      if (e.key === "h" || e.key === "H") {
        setShowControls((s) => !s);
      }
      // Toggle nav mode
      if (e.key === "f" || e.key === "F") {
        setNavMode((m) => (m === "fly" ? "orbit" : "fly"));
      }
      // Toggle timeline
      if (e.key === "t" || e.key === "T") {
        setIsTimelineVisible((v) => !v);
      }
      // Add keyframe
      if (e.key === "k" || e.key === "K") {
        handleAddKeyframe();
      }
      // Delete selected keyframe
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedKeyframe !== null) {
          handleRemoveKeyframe(selectedKeyframe);
        }
      }
      // WASD + QE navigation keys
      const navKeys = ["w", "a", "s", "d", "q", "e"];
      const lower = e.key.toLowerCase();
      if (navKeys.includes(lower)) {
        keysPressedRef.current.add(lower);
      }
      if (e.key === "Shift") {
        keysPressedRef.current.add("shift");
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      const lower = e.key.toLowerCase();
      keysPressedRef.current.delete(lower);
      if (e.key === "Shift") {
        keysPressedRef.current.delete("shift");
      }
    };
    const handleBlur = () => {
      keysPressedRef.current.clear();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [handleCapture, handleAddKeyframe, handleRemoveKeyframe, selectedKeyframe]);

  // ─── Drag and Drop ─────────────────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".spz") || lower.endsWith(".ply")) {
        loadSplatFromFile(file);
      } else {
        setError("Please drop a .spz or .ply file");
      }
    }
  }, [loadSplatFromFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".spz") || lower.endsWith(".ply")) {
        loadSplatFromFile(file);
      } else {
        setError("Please select a .spz or .ply file");
      }
    }
  }, [loadSplatFromFile]);

  // ─── Upload Mode (no URL) ─────────────────────────────────────

  if (!spzUrl && !splatLoaded && !loading) {
    return (
      <div
        className="fixed inset-0 bg-neutral-950 flex items-center justify-center"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          className={`text-center max-w-md px-8 py-12 rounded-2xl border-2 border-dashed transition-colors ${
            isDragging
              ? "border-indigo-500 bg-indigo-500/10"
              : "border-neutral-700 hover:border-neutral-600"
          }`}
        >
          {/* Globe icon */}
          <svg
            className="w-16 h-16 text-neutral-600 mx-auto mb-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>

          <h1 className="text-neutral-200 text-lg font-medium mb-2">
            Gaussian Splat Viewer
          </h1>
          <p className="text-neutral-500 text-sm mb-6">
            Drag and drop a <code className="text-indigo-400">.spz</code> or{" "}
            <code className="text-indigo-400">.ply</code> file here
            <br />
            or click to browse
          </p>

          <label className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium py-2.5 px-5 rounded-lg cursor-pointer transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Choose File
            <input
              type="file"
              accept=".spz,.ply"
              onChange={handleFileSelect}
              className="hidden"
            />
          </label>

          {error && (
            <p className="text-red-400 text-xs mt-4">{error}</p>
          )}

          <p className="text-neutral-700 text-[10px] mt-6">
            Or use: /viewer?url=https://example.com/scene.spz
          </p>
        </div>
      </div>
    );
  }

  // ─── Viewer Mode ───────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 bg-neutral-950 overflow-hidden select-none"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Three.js canvas container */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Framing overlay — shows semi-transparent mask outside the selected aspect ratio */}
      {splatLoaded && (() => {
        const viewW = viewerSize.w;
        const viewH = viewerSize.h;
        if (viewW <= 0 || viewH <= 0) return null;

        const selectedAspect = aspectRatio.ratio;
        // Fit the target aspect ratio centered inside the viewport
        let activeW: number, activeH: number;
        if (viewW / viewH > selectedAspect) {
          // Viewport is wider than target — constrained by height
          activeH = viewH;
          activeW = viewH * selectedAspect;
        } else {
          // Viewport is taller than target — constrained by width
          activeW = viewW;
          activeH = viewW / selectedAspect;
        }

        const barLeft = Math.max(0, (viewW - activeW) / 2);
        const barRight = barLeft;
        const barTop = Math.max(0, (viewH - activeH) / 2);
        const barBottom = barTop;

        // Skip if the bars are negligible
        if (barLeft < 1 && barTop < 1) return null;

        // Use a single overlay with clip-path to cut out the active area
        const insetLeft = barLeft;
        const insetTop = barTop;
        const insetRight = viewW - barRight;
        const insetBottom = viewH - barBottom;

        return (
          <div className="absolute inset-0 pointer-events-none z-[4]">
            {/* Semi-transparent mask using clip-path (polygon with hole) */}
            <div
              className="absolute inset-0"
              style={{
                background: "rgba(0,0,0,0.55)",
                clipPath: `polygon(
                  0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
                  ${insetLeft}px ${insetTop}px,
                  ${insetLeft}px ${insetBottom}px,
                  ${insetRight}px ${insetBottom}px,
                  ${insetRight}px ${insetTop}px,
                  ${insetLeft}px ${insetTop}px
                )`,
              }}
            />
            {/* Border around active area */}
            <div
              className="absolute border border-neutral-500/40"
              style={{
                left: barLeft,
                top: barTop,
                width: activeW,
                height: activeH,
              }}
            />
          </div>
        );
      })()}

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 bg-neutral-950/80 flex items-center justify-center z-10">
          <div className="text-center">
            <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-neutral-400 text-sm">Loading scene...</p>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 bg-neutral-950/80 flex items-center justify-center z-10">
          <div className="text-center max-w-md px-6">
            <p className="text-red-400 text-sm mb-2">Failed to load scene</p>
            <p className="text-neutral-500 text-xs">{error}</p>
          </div>
        </div>
      )}

      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 bg-indigo-500/20 border-2 border-dashed border-indigo-500 flex items-center justify-center z-20">
          <p className="text-indigo-300 text-lg font-medium">Drop .spz or .ply file here</p>
        </div>
      )}

      {/* Capture flash overlay */}
      {captureFlash && (
        <div className="absolute inset-0 bg-white/30 pointer-events-none transition-opacity duration-200 z-10" />
      )}

      {/* Top bar — world info */}
      <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/60 to-transparent p-4 pointer-events-none z-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {window.opener && (
              <button
                onClick={() => setAlwaysOnTop((v) => !v)}
                className={`pointer-events-auto p-1 rounded transition-colors ${
                  alwaysOnTop ? "text-indigo-400 hover:text-indigo-300" : "text-neutral-500 hover:text-neutral-300"
                }`}
                title={alwaysOnTop ? "Unpin window (always on top)" : "Pin window (always on top)"}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  {alwaysOnTop ? (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l0 4m-3 1l6 0l-1 7l-1.5 1.5L12 22l-.5-6.5L10 14l-1-7z" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l0 4m-3 1l6 0l-1 7l-1.5 1.5L12 22l-.5-6.5L10 14l-1-7z" opacity={0.4} />
                  )}
                </svg>
              </button>
            )}
            <div>
              <h1 className="text-white text-sm font-medium">{worldName}</h1>
              <p className="text-neutral-400 text-[10px]">
                {sensor.name} · {focalLength}mm · {aspectRatio.name} · {vFov.toFixed(1)}° vFOV
              </p>
            </div>
          </div>
          {loading && (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 border border-indigo-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-indigo-400 text-xs">Loading scene...</span>
            </div>
          )}
        </div>
      </div>

      {/* Controls Panel */}
      {showControls && splatLoaded && (
        <div className="absolute bottom-4 left-4 right-4 pointer-events-none z-5">
          <div className="flex items-end justify-between gap-4">
            {/* Camera Settings */}
            <div className="bg-black/70 backdrop-blur-md rounded-lg p-3 pointer-events-auto max-w-md">
              <div className="grid grid-cols-3 gap-3">
                {/* Sensor */}
                <div>
                  <label className="text-[9px] text-neutral-500 block mb-1">Sensor</label>
                  <select
                    value={sensorIndex}
                    onChange={(e) => setSensorIndex(Number(e.target.value))}
                    className="w-full bg-neutral-800 text-neutral-200 text-[11px] rounded px-2 py-1 border border-neutral-700 focus:border-indigo-500 focus:outline-none appearance-none"
                  >
                    {SENSOR_PRESETS.map((s, i) => (
                      <option key={s.name} value={i}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Lens */}
                <div>
                  <label className="text-[9px] text-neutral-500 block mb-1">Lens</label>
                  <select
                    value={lensIndex}
                    onChange={(e) => setLensIndex(Number(e.target.value))}
                    className="w-full bg-neutral-800 text-neutral-200 text-[11px] rounded px-2 py-1 border border-neutral-700 focus:border-indigo-500 focus:outline-none appearance-none"
                  >
                    {LENS_FOCAL_LENGTHS.map((fl, i) => (
                      <option key={fl} value={i}>
                        {fl}mm
                      </option>
                    ))}
                  </select>
                </div>

                {/* Aspect Ratio */}
                <div>
                  <label className="text-[9px] text-neutral-500 block mb-1">Aspect</label>
                  <select
                    value={aspectIndex}
                    onChange={(e) => setAspectIndex(Number(e.target.value))}
                    className="w-full bg-neutral-800 text-neutral-200 text-[11px] rounded px-2 py-1 border border-neutral-700 focus:border-indigo-500 focus:outline-none appearance-none"
                  >
                    {ASPECT_RATIO_PRESETS.map((ar, i) => (
                      <option key={ar.name} value={i}>
                        {ar.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Lens distortion (Brown-Conrady, OpenCV model) */}
              <div className="mt-2 pt-2 border-t border-neutral-800">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[9px] text-neutral-500">Lens distortion</label>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setDistortion((d) => ({
                        ...d, k1: 0, k2: 0, p1: 0, p2: 0,
                      }))}
                      className="text-[9px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
                      title="Zero all distortion coefficients"
                    >
                      Reset
                    </button>
                    <button
                      onClick={() => setDistortion((d) => ({ ...d, enabled: !d.enabled }))}
                      className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                        distortion.enabled
                          ? "bg-indigo-600 text-white"
                          : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                      }`}
                    >
                      {distortion.enabled ? "On" : "Off"}
                    </button>
                  </div>
                </div>
                {distortion.enabled && (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                    {(
                      [
                        { key: "k1", label: "k1", min: -1, max: 1, step: 0.005 },
                        { key: "k2", label: "k2", min: -1, max: 1, step: 0.005 },
                        { key: "p1", label: "p1", min: -0.1, max: 0.1, step: 0.0005 },
                        { key: "p2", label: "p2", min: -0.1, max: 0.1, step: 0.0005 },
                      ] as const
                    ).map((s) => {
                      const v = distortion[s.key];
                      return (
                        <div key={s.key} className="flex items-center gap-1">
                          <label className="text-[9px] text-neutral-500 w-[14px] shrink-0">{s.label}</label>
                          <input
                            type="range"
                            min={s.min}
                            max={s.max}
                            step={s.step}
                            value={v}
                            onChange={(e) =>
                              setDistortion((d) => ({ ...d, [s.key]: parseFloat(e.target.value) }))
                            }
                            className="flex-1 h-1 accent-indigo-500 cursor-pointer min-w-0"
                          />
                          <input
                            type="number"
                            step={s.step}
                            value={v}
                            onChange={(e) => {
                              const n = parseFloat(e.target.value);
                              if (Number.isFinite(n)) setDistortion((d) => ({ ...d, [s.key]: n }));
                            }}
                            className="w-[52px] shrink-0 text-[9px] py-0.5 px-1 rounded bg-neutral-800 text-neutral-200 border border-neutral-700 focus:border-indigo-500 focus:outline-none tabular-nums"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Camera scale (cm ↔ m worlds). Multiplies camera-track translations
                  so a cm-scale COLMAP pairs with metre-scale splats without
                  resizing the splat. Pure translation rescale — splat untouched. */}
              <div className="mt-2 pt-2 border-t border-neutral-800">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[9px] text-neutral-500">Camera scale</label>
                  <button
                    onClick={() => handleChangeCameraScale(1)}
                    className="text-[9px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
                    title="Reset camera scale to 1.0"
                  >
                    ↺
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  {/* Log slider: 0.001 (10^-3) → 1000 (10^3). */}
                  <input
                    type="range"
                    min={-3}
                    max={3}
                    step={0.01}
                    value={Math.log10(cameraScale)}
                    onChange={(e) => handleChangeCameraScale(Math.pow(10, parseFloat(e.target.value)))}
                    className="flex-1 h-1 accent-indigo-500 cursor-pointer min-w-0"
                  />
                  <input
                    type="number"
                    step="any"
                    min={0}
                    value={cameraScale}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      if (Number.isFinite(n) && n > 0) handleChangeCameraScale(n);
                    }}
                    className="w-[64px] shrink-0 text-[9px] py-0.5 px-1 rounded bg-neutral-800 text-neutral-200 border border-neutral-700 focus:border-indigo-500 focus:outline-none tabular-nums"
                  />
                </div>
              </div>

              {/* Nav mode toggle */}
              <div className="mt-2 flex items-center gap-2">
                <label className="text-[9px] text-neutral-500">Nav</label>
                <div className="flex gap-1">
                  {(["fly", "orbit"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setNavMode(mode)}
                      className={`text-[10px] px-2 py-0.5 rounded ${
                        navMode === mode
                          ? "bg-indigo-600 text-white"
                          : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                      } transition-colors`}
                    >
                      {mode === "fly" ? "Fly" : "Orbit"}
                    </button>
                  ))}
                  <span className="text-[9px] text-neutral-600 ml-1 self-center">F</span>
                </div>
              </div>
            </div>

            {/* Transform Panel */}
            {showTransform && (
              <div className="bg-black/70 backdrop-blur-md rounded-lg p-3 pointer-events-auto min-w-[340px]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-medium text-neutral-300">Transform</span>
                  <button
                    onClick={() => setTransform(defaultTransform)}
                    className="text-[9px] text-neutral-500 hover:text-neutral-300 transition-colors"
                    title="Reset all transforms"
                  >
                    Reset All
                  </button>
                </div>
                {(["position", "rotation", "scale"] as const).map((prop) => {
                  const defaults = { position: 0, rotation: 0, scale: 1 };
                  const step = prop === "rotation" ? 1 : 0.1;
                  return (
                    <div key={prop} className="flex items-center gap-2 mb-1.5 last:mb-0">
                      <label className="text-[9px] text-neutral-500 w-12 shrink-0 capitalize">{prop}</label>
                      {(["x", "y", "z"] as const).map((axis) => (
                        <div key={axis} className="flex items-center gap-0.5 flex-1">
                          <span className={`text-[9px] font-medium ${axis === "x" ? "text-red-400" : axis === "y" ? "text-green-400" : "text-blue-400"}`}>{axis.toUpperCase()}</span>
                          <input
                            type="number"
                            step={step}
                            value={transform[prop][axis]}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value) || 0;
                              setTransform((prev) => ({
                                ...prev,
                                [prop]: { ...prev[prop], [axis]: val },
                              }));
                            }}
                            className="w-full bg-neutral-800 text-neutral-200 text-[11px] rounded px-1.5 py-0.5 border border-neutral-700 focus:border-indigo-500 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                        </div>
                      ))}
                      <button
                        onClick={() => {
                          const d = defaults[prop];
                          setTransform((prev) => ({
                            ...prev,
                            [prop]: { x: d, y: d, z: d },
                          }));
                        }}
                        className="text-neutral-600 hover:text-neutral-300 transition-colors shrink-0"
                        title={`Reset ${prop}`}
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Right side buttons */}
            <div className="flex items-center gap-2 pointer-events-auto">
              {/* Transform toggle */}
              <button
                onClick={() => setShowTransform((v) => !v)}
                className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                  showTransform
                    ? "bg-indigo-600 text-white"
                    : "bg-neutral-800/80 text-neutral-400 hover:text-white"
                }`}
                title="Toggle transform controls"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 21L3 9m18 12L17 9M12 3v18M3 9h18" />
                </svg>
              </button>

              {/* Timeline toggle */}
              <button
                onClick={() => setIsTimelineVisible((v) => !v)}
                className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                  isTimelineVisible
                    ? "bg-indigo-600 text-white"
                    : "bg-neutral-800/80 text-neutral-400 hover:text-white"
                }`}
                title="Toggle timeline (T)"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
                </svg>
              </button>

              {/* Export button */}
              <button
                onClick={() => setShowExportDialog(true)}
                disabled={cameraPath.keyframes.length < 2}
                className="w-9 h-9 rounded-lg flex items-center justify-center bg-neutral-800/80 text-neutral-400 hover:text-white disabled:text-neutral-600 disabled:cursor-not-allowed transition-colors"
                title="Export video"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>

              {/* COLMAP import */}
              <button
                onClick={() => colmapInputRef.current?.click()}
                className="w-9 h-9 rounded-lg flex items-center justify-center bg-neutral-800/80 text-neutral-400 hover:text-white transition-colors"
                title="Import COLMAP camera path"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              </button>
              <input
                ref={colmapInputRef}
                type="file"
                accept=".zip"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleColmapImport(file);
                  e.target.value = "";
                }}
                className="hidden"
              />

              {/* Capture Button */}
              <button
                onClick={handleCapture}
                disabled={!splatLoaded}
                className="bg-red-600 hover:bg-red-500 disabled:bg-neutral-700 disabled:cursor-not-allowed text-white rounded-full w-14 h-14 flex items-center justify-center shadow-lg transition-all active:scale-95"
                title="Capture frame (Space / Enter)"
              >
                <div className="w-10 h-10 border-2 border-white rounded-full flex items-center justify-center">
                  <div className="w-6 h-6 bg-white rounded-full" />
                </div>
              </button>
            </div>
          </div>

          {/* Timeline */}
          {isTimelineVisible && (
            <div className="mt-2">
              <Timeline
                path={cameraPath}
                currentFrame={currentFrame}
                isPlaying={isPlaying}
                isLooping={isLooping}
                onScrub={handleScrub}
                onPlay={handlePlay}
                onStop={handleStop}
                onToggleLoop={() => setIsLooping((v) => !v)}
                onAddKeyframe={handleAddKeyframe}
                onRemoveKeyframe={handleRemoveKeyframe}
                onMoveKeyframe={handleMoveKeyframe}
                onSelectKeyframe={setSelectedKeyframe}
                onSetInterpolation={handleSetInterpolation}
                onChangeDuration={handleChangeDuration}
                onChangeFps={handleChangeFps}
                selectedKeyframe={selectedKeyframe}
              />
            </div>
          )}
        </div>
      )}

      {/* Export Dialog */}
      {showExportDialog && (
        <ExportDialog
          path={cameraPath}
          sensorWidthMm={sensor.widthMm}
          focalLengthMm={focalLength}
          onExport={handleExport}
          onClose={() => setShowExportDialog(false)}
          isExporting={isExporting}
          exportProgress={exportProgress}
        />
      )}

      {/* Toggle controls hint */}
      <div className="absolute top-4 right-4 pointer-events-none z-5">
        <p className="text-neutral-600 text-[9px]">
          {navMode === "fly" ? "WASD to move · Drag to look" : "Drag to orbit"} · F toggle · H {showControls ? "hide" : "show"} · Space capture · T timeline · K keyframe
          {!worldId && " · Drop .spz/.ply to load"}
        </p>
      </div>
    </div>
  );
}
