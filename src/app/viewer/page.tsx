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
 *   - OrbitControls for camera interaction
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

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animationIdRef = useRef<number>(0);
  const splatMeshRef = useRef<unknown>(null);
  const initRef = useRef(false);

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
      setLoading(false);
    }
  }, [initScene]);

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
        },
      });

      await splatMesh.initialized;
      scene.add(splatMesh);
      splatMeshRef.current = splatMesh;

      // Auto-fit camera
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
      console.error("Failed to load splat file:", err);
      setError(`Failed to load file: ${err instanceof Error ? err.message : "Unknown error"}`);
      setLoading(false);
    }
  }, [initScene]);

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
    if (!rendererRef.current || !cameraRef.current || !sceneRef.current) return;

    rendererRef.current.render(sceneRef.current, cameraRef.current);

    const canvas = rendererRef.current.domElement;
    const image = canvas.toDataURL("image/png");
    const captureId = Math.random().toString(36).substring(2, 6);
    const cameraSegment = getCameraFilenameSegment(sensor, focalLength);
    const nameSlug = worldName.replace(/[^a-zA-Z0-9]/g, "");
    const filename = `${nameSlug}_${cameraSegment}_${captureId}`;

    // Flash effect
    setCaptureFlash(true);
    setTimeout(() => setCaptureFlash(false), 200);

    // Send to parent window if opened from Node Banana
    if (window.opener && worldId) {
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
    } else {
      // Download directly if no parent window
      const link = document.createElement("a");
      link.download = `${filename}.png`;
      link.href = image;
      link.click();
    }
  }, [worldId, worldName, sensor, focalLength]);

  // ─── Keyboard shortcuts ────────────────────────────────────────

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
      if (file.name.endsWith(".spz")) {
        loadSplatFromFile(file);
      } else {
        setError("Please drop a .spz file");
      }
    }
  }, [loadSplatFromFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.name.endsWith(".spz")) {
        loadSplatFromFile(file);
      } else {
        setError("Please select a .spz file");
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
            Drag and drop a <code className="text-indigo-400">.spz</code> file here
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
              accept=".spz"
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
          <p className="text-indigo-300 text-lg font-medium">Drop .spz file here</p>
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
      <div className="absolute top-4 right-4 pointer-events-none z-5">
        <p className="text-neutral-600 text-[9px]">
          Press H to {showControls ? "hide" : "show"} controls · Space to capture
          {!worldId && " · Drop .spz to load"}
        </p>
      </div>
    </div>
  );
}
