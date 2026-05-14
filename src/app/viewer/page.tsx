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
import {
  exportColmap,
  importColmap,
  worldFrameToSceneRotation,
  type ColmapWorldFrame,
} from "./colmapIO";
import { createDistortionPass, computeFovMargin } from "./distortionShader";
import { createDofPass } from "./dofShader";
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

/**
 * GPU-only depth render for the real-time DoF pass. Same scaffold as
 * `renderDepthFloat` but cheaper: fewer accumulation passes (default 2,
 * vs 16 for hero-quality), no readPixels, no CPU floater cleanup. The
 * linearised depth stays in `depthVisTarget.texture` for the DoF shader
 * to sample directly.
 *
 * Resize is the caller's responsibility — `depthTarget` and `depthVisTarget`
 * must already be sized to `w × h`.
 */
function renderDepthLive(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  depthTarget: THREE.WebGLRenderTarget,
  depthMat: THREE.ShaderMaterial,
  depthScene: THREE.Scene,
  depthCam: THREE.OrthographicCamera,
  depthVisTarget: THREE.WebGLRenderTarget,
  passes = 2,
): void {
  depthMat.uniforms.cameraNear.value = camera.near;
  depthMat.uniforms.cameraFar.value = camera.far;

  const savedStates = forceSceneDepthWrite(scene);
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;

  renderer.setRenderTarget(depthTarget);
  renderer.clear(true, true, true);
  for (let pass = 0; pass < passes; pass++) {
    for (const s of savedStates) {
      const mat = s.mesh.material as THREE.ShaderMaterial;
      if (mat.uniforms?.time !== undefined) {
        mat.uniforms.time.value = pass * 0.123;
      }
    }
    renderer.render(scene, camera);
  }
  renderer.autoClear = prevAutoClear;
  restoreSceneDepthWrite(savedStates);

  renderer.setRenderTarget(depthVisTarget);
  renderer.clear(true, true, true);
  renderer.render(depthScene, depthCam);
  renderer.setRenderTarget(null);
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
  const [cameraPath, setCameraPath] = useState<CameraPath>(createEmptyPath(120, 25));
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

  // Convention of the COLMAP world frame for import/export. Default "y-down"
  // matches the raw COLMAP / OpenCV spec; switch to "z-up" for Blender /
  // Unreal / RealityCapture / Metashape exports, or "y-up" for glTF / Three.js
  // sources. Used symmetrically on import and export, and toggling rotates the
  // currently loaded path so it stays aligned with the splat.
  const [colmapWorldFrame, setColmapWorldFrame] = useState<ColmapWorldFrame>("y-down");

  // Scene helpers — ground grid (XZ plane in Y-up) and origin axes (RGB).
  // Both default on as visual reference for inspecting splats.
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(true);

  // Depth-of-field. Thin-lens CoC, scatter-as-gather disk blur. CPU side
  // derives focal/aperture/sensor-pixels from the active camera preset; the
  // shader does the per-pixel math. `halfRes` shrinks the live pass for fps,
  // `showCoC` swaps the output to a CoC heatmap for tuning focus distance.
  const [dof, setDof] = useState({
    enabled: false,
    fNumber: 2.8,
    focusM: 3.0,
    halfRes: false,
    showCoC: false,
  });
  // Click-to-focus: when true, the next canvas click reads depth at the cursor
  // and writes the result into `dof.focusM`. One-shot; auto-clears.
  const [focusPickMode, setFocusPickMode] = useState(false);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animationIdRef = useRef<number>(0);
  const splatMeshRef = useRef<unknown>(null);
  // True when the currently loaded splat is a PLY. PLY has no embedded
  // coordinate-system metadata, so we orient it using the user-selected
  // `colmapWorldFrame` (the same one applied to COLMAP camera tracks). SPZ
  // self-normalizes via its coordinate_system header and is exempt.
  const splatIsPlyRef = useRef(false);
  const initRef = useRef(false);
  const gridHelperRef = useRef<THREE.GridHelper | null>(null);
  const axesHelperRef = useRef<THREE.AxesHelper | null>(null);

  // Depth capture refs
  const depthRenderTargetRef = useRef<THREE.WebGLRenderTarget | null>(null);

  // Distortion pass refs
  const distortionRef = useRef<DistortionState>(distortion);
  const distortionPassRef = useRef<ReturnType<typeof createDistortionPass> | null>(null);
  const distortionTargetRef = useRef<THREE.WebGLRenderTarget | null>(null);
  useEffect(() => { distortionRef.current = distortion; }, [distortion]);

  // Depth-of-field pass refs. The DoF pass reads `colorRT` + a linearised
  // depth RT (rendered live each frame at the active pass resolution) and
  // writes a defocus-blurred RT that's then either fed into distortion or
  // blitted straight to the canvas. Click-to-focus uses the
  // `focusPickModeRef` flag to gate the next canvas click.
  const dofRef = useRef(dof);
  useEffect(() => { dofRef.current = dof; }, [dof]);
  const focusPickModeRef = useRef(focusPickMode);
  useEffect(() => { focusPickModeRef.current = focusPickMode; }, [focusPickMode]);
  const dofPassRef = useRef<ReturnType<typeof createDofPass> | null>(null);
  const dofTargetRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const dofPassthroughRef = useRef<ReturnType<typeof createDofPass> | null>(null); // enabled=0 → cheap blit
  const depthLiveTargetRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const depthVisLiveTargetRef = useRef<THREE.WebGLRenderTarget | null>(null);

  // Track current values for use inside the imperative animate loop.
  const distortionScaleRef = useRef<number | null>(distortionScale);
  useEffect(() => { distortionScaleRef.current = distortionScale; }, [distortionScale]);
  const cameraScaleRef = useRef<number>(cameraScale);
  useEffect(() => { cameraScaleRef.current = cameraScale; }, [cameraScale]);
  const colmapWorldFrameRef = useRef<ColmapWorldFrame>(colmapWorldFrame);
  useEffect(() => { colmapWorldFrameRef.current = colmapWorldFrame; }, [colmapWorldFrame]);
  // Sync helper visibility with toggles.
  useEffect(() => { if (gridHelperRef.current) gridHelperRef.current.visible = showGrid; }, [showGrid]);
  useEffect(() => { if (axesHelperRef.current) axesHelperRef.current.visible = showAxes; }, [showAxes]);
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
  // Roll (Euler z, YXZ order). Tracked alongside yaw/pitch so fly-mode can
  // preserve the camera's full orientation after playback / scrub of paths
  // whose YXZ decomposition has non-zero z (e.g. Z-up tracks rotated to Y-up).
  const rollRef = useRef(0);
  const isMouseDraggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const navModeRef = useRef<"orbit" | "fly">("fly");

  // Keep navModeRef in sync
  useEffect(() => {
    navModeRef.current = navMode;

    if (controlsRef.current) {
      // Orbit is disabled while focus-pick is armed so the first click goes
      // through tryPickFocus instead of starting an orbit drag.
      controlsRef.current.enabled = navMode === "orbit" && !focusPickMode;
    }

    if (navMode === "fly" && cameraRef.current) {
      // Extract yaw/pitch/roll from current camera quaternion
      const euler = new THREE.Euler();
      euler.setFromQuaternion(cameraRef.current.quaternion, "YXZ");
      yawRef.current = euler.y;
      pitchRef.current = euler.x;
      rollRef.current = euler.z;
    } else if (navMode === "orbit" && cameraRef.current && controlsRef.current) {
      // Set orbit target 1 unit in front of camera
      const dir = new THREE.Vector3();
      cameraRef.current.getWorldDirection(dir);
      controlsRef.current.target.copy(
        cameraRef.current.position.clone().add(dir)
      );
      controlsRef.current.update();
    }
  }, [navMode, focusPickMode]);

  // Visual feedback for focus-pick mode: crosshair cursor on the canvas.
  useEffect(() => {
    const el = rendererRef.current?.domElement;
    if (!el) return;
    el.style.cursor = focusPickMode ? "crosshair" : "";
    return () => {
      if (el) el.style.cursor = "";
    };
  }, [focusPickMode]);

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

  /**
   * Frame the camera on the loaded splat — SuperSplat-style 3/4 view.
   *
   * Computes the splat's world bounding box, then places the camera at a
   * distance that fits the bbox vertically with the current FOV, offset
   * along (1, 0.5, 1) so the splat reads as a 3/4 perspective rather than
   * straight-on. Aims the camera at the bbox centre and points OrbitControls
   * at the same point so orbit/zoom feels natural.
   *
   * Falls back to a fixed (0, 1.5, 0) pose when no splat is loaded yet.
   */
  const centerCamera = useCallback(() => {
    if (!cameraRef.current) return;
    const camera = cameraRef.current;

    // Try to fit to the splat's bounding box. Spark's SplatMesh exposes
    // `getBoundingBox()` which walks the packed splat data — Box3.setFromObject
    // wouldn't work since SplatMesh doesn't have standard geometry.
    const splat = splatMeshRef.current as
      | (THREE.Object3D & { getBoundingBox?: (centersOnly?: boolean) => THREE.Box3 })
      | null;
    let center: THREE.Vector3 | null = null;
    let distance = 0;
    if (splat?.getBoundingBox) {
      try {
        const bbox = splat.getBoundingBox(false);
        if (
          bbox &&
          Number.isFinite(bbox.min.x) && Number.isFinite(bbox.max.x) &&
          !bbox.isEmpty()
        ) {
          center = bbox.getCenter(new THREE.Vector3());
          // Apply the splat's world transform (it may be scaled/rotated).
          center.applyMatrix4(splat.matrixWorld);
          const size = bbox.getSize(new THREE.Vector3());
          // Account for any uniform scale on the splat object.
          const splatScale = new THREE.Vector3();
          splat.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), splatScale);
          const maxScale = Math.max(splatScale.x, splatScale.y, splatScale.z);
          const radius = Math.max(size.x, size.y, size.z) * 0.5 * maxScale;
          const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
          // Fit-to-vfov distance with a small margin so edges aren't clipped.
          distance = (radius / Math.sin(halfFov)) * 1.15;
        }
      } catch {
        // SplatMesh might not be ready yet — fall through to fixed pose.
      }
    }

    if (center && distance > 0) {
      const offset = new THREE.Vector3(1, 0.5, 1).normalize().multiplyScalar(distance);
      camera.position.copy(center).add(offset);
      camera.lookAt(center);

      // Adapt near/far to the splat's actual extent. Defaults of (0.01, 1000)
      // clip cm-scale splats up close and VP-scale splats far away. Use the
      // framing distance as the reference scale: near at 1/1000 of distance,
      // far at 100×, with floors so we don't go below the original defaults
      // for typical metre-scale splats.
      camera.near = Math.max(0.001, distance / 1000);
      camera.far = Math.max(1000, distance * 100);
      camera.updateProjectionMatrix();

      // Keep the depth-visualization shader's uniforms in sync — it reads
      // cameraNear/cameraFar to linearize the depth buffer.
      const depthMat = depthMaterialRef.current;
      if (depthMat) {
        depthMat.uniforms.cameraNear.value = camera.near;
        depthMat.uniforms.cameraFar.value = camera.far;
      }

      if (controlsRef.current) {
        controlsRef.current.target.copy(center);
        controlsRef.current.update();
      }
      // Sync fly-mode refs from the new orientation (incl. roll).
      const euler = new THREE.Euler();
      euler.setFromQuaternion(camera.quaternion, "YXZ");
      yawRef.current = euler.y;
      pitchRef.current = euler.x;
      rollRef.current = euler.z;
      return;
    }

    // No splat yet — fall back to the original fixed pose.
    if (navModeRef.current === "fly") {
      camera.position.set(0, 1.5, 0);
      yawRef.current = 0;
      pitchRef.current = 0;
      rollRef.current = 0;
      camera.quaternion.setFromEuler(new THREE.Euler(0, 0, 0, "YXZ"));
    } else if (controlsRef.current) {
      camera.position.set(0, 1.5, 0.01);
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

    // DoF post-pass + RT for the blurred result. A second "passthrough"
    // copy of the same shader (with `enabled = 0`) is reused as a cheap
    // texture-blit when we need to copy a colour RT to the canvas without
    // distortion (i.e. DoF on, distortion off).
    const dofPass = createDofPass();
    dofPassRef.current = dofPass;
    const dofPassthrough = createDofPass();
    dofPassthroughRef.current = dofPassthrough;
    const dofTarget = new THREE.WebGLRenderTarget(2, 2, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    dofTargetRef.current = dofTarget;
    // Live depth: two float RTs that mirror the export pair but stay on the
    // GPU. `depthLiveTarget` holds the raw stochastic accumulation; the
    // linearise pass writes the final per-pixel Z (m) into `depthVisLive`.
    const depthLiveTarget = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    depthLiveTargetRef.current = depthLiveTarget;
    const depthVisLiveTarget = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    depthVisLiveTargetRef.current = depthVisLiveTarget;

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

    // ─── Scene helpers ─────────────────────────────────────
    // Ground grid on the XZ plane at y=0. Sized 20m square / 1m divisions —
    // good for typical metre-scale splats. Centre line a touch brighter so
    // the X/Z axes are easy to pick out.
    const gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
    // GridHelper materials are LineBasicMaterial — make them transparent so
    // the splat behind reads cleanly. depthWrite=false so the grid never
    // hides splats above it.
    const gridMats = Array.isArray(gridHelper.material) ? gridHelper.material : [gridHelper.material];
    for (const m of gridMats) {
      const mat = m as THREE.LineBasicMaterial;
      mat.transparent = true;
      mat.opacity = 0.5;
      mat.depthWrite = false;
    }
    scene.add(gridHelper);
    gridHelperRef.current = gridHelper;

    // Origin axes — X red, Y green, Z blue. Default 1m length.
    const axesHelper = new THREE.AxesHelper(1);
    const axesMat = axesHelper.material as THREE.LineBasicMaterial;
    axesMat.transparent = true;
    axesMat.opacity = 0.9;
    axesMat.depthWrite = false;
    scene.add(axesHelper);
    axesHelperRef.current = axesHelper;

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

    /**
     * Click-to-focus: when DoF's "Pick focus" mode is active, the next canvas
     * click runs a one-off full-res depth render and sets `dof.focusM` to the
     * depth under the cursor. Returns true if the click was consumed by pick
     * mode (so the fly-nav drag below is suppressed).
     */
    const tryPickFocus = (e: MouseEvent): boolean => {
      if (!focusPickModeRef.current) return false;
      const cam = cameraRef.current;
      const depthTarget = depthRenderTargetRef.current;
      const depthMat = depthMaterialRef.current;
      const dScene = depthSceneRef.current;
      const dCam = depthCameraRef.current;
      const depthVis = depthVisLiveTargetRef.current;
      if (!cam || !depthTarget || !depthMat || !dScene || !dCam || !depthVis) {
        setFocusPickMode(false);
        return true;
      }

      // Mirror the animate-loop viewport calc so the click maps to the same
      // pixel grid the depth render produces.
      const canvasW = renderer.domElement.clientWidth;
      const canvasH = renderer.domElement.clientHeight;
      const selAspect = selectedAspectRef.current;
      let vpW: number, vpH: number;
      if (canvasW / canvasH > selAspect) {
        vpH = canvasH; vpW = Math.round(canvasH * selAspect);
      } else {
        vpW = canvasW; vpH = Math.round(canvasW / selAspect);
      }
      const vpX = Math.round((canvasW - vpW) / 2);
      const vpY = Math.round((canvasH - vpH) / 2);

      const rect = renderer.domElement.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // Click outside the active viewport: cancel pick mode without picking.
      if (px < vpX || px >= vpX + vpW || py < vpY || py >= vpY + vpH) {
        setFocusPickMode(false);
        return true;
      }

      // Hero-quality 16-pass depth read (~30-50 ms one-off — acceptable for a
      // click event).
      depthTarget.setSize(vpW, vpH);
      depthVis.setSize(vpW, vpH);
      const floatPixels = renderDepthFloat(
        renderer, scene, cam,
        depthTarget, depthMat, dScene, dCam,
        depthVis, vpW, vpH,
      );
      if (!floatPixels) {
        setFocusPickMode(false);
        return true;
      }

      // readRenderTargetPixels uses GL's bottom-left origin; convert from the
      // canvas's top-left CSS pixels.
      const localX = Math.max(0, Math.min(vpW - 1, Math.floor(px - vpX)));
      const localY = Math.max(0, Math.min(vpH - 1, vpH - 1 - Math.floor(py - vpY)));
      const idx = (localY * vpW + localX) * 4;
      const Z = floatPixels[idx];
      if (Number.isFinite(Z) && Z > 0) {
        setDof((d) => ({ ...d, focusM: Z }));
      }
      setFocusPickMode(false);
      return true;
    };

    const onMouseDown = (e: MouseEvent) => {
      // Focus picker gets first dibs — when active, consume the click so the
      // fly-nav drag doesn't kick in mid-pick.
      if (tryPickFocus(e)) return;
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

          // Keep the fractional accumulator in the ref; rounding it back would
          // truncate small per-tick deltas (frameDelta < 0.5 happens whenever
          // fps < refresh-rate, e.g. 24fps on a 60Hz display) and playback
          // would park on frame 0.
          currentFrameRef.current = newFrame;
          const frame = Math.round(newFrame);

          // Apply camera from path
          const evaluated = evaluateCameraPath(path, frame);
          if (evaluated) {
            camera.position.copy(evaluated.position);
            camera.quaternion.copy(evaluated.quaternion);
            camera.fov = evaluated.fov;
            camera.updateProjectionMatrix();

            // Sync yaw/pitch/roll for fly mode. Roll matters for paths whose
            // YXZ decomposition has non-zero z (e.g. Z-up tracks rotated to Y-up
            // by the up-axis toggle); without it the fly branch would zero the
            // roll component on the very next frame and snap the orientation.
            const euler = new THREE.Euler();
            euler.setFromQuaternion(camera.quaternion, "YXZ");
            yawRef.current = euler.y;
            pitchRef.current = euler.x;
            rollRef.current = euler.z;
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
        // Apply yaw/pitch/roll. Roll is preserved across playback so paths
        // whose orientations only express cleanly with non-zero Euler-z
        // (rotated Z-up tracks) don't snap on every animate tick.
        const euler = new THREE.Euler(
          pitchRef.current,
          yawRef.current,
          rollRef.current,
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
      const dofState = dofRef.current;
      const useDof = dofState.enabled && (dofState.showCoC || dofState.fNumber < 32); // a sane upper bound; aperture stops controlling blur past f/32

      // Working resolution for the off-screen chain. Half-res only kicks in
      // when DoF is on (it shrinks both the splat render and the DoF taps —
      // the dominant costs). Distortion alone keeps full-res.
      const halfRes = useDof && dofState.halfRes;
      const passW = halfRes ? Math.max(2, vpW >> 1) : vpW;
      const passH = halfRes ? Math.max(2, vpH >> 1) : vpH;

      // Always start from a fully cleared canvas.
      renderer.setRenderTarget(null);
      renderer.setScissorTest(false);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();

      const needsRT = useDistortion || useDof;

      if (!needsRT) {
        // Fast path: scene direct to canvas (no post chain).
        renderer.setViewport(vpX, vpY, vpW, vpH);
        renderer.setScissor(vpX, vpY, vpW, vpH);
        renderer.setScissorTest(true);
        renderer.render(scene, camera);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, canvasW, canvasH);
        return;
      }

      // ── 1. Scene → colorRT (reuse the distortion target) ────────
      const colorRT = distortionTargetRef.current!;
      if (colorRT.width !== passW || colorRT.height !== passH) {
        colorRT.setSize(passW, passH);
      }
      // FOV margin only matters when distortion is on. Apply it for both the
      // colour and depth passes so their UVs stay aligned.
      let margin = 1;
      if (useDistortion) {
        const measured = distortionScaleRef.current;
        margin = (measured && measured > 0)
          ? measured
          : computeFovMargin({
              width: dist.imageWidth, height: dist.imageHeight,
              fx: dist.fx, fy: dist.fy, cx: dist.cx, cy: dist.cy,
              k1: dist.k1, k2: dist.k2, p1: dist.p1, p2: dist.p2,
            });
      }
      const baseFov = camera.fov;
      const expandFov = () => {
        if (margin <= 1) return;
        const halfRad = THREE.MathUtils.degToRad(baseFov / 2);
        const newHalf = Math.atan(margin * Math.tan(halfRad));
        camera.fov = THREE.MathUtils.radToDeg(newHalf) * 2;
        camera.updateProjectionMatrix();
      };
      const resetFov = () => {
        if (margin <= 1) return;
        camera.fov = baseFov;
        camera.updateProjectionMatrix();
      };

      expandFov();
      renderer.setRenderTarget(colorRT);
      renderer.setViewport(0, 0, passW, passH);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(scene, camera);
      // FOV stays expanded across the depth pass below; reset after that.

      // ── 2. DoF pass (depth render + scatter-as-gather) ───────────
      let currentTex: THREE.Texture = colorRT.texture;
      if (
        useDof &&
        dofPassRef.current &&
        dofTargetRef.current &&
        depthLiveTargetRef.current &&
        depthVisLiveTargetRef.current &&
        depthMaterialRef.current &&
        depthSceneRef.current &&
        depthCameraRef.current
      ) {
        const dofRT = dofTargetRef.current;
        const depthLive = depthLiveTargetRef.current;
        const depthVisLive = depthVisLiveTargetRef.current;
        if (dofRT.width !== passW || dofRT.height !== passH) dofRT.setSize(passW, passH);
        if (depthLive.width !== passW || depthLive.height !== passH) depthLive.setSize(passW, passH);
        if (depthVisLive.width !== passW || depthVisLive.height !== passH) depthVisLive.setSize(passW, passH);

        // Live depth render — 2 stochastic passes, GPU-only (no readPixels).
        renderDepthLive(
          renderer, scene, camera,
          depthLive, depthMaterialRef.current, depthSceneRef.current, depthCameraRef.current,
          depthVisLive, 2,
        );
        resetFov();

        // CoC uniforms — derived from the active camera preset.
        const dofPass = dofPassRef.current;
        const aperture = focalLength / Math.max(0.1, dofState.fNumber);
        const focusM = Math.max(focalLength / 1000 + 0.001, dofState.focusM);
        const pxPerMm = passW / Math.max(0.1, sensor.widthMm);
        dofPass.uniforms.tColor.value = colorRT.texture;
        dofPass.uniforms.tDepth.value = depthVisLive.texture;
        dofPass.uniforms.resolution.value.set(passW, passH);
        dofPass.uniforms.focalMm.value = focalLength;
        dofPass.uniforms.apertureMm.value = aperture;
        dofPass.uniforms.focusM.value = focusM;
        dofPass.uniforms.pxPerMm.value = pxPerMm;
        dofPass.uniforms.maxBlurPx.value = 60;
        dofPass.uniforms.showCoC.value = dofState.showCoC ? 1 : 0;
        dofPass.uniforms.enabled.value = 1;

        renderer.setRenderTarget(dofRT);
        renderer.setViewport(0, 0, passW, passH);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
        renderer.render(dofPass.scene, dofPass.camera);

        currentTex = dofRT.texture;
      } else {
        resetFov();
      }

      // ── 3. Final composite → canvas ─────────────────────────────
      renderer.setRenderTarget(null);
      renderer.setViewport(vpX, vpY, vpW, vpH);
      renderer.setScissor(vpX, vpY, vpW, vpH);
      renderer.setScissorTest(true);

      if (useDistortion && distortionPassRef.current) {
        // Distortion samples `currentTex` (either raw scene or DoF-blurred).
        // The shader works in UV space, so source res can differ from output —
        // half-res DoF still warps cleanly through full-res distortion.
        const pass = distortionPassRef.current;
        const sx = vpW / dist.imageWidth;
        const sy = vpH / dist.imageHeight;
        pass.uniforms.tDiffuse.value = currentTex;
        pass.uniforms.resolution.value.set(vpW, vpH);
        pass.uniforms.fx.value = (dist.fx * sx) * margin;
        pass.uniforms.fy.value = (dist.fy * sy) * margin;
        pass.uniforms.cx.value = dist.cx * sx;
        pass.uniforms.cy.value = dist.cy * sy;
        pass.uniforms.k1.value = dist.k1;
        pass.uniforms.k2.value = dist.k2;
        pass.uniforms.p1.value = dist.p1;
        pass.uniforms.p2.value = dist.p2;
        pass.uniforms.enabled.value = 1;
        renderer.render(pass.scene, pass.camera);
      } else if (dofPassthroughRef.current) {
        // DoF on, distortion off → cheap passthrough blit (DoF shader with
        // enabled=0 short-circuits to `texture2D(tColor, uv)`).
        const blit = dofPassthroughRef.current;
        blit.uniforms.tColor.value = currentTex;
        blit.uniforms.resolution.value.set(vpW, vpH);
        blit.uniforms.enabled.value = 0;
        renderer.render(blit.scene, blit.camera);
      }
      renderer.setScissorTest(false);
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
      dofPass.dispose();
      dofPassthrough.dispose();
      dofTarget.dispose();
      depthLiveTarget.dispose();
      depthVisLiveTarget.dispose();
      dofPassRef.current = null;
      dofPassthroughRef.current = null;
      dofTargetRef.current = null;
      depthLiveTargetRef.current = null;
      depthVisLiveTargetRef.current = null;
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
      // URLs from SpzViewerNode are blob: URLs with no extension; the real
      // filename rides in the `name` query param. Check both.
      const filenameHint =
        new URLSearchParams(window.location.search).get("name") || "";
      splatIsPlyRef.current =
        /\.ply($|\?)/i.test(url) || /\.ply$/i.test(filenameHint);
      // Apply the base PLY rotation now; the user-transform useEffect won't
      // re-fire for this new mesh since splatMeshRef hasn't been assigned yet.
      if (splatIsPlyRef.current) {
        const baseRot = worldFrameToSceneRotation(colmapWorldFrameRef.current);
        (splatMesh as unknown as THREE.Object3D).quaternion.setFromRotationMatrix(baseRot);
      }
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
      splatIsPlyRef.current = /\.ply$/i.test(file.name);
      if (splatIsPlyRef.current) {
        const baseRot = worldFrameToSceneRotation(colmapWorldFrameRef.current);
        (splatMesh as unknown as THREE.Object3D).quaternion.setFromRotationMatrix(baseRot);
      }
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
    // User transform composes on top of the PLY base rotation, which is
    // determined by the user-selected coordinate system (same setting that
    // governs COLMAP track import/export). Quaternion composition so
    // user-controlled Y/Z don't get reordered by Euler axis-order semantics.
    const userQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(transform.rotation.x),
        THREE.MathUtils.degToRad(transform.rotation.y),
        THREE.MathUtils.degToRad(transform.rotation.z),
        "XYZ"
      )
    );
    if (splatIsPlyRef.current) {
      const basePly = new THREE.Quaternion().setFromRotationMatrix(
        worldFrameToSceneRotation(colmapWorldFrame)
      );
      mesh.quaternion.copy(basePly).multiply(userQuat);
    } else {
      mesh.quaternion.copy(userQuat);
    }
    mesh.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
  }, [transform, colmapWorldFrame]);

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

        // Sync fly mode refs (incl. roll, see play-loop comment).
        const euler = new THREE.Euler();
        euler.setFromQuaternion(camera.quaternion, "YXZ");
        yawRef.current = euler.y;
        pitchRef.current = euler.x;
        rollRef.current = euler.z;
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

  /**
   * COLMAP world-frame handler. The loaded keyframes were produced under the
   * previous frame's interpretation; re-interpreting the same source under
   * `next` is equivalent to rotating the scene by
   *   R = worldToScene(next) · worldToScene(prev)^T
   * which we apply to every keyframe and to the live camera so the trajectory
   * stays aligned with the splat after the switch.
   */
  const handleChangeColmapWorldFrame = useCallback(
    (next: ColmapWorldFrame) => {
      const prev = colmapWorldFrameRef.current;
      if (next === prev) return;
      const W_prev = worldFrameToSceneRotation(prev);
      const W_next = worldFrameToSceneRotation(next);
      const rotMat = new THREE.Matrix4().multiplyMatrices(
        W_next,
        W_prev.clone().transpose()
      );
      const rotQuat = new THREE.Quaternion().setFromRotationMatrix(rotMat);
      setCameraPath((path) => ({
        ...path,
        keyframes: path.keyframes.map((kf) => ({
          ...kf,
          position: kf.position.clone().applyMatrix4(rotMat),
          quaternion: rotQuat.clone().multiply(kf.quaternion),
        })),
      }));
      if (cameraRef.current) {
        cameraRef.current.position.applyMatrix4(rotMat);
        cameraRef.current.quaternion.premultiply(rotQuat);
        // Keep yaw/pitch/roll refs in sync for fly mode.
        const euler = new THREE.Euler();
        euler.setFromQuaternion(cameraRef.current.quaternion, "YXZ");
        yawRef.current = euler.y;
        pitchRef.current = euler.x;
        rollRef.current = euler.z;
      }
      setColmapWorldFrame(next);
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

      // Hoisted out of the try so the finally clause can dispose them even
      // if the export throws midway.
      const exportDisposers: Array<() => void> = [];

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

        // Build a post-process chain that mirrors the live viewer's render
        // path: optional DoF blur, then optional Brown-Conrady distortion.
        // Both passes get their own per-export resources (passes + RTs) so
        // they don't clobber the live pipeline running in the background.
        const distSnap = distortionRef.current;
        const useDistortion = distSnap.enabled && (
          distSnap.k1 !== 0 || distSnap.k2 !== 0 || distSnap.p1 !== 0 || distSnap.p2 !== 0
        );
        const dofSnap = dofRef.current;
        const useExportDof = dofSnap.enabled;
        // Capture lens settings for the DoF CoC formula (`focalLength`,
        // `sensor.widthMm` come from the active camera preset in scope).
        const exportFocalMm = focalLength;
        const exportSensorMm = sensor.widthMm;
        let exportPostProcess: Parameters<typeof exportVideo>[0]["postProcess"];
        if (useDistortion || useExportDof) {
          // Distortion needs an FOV margin so the scene render covers the
          // pixels the inverse warp will pull in.
          let margin = 1;
          if (useDistortion) {
            const measuredMargin = distortionScaleRef.current;
            margin = (measuredMargin && measuredMargin > 0)
              ? measuredMargin
              : computeFovMargin({
                  width: distSnap.imageWidth,
                  height: distSnap.imageHeight,
                  fx: distSnap.fx, fy: distSnap.fy,
                  cx: distSnap.cx, cy: distSnap.cy,
                  k1: distSnap.k1, k2: distSnap.k2,
                  p1: distSnap.p1, p2: distSnap.p2,
                });
          }

          const distortionExportPass = useDistortion ? createDistortionPass() : null;
          const dofExportPass = useExportDof ? createDofPass() : null;
          // Blit shader: only used when DoF is on but distortion is off, so we
          // can copy the DoF result into the destination RT.
          const dofExportBlit = (useExportDof && !useDistortion) ? createDofPass() : null;
          if (distortionExportPass) exportDisposers.push(() => distortionExportPass.dispose());
          if (dofExportPass) exportDisposers.push(() => dofExportPass.dispose());
          if (dofExportBlit) exportDisposers.push(() => dofExportBlit.dispose());

          // Lazy private RTs — sized on first apply when (w, h) are known.
          let dofRT: THREE.WebGLRenderTarget | null = null;
          let depthLive: THREE.WebGLRenderTarget | null = null;
          let depthVis: THREE.WebGLRenderTarget | null = null;
          exportDisposers.push(() => { dofRT?.dispose(); depthLive?.dispose(); depthVis?.dispose(); });

          exportPostProcess = {
            prepareCamera: () => {
              if (!useDistortion || margin <= 1) return null;
              const baseFov = camera.fov;
              const halfRad = THREE.MathUtils.degToRad(baseFov / 2);
              const newHalf = Math.atan(margin * Math.tan(halfRad));
              return THREE.MathUtils.radToDeg(newHalf) * 2;
            },
            apply: (rendererArg, src, dst, w, h) => {
              let current: THREE.WebGLRenderTarget = src;

              // ── DoF (if enabled): render depth, run scatter-as-gather ──
              if (
                dofExportPass &&
                depthMaterialRef.current &&
                depthSceneRef.current &&
                depthCameraRef.current
              ) {
                if (!dofRT || dofRT.width !== w || dofRT.height !== h) {
                  dofRT?.dispose();
                  dofRT = new THREE.WebGLRenderTarget(w, h, {
                    format: THREE.RGBAFormat,
                    type: THREE.UnsignedByteType,
                  });
                }
                if (!depthLive || depthLive.width !== w || depthLive.height !== h) {
                  depthLive?.dispose();
                  depthLive = new THREE.WebGLRenderTarget(w, h, {
                    type: THREE.FloatType,
                    format: THREE.RGBAFormat,
                    minFilter: THREE.NearestFilter,
                    magFilter: THREE.NearestFilter,
                    depthBuffer: true,
                  });
                }
                if (!depthVis || depthVis.width !== w || depthVis.height !== h) {
                  depthVis?.dispose();
                  depthVis = new THREE.WebGLRenderTarget(w, h, {
                    type: THREE.FloatType,
                    format: THREE.RGBAFormat,
                    minFilter: THREE.NearestFilter,
                    magFilter: THREE.NearestFilter,
                  });
                }

                // 4 stochastic passes — better quality than the 2-pass live
                // version, still much cheaper than the 16-pass hero depth.
                renderDepthLive(
                  rendererArg, scene, camera,
                  depthLive, depthMaterialRef.current, depthSceneRef.current, depthCameraRef.current,
                  depthVis, 4,
                );

                const aperture = exportFocalMm / Math.max(0.1, dofSnap.fNumber);
                const focusM = Math.max(exportFocalMm / 1000 + 0.001, dofSnap.focusM);
                const pxPerMm = w / Math.max(0.1, exportSensorMm);
                dofExportPass.uniforms.tColor.value = current.texture;
                dofExportPass.uniforms.tDepth.value = depthVis.texture;
                dofExportPass.uniforms.resolution.value.set(w, h);
                dofExportPass.uniforms.focalMm.value = exportFocalMm;
                dofExportPass.uniforms.apertureMm.value = aperture;
                dofExportPass.uniforms.focusM.value = focusM;
                dofExportPass.uniforms.pxPerMm.value = pxPerMm;
                dofExportPass.uniforms.maxBlurPx.value = 60;
                dofExportPass.uniforms.showCoC.value = 0; // never debug overlay in export
                dofExportPass.uniforms.enabled.value = 1;

                rendererArg.setRenderTarget(dofRT);
                rendererArg.setViewport(0, 0, w, h);
                rendererArg.setClearColor(0x000000, 1);
                rendererArg.clear();
                rendererArg.render(dofExportPass.scene, dofExportPass.camera);
                current = dofRT;
              }

              // ── Distortion (if enabled) or DoF-only passthrough blit ──
              if (distortionExportPass) {
                const sx = w / distSnap.imageWidth;
                const sy = h / distSnap.imageHeight;
                distortionExportPass.uniforms.tDiffuse.value = current.texture;
                distortionExportPass.uniforms.resolution.value.set(w, h);
                distortionExportPass.uniforms.fx.value = (distSnap.fx * sx) * margin;
                distortionExportPass.uniforms.fy.value = (distSnap.fy * sy) * margin;
                distortionExportPass.uniforms.cx.value = distSnap.cx * sx;
                distortionExportPass.uniforms.cy.value = distSnap.cy * sy;
                distortionExportPass.uniforms.k1.value = distSnap.k1;
                distortionExportPass.uniforms.k2.value = distSnap.k2;
                distortionExportPass.uniforms.p1.value = distSnap.p1;
                distortionExportPass.uniforms.p2.value = distSnap.p2;
                distortionExportPass.uniforms.enabled.value = 1;
                rendererArg.setRenderTarget(dst);
                rendererArg.setViewport(0, 0, w, h);
                rendererArg.setClearColor(0x000000, 1);
                rendererArg.clear();
                rendererArg.render(distortionExportPass.scene, distortionExportPass.camera);
              } else if (dofExportBlit) {
                dofExportBlit.uniforms.tColor.value = current.texture;
                dofExportBlit.uniforms.resolution.value.set(w, h);
                dofExportBlit.uniforms.enabled.value = 0;
                rendererArg.setRenderTarget(dst);
                rendererArg.setViewport(0, 0, w, h);
                rendererArg.setClearColor(0x000000, 1);
                rendererArg.clear();
                rendererArg.render(dofExportBlit.scene, dofExportBlit.camera);
              }
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
            focalLength,
            colmapWorldFrameRef.current
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
        // Dispose any post-process resources (shaders + RTs) allocated for
        // this export run. Live preview keeps its own separate instances.
        for (const fn of exportDisposers) {
          try { fn(); } catch { /* ignore */ }
        }
      }
    },
    [cameraPath, worldName, sensor.widthMm, focalLength, captureDepthFrameForExport]
  );

  // ─── COLMAP import handler ──────────────────────────────────────

  const handleColmapImport = useCallback(async (file: File) => {
    try {
      const blob = new Blob([await file.arrayBuffer()]);
      // World-frame conversion (Z-up / Y-down / Y-up → scene) happens inside
      // importColmap. We only need to apply the user's camera-scale here.
      const { path: importedPath, cameraParams } = await importColmap(
        blob,
        cameraPath.fps,
        colmapWorldFrameRef.current
      );

      const scale = cameraScaleRef.current;
      const needsScale = scale !== 1;
      const scaledPath: CameraPath = !needsScale
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
        rollRef.current = euler.z;
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

              {/* Depth-of-field (thin-lens, scatter-as-gather disk blur).
                  Aperture + focus distance drive a 24-tap CoC blur on every
                  frame. Click "Pick" to set focus by clicking in the viewport. */}
              <div className="mt-2 pt-2 border-t border-neutral-800">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[9px] text-neutral-500">Depth of field</label>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setDof((d) => ({ ...d, fNumber: 2.8, focusM: 3.0, halfRes: false, showCoC: false }))}
                      className="text-[9px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
                      title="Reset DoF params"
                    >
                      Reset
                    </button>
                    <button
                      onClick={() => setDof((d) => ({ ...d, enabled: !d.enabled }))}
                      className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                        dof.enabled
                          ? "bg-indigo-600 text-white"
                          : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                      }`}
                    >
                      {dof.enabled ? "On" : "Off"}
                    </button>
                  </div>
                </div>
                {dof.enabled && (
                  <div className="flex flex-col gap-1">
                    {/* f-number (log 1.4 → 22) */}
                    <div className="flex items-center gap-1">
                      <label className="text-[9px] text-neutral-500 w-[26px] shrink-0">f/</label>
                      <input
                        type="range"
                        min={Math.log10(1.4)}
                        max={Math.log10(22)}
                        step={0.001}
                        value={Math.log10(dof.fNumber)}
                        onChange={(e) => setDof((d) => ({ ...d, fNumber: Math.pow(10, parseFloat(e.target.value)) }))}
                        className="flex-1 h-1 accent-indigo-500 cursor-pointer min-w-0"
                      />
                      <input
                        type="number"
                        step={0.1}
                        min={1}
                        value={Number(dof.fNumber.toFixed(2))}
                        onChange={(e) => {
                          const n = parseFloat(e.target.value);
                          if (Number.isFinite(n) && n > 0) setDof((d) => ({ ...d, fNumber: n }));
                        }}
                        className="w-[52px] shrink-0 text-[9px] py-0.5 px-1 rounded bg-neutral-800 text-neutral-200 border border-neutral-700 focus:border-indigo-500 focus:outline-none tabular-nums"
                      />
                    </div>
                    {/* Focus distance (log 0.1 → 100 m) */}
                    <div className="flex items-center gap-1">
                      <label className="text-[9px] text-neutral-500 w-[26px] shrink-0">focus</label>
                      <input
                        type="range"
                        min={Math.log10(0.1)}
                        max={Math.log10(100)}
                        step={0.001}
                        value={Math.log10(Math.max(0.1, dof.focusM))}
                        onChange={(e) => setDof((d) => ({ ...d, focusM: Math.pow(10, parseFloat(e.target.value)) }))}
                        className="flex-1 h-1 accent-indigo-500 cursor-pointer min-w-0"
                      />
                      <input
                        type="number"
                        step={0.01}
                        min={0}
                        value={Number(dof.focusM.toFixed(3))}
                        onChange={(e) => {
                          const n = parseFloat(e.target.value);
                          if (Number.isFinite(n) && n > 0) setDof((d) => ({ ...d, focusM: n }));
                        }}
                        className="w-[52px] shrink-0 text-[9px] py-0.5 px-1 rounded bg-neutral-800 text-neutral-200 border border-neutral-700 focus:border-indigo-500 focus:outline-none tabular-nums"
                      />
                    </div>
                    {/* Pick focus + half-res + show-CoC row */}
                    <div className="flex items-center gap-2 mt-0.5">
                      <button
                        onClick={() => setFocusPickMode((m) => !m)}
                        title="Click in the viewport to set focus there"
                        className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                          focusPickMode
                            ? "bg-amber-500 text-neutral-900"
                            : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                        }`}
                      >
                        {focusPickMode ? "Click to focus…" : "Pick focus"}
                      </button>
                      <label className="text-[9px] text-neutral-400 flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={dof.halfRes}
                          onChange={(e) => setDof((d) => ({ ...d, halfRes: e.target.checked }))}
                          className="accent-indigo-500"
                        />
                        ½-res
                      </label>
                      <label className="text-[9px] text-neutral-400 flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={dof.showCoC}
                          onChange={(e) => setDof((d) => ({ ...d, showCoC: e.target.checked }))}
                          className="accent-indigo-500"
                        />
                        Show CoC
                      </label>
                    </div>
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
                {/* COLMAP world-frame convention. Applied on both import
                    (source → scene) and export (scene → file), so round-trips
                    stay consistent. Switching at runtime rotates the loaded
                    path to keep it aligned with the splat. */}
                <div
                  className="mt-2 flex items-center gap-2"
                  title="Coordinate system of the original capture. Applied to imported and exported COLMAP camera tracks, and to PLY splats at load (SPZ uses its embedded metadata)."
                >
                  <label className="text-[9px] text-neutral-500 shrink-0">Coordinate system</label>
                  <select
                    value={colmapWorldFrame}
                    onChange={(e) => handleChangeColmapWorldFrame(e.target.value as ColmapWorldFrame)}
                    className="flex-1 min-w-0 text-[10px] py-0.5 px-1 rounded bg-neutral-800 text-neutral-200 border border-neutral-700 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="y-down" title="Raw COLMAP, OpenCV, OpenSfM, hloc, pixsfm. Camera-frame convention: +X right, +Y down, +Z forward. This is the COLMAP spec default.">
                      COLMAP / OpenCV (Y-down)
                    </option>
                    <option value="y-up" title="glTF, Three.js, Maya, Unity, USD-Y. +X right, +Y up, +Z back. Use for files exported from a Y-up DCC or round-tripped through this viewer.">
                      glTF / Three.js (Y-up)
                    </option>
                    <option value="z-up" title="Blender, Unreal, RealityCapture, Metashape, Postshot, 3ds Max. +X right, +Y forward, +Z up.">
                      Blender / Unreal / RealityCapture (Z-up)
                    </option>
                  </select>
                </div>
              </div>

              {/* Scene helpers — ground grid and origin axes. Frame button
                  re-fits the camera to the loaded splat (SuperSplat-style 3/4 view). */}
              <div className="mt-2 pt-2 border-t border-neutral-800 flex items-center gap-2 flex-wrap">
                <label className="text-[9px] text-neutral-500">Helpers</label>
                <button
                  onClick={() => setShowGrid((v) => !v)}
                  className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                    showGrid
                      ? "bg-indigo-600 text-white"
                      : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                  }`}
                  title="Toggle ground grid (XZ plane)"
                >
                  Grid
                </button>
                <button
                  onClick={() => setShowAxes((v) => !v)}
                  className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                    showAxes
                      ? "bg-indigo-600 text-white"
                      : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                  }`}
                  title="Toggle origin axes (X red, Y green, Z blue)"
                >
                  Axes
                </button>
                <button
                  onClick={() => centerCamera()}
                  className="text-[10px] px-2 py-0.5 rounded bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
                  title="Frame the camera on the splat (SuperSplat-style 3/4 view)"
                >
                  Frame
                </button>
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
