"use client";

/**
 * Spark.js 3D Gaussian Splatting Viewer
 *
 * Full-screen cinematic viewer for WorldLabs-generated 3D worlds.
 * Features:
 *   - Sensor/lens/aspect ratio presets → real-time FOV updates
 *   - Capture button → sends screenshot to parent window as ImageInput node
 *   - Quality selector for SPZ resolution (100k/500k/full_res)
 *   - OrbitControls for camera interaction
 */

import { useEffect, useRef, useState, useCallback, use } from "react";
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

// ─── Types ──────────────────────────────────────────────────────

interface WorldData {
  worldId: string;
  spzUrls: { full_res: string | null; "500k": string | null; "100k": string | null };
  thumbnailUrl: string | null;
  panoUrl: string | null;
  caption: string | null;
}

type QualityLevel = "100k" | "500k" | "full_res";

const QUALITY_LABELS: Record<QualityLevel, string> = {
  "100k": "100K",
  "500k": "500K",
  "full_res": "Full",
};

// ─── Page Component ─────────────────────────────────────────────

export default function ViewerPage({
  params,
}: {
  params: Promise<{ worldId: string }>;
}) {
  const { worldId } = use(params);

  // State
  const [worldData, setWorldData] = useState<WorldData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sensorIndex, setSensorIndex] = useState(DEFAULT_SENSOR_INDEX);
  const [lensIndex, setLensIndex] = useState(DEFAULT_LENS_INDEX);
  const [aspectIndex, setAspectIndex] = useState(DEFAULT_ASPECT_RATIO_INDEX);
  const [quality, setQuality] = useState<QualityLevel>("500k");
  const [splatLoaded, setSplatLoaded] = useState(false);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [showControls, setShowControls] = useState(true);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animationIdRef = useRef<number>(0);
  const splatMeshRef = useRef<unknown>(null);

  // Read world name from URL params
  const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const worldName = searchParams?.get("name") || "Untitled World";

  // Current camera settings
  const sensor = SENSOR_PRESETS[sensorIndex];
  const focalLength = LENS_FOCAL_LENGTHS[lensIndex];
  const aspectRatio = ASPECT_RATIO_PRESETS[aspectIndex];
  const vFov = calculateCameraFOV(sensor.widthMm, focalLength, aspectRatio.ratio);

  // ─── Fetch world data ─────────────────────────────────────────

  useEffect(() => {
    async function fetchWorld() {
      try {
        const response = await fetch("/api/worldlabs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "getWorld", worldId }),
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch world: ${response.status}`);
        }

        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || "Failed to fetch world");
        }

        setWorldData({
          worldId: data.worldId,
          spzUrls: data.spzUrls,
          thumbnailUrl: data.thumbnailUrl,
          panoUrl: data.panoUrl,
          caption: data.caption,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load world");
      } finally {
        setLoading(false);
      }
    }

    fetchWorld();
  }, [worldId]);

  // ─── Initialize Three.js scene ────────────────────────────────

  useEffect(() => {
    if (!containerRef.current || !worldData) return;

    const container = containerRef.current;

    // Renderer
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true, // Required for toDataURL captures
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
    camera.position.set(0, 0, 3);
    cameraRef.current = camera;

    // OrbitControls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.8;
    controls.panSpeed = 0.5;
    controlsRef.current = controls;

    // Ambient light
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));

    // Load SPZ via Spark.js (dynamic import to avoid SSR)
    loadSplat(scene, worldData, quality);

    // Animation loop
    function animate() {
      animationIdRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    // Resize handler
    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(animationIdRef.current);
      window.removeEventListener("resize", handleResize);
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldData]);

  // ─── Load splat file ──────────────────────────────────────────

  async function loadSplat(scene: THREE.Scene, data: WorldData, q: QualityLevel) {
    const url = data.spzUrls[q] || data.spzUrls["500k"] || data.spzUrls["100k"] || data.spzUrls.full_res;
    if (!url) {
      setError("No SPZ URL available for this world");
      return;
    }

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
        },
      });

      await splatMesh.initialized;
      scene.add(splatMesh);
      splatMeshRef.current = splatMesh;

      // Auto-fit camera to splat bounds
      const box = splatMesh.getBoundingBox?.();
      if (box && cameraRef.current && controlsRef.current) {
        const center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);

        controlsRef.current.target.copy(center);
        cameraRef.current.position.copy(
          center.clone().add(new THREE.Vector3(0, maxDim * 0.3, maxDim * 1.2))
        );
        controlsRef.current.update();
      }
    } catch (err) {
      console.error("Failed to load splat:", err);
      setError(`Failed to load 3D scene: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  // ─── Update camera FOV when settings change ───────────────────

  useEffect(() => {
    if (!cameraRef.current) return;
    cameraRef.current.fov = vFov;
    cameraRef.current.updateProjectionMatrix();
  }, [vFov]);

  // ─── Quality change → reload splat ────────────────────────────

  useEffect(() => {
    if (!sceneRef.current || !worldData || !splatLoaded) return;
    setSplatLoaded(false);
    loadSplat(sceneRef.current, worldData, quality);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality]);

  // ─── Capture screenshot ───────────────────────────────────────

  const handleCapture = useCallback(() => {
    if (!rendererRef.current || !cameraRef.current || !sceneRef.current) return;

    // Force a render to ensure the buffer is fresh
    rendererRef.current.render(sceneRef.current, cameraRef.current);

    const canvas = rendererRef.current.domElement;
    const image = canvas.toDataURL("image/png");
    const id = Math.random().toString(36).substring(2, 6);
    const cameraSegment = getCameraFilenameSegment(sensor, focalLength);
    const nameSlug = worldName.replace(/[^a-zA-Z0-9]/g, "");
    const filename = `${nameSlug}_${cameraSegment}_${id}`;

    // Flash effect
    setCaptureFlash(true);
    setTimeout(() => setCaptureFlash(false), 200);

    // Send to parent window
    if (window.opener) {
      window.opener.postMessage(
        {
          type: "worldlabs-capture",
          worldId,
          image,
          filename,
          width: canvas.width,
          height: canvas.height,
        },
        window.location.origin
      );
    }
  }, [worldId, worldName, sensor, focalLength]);

  // ─── Keyboard shortcuts ───────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        handleCapture();
      }
      if (e.key === "h" || e.key === "H") {
        setShowControls((s) => !s);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleCapture]);

  // ─── Loading / Error States ───────────────────────────────────

  if (loading) {
    return (
      <div className="fixed inset-0 bg-neutral-950 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-neutral-400 text-sm">Loading world...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 bg-neutral-950 flex items-center justify-center">
        <div className="text-center max-w-md px-6">
          <p className="text-red-400 text-sm mb-2">Failed to load world</p>
          <p className="text-neutral-500 text-xs">{error}</p>
        </div>
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 bg-neutral-950 overflow-hidden select-none">
      {/* Three.js canvas container */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Capture flash overlay */}
      {captureFlash && (
        <div className="absolute inset-0 bg-white/30 pointer-events-none transition-opacity duration-200" />
      )}

      {/* Top bar — world info */}
      <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/60 to-transparent p-4 pointer-events-none">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-white text-sm font-medium">{worldName}</h1>
            <p className="text-neutral-400 text-[10px]">
              {sensor.name} · {focalLength}mm · {aspectRatio.name} · {vFov.toFixed(1)}° vFOV
            </p>
          </div>
          {!splatLoaded && (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 border border-indigo-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-indigo-400 text-xs">Loading scene...</span>
            </div>
          )}
        </div>
      </div>

      {/* Controls Panel */}
      {showControls && (
        <div className="absolute bottom-4 left-4 right-4 pointer-events-none">
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

              {/* Quality */}
              <div className="mt-2 flex items-center gap-2">
                <label className="text-[9px] text-neutral-500">Quality</label>
                <div className="flex gap-1">
                  {(["100k", "500k", "full_res"] as const).map((q) => (
                    <button
                      key={q}
                      onClick={() => setQuality(q)}
                      className={`text-[10px] px-2 py-0.5 rounded ${
                        quality === q
                          ? "bg-indigo-600 text-white"
                          : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                      } transition-colors`}
                    >
                      {QUALITY_LABELS[q]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Capture Button */}
            <button
              onClick={handleCapture}
              disabled={!splatLoaded}
              className="bg-red-600 hover:bg-red-500 disabled:bg-neutral-700 disabled:cursor-not-allowed text-white rounded-full w-14 h-14 flex items-center justify-center pointer-events-auto shadow-lg transition-all active:scale-95"
              title="Capture frame (Space / Enter)"
            >
              <div className="w-10 h-10 border-2 border-white rounded-full flex items-center justify-center">
                <div className="w-6 h-6 bg-white rounded-full" />
              </div>
            </button>
          </div>
        </div>
      )}

      {/* Toggle controls hint */}
      <div className="absolute top-4 right-4 pointer-events-none">
        <p className="text-neutral-600 text-[9px]">
          Press H to {showControls ? "hide" : "show"} controls · Space to capture
        </p>
      </div>
    </div>
  );
}
