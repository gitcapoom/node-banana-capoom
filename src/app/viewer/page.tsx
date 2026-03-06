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
  const [worldName, setWorldName] = useState("SPZ Viewer");
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

    // Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(
      vFov,
      container.clientWidth / container.clientHeight,
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

      renderer.render(scene, camera);
    }
    animate(0);

    // Resize handler
    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);

      // Resize depth render target to match
      const pixelRatio = Math.min(window.devicePixelRatio, 2);
      depthTarget.setSize(w * pixelRatio, h * pixelRatio);
    };
    window.addEventListener("resize", handleResize);

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
    if (!cameraRef.current) return;
    cameraRef.current.fov = vFov;
    cameraRef.current.updateProjectionMatrix();
  }, [vFov]);

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
      setCameraPath((prev) => ({ ...prev, fps }));
    },
    []
  );

  // ─── Depth capture helper for video export ──────────────────────

  const captureDepthFrameForExport = useCallback(
    (
      renderer: THREE.WebGLRenderer,
      scene: THREE.Scene,
      camera: THREE.PerspectiveCamera,
      w: number,
      h: number
    ): ImageData | null => {
      const depthTarget = depthRenderTargetRef.current;
      const depthMat = depthMaterialRef.current;
      const dScene = depthSceneRef.current;
      const depthCam = depthCameraRef.current;
      if (!depthTarget || !depthMat || !dScene || !depthCam) return null;

      // Resize depth target to match export resolution
      depthTarget.setSize(w, h);

      const dataUrl = captureDepthImage(
        renderer, scene, camera,
        depthTarget, depthMat, dScene, depthCam,
        w, h, 0, 0, w, h
      );
      if (!dataUrl) return null;

      // Convert data URL to ImageData
      const img = new Image();
      img.src = dataUrl;
      // Since toDataURL is synchronous from canvas, we can draw immediately
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = w;
      tempCanvas.height = h;
      const ctx = tempCanvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, w, h);
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

        const result = await exportVideo({
          renderer,
          scene,
          camera,
          path: exportPath,
          mode: settings.mode,
          resolution: settings.resolution,
          captureDepthFrame:
            settings.mode === "depth" || settings.mode === "both"
              ? captureDepthFrameForExport
              : undefined,
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
      setCameraPath(importedPath);
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
      }

      // Apply first keyframe camera
      if (importedPath.keyframes.length > 0 && cameraRef.current) {
        const kf = importedPath.keyframes[0];
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
            SPZ Viewer
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

      {/* Framing overlay — letterbox/pillarbox bars for selected aspect ratio */}
      {splatLoaded && (() => {
        const viewW = containerRef.current?.clientWidth ?? 16;
        const viewH = containerRef.current?.clientHeight ?? 9;
        const viewportAspect = viewW / viewH;
        const selectedAspect = aspectRatio.ratio;
        if (Math.abs(viewportAspect - selectedAspect) < 0.01) return null;

        if (selectedAspect > viewportAspect) {
          // Letterbox: bars on top and bottom
          const activeH = viewW / selectedAspect;
          const barH = Math.max(0, (viewH - activeH) / 2);
          return (
            <>
              <div className="absolute left-0 right-0 top-0 pointer-events-none z-[4]" style={{ height: barH, background: "rgba(0,0,0,0.55)" }}>
                <div className="absolute bottom-0 left-0 right-0 h-px bg-neutral-500/40" />
              </div>
              <div className="absolute left-0 right-0 bottom-0 pointer-events-none z-[4]" style={{ height: barH, background: "rgba(0,0,0,0.55)" }}>
                <div className="absolute top-0 left-0 right-0 h-px bg-neutral-500/40" />
              </div>
            </>
          );
        } else {
          // Pillarbox: bars on left and right
          const activeW = viewH * selectedAspect;
          const barW = Math.max(0, (viewW - activeW) / 2);
          return (
            <>
              <div className="absolute top-0 bottom-0 left-0 pointer-events-none z-[4]" style={{ width: barW, background: "rgba(0,0,0,0.55)" }}>
                <div className="absolute right-0 top-0 bottom-0 w-px bg-neutral-500/40" />
              </div>
              <div className="absolute top-0 bottom-0 right-0 pointer-events-none z-[4]" style={{ width: barW, background: "rgba(0,0,0,0.55)" }}>
                <div className="absolute left-0 top-0 bottom-0 w-px bg-neutral-500/40" />
              </div>
            </>
          );
        }
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
          <div>
            <h1 className="text-white text-sm font-medium">{worldName}</h1>
            <p className="text-neutral-400 text-[10px]">
              {sensor.name} · {focalLength}mm · {aspectRatio.name} · {vFov.toFixed(1)}° vFOV
            </p>
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

            {/* Right side buttons */}
            <div className="flex items-center gap-2 pointer-events-auto">
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
