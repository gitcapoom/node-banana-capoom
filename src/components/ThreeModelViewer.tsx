"use client";

import { useRef, useState, useEffect, useCallback, Suspense, useMemo } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  SENSOR_PRESETS,
  LENS_FOCAL_LENGTHS,
  ASPECT_RATIO_PRESETS,
  calculateCameraFOV,
  DEFAULT_SENSOR_INDEX,
  DEFAULT_LENS_INDEX,
} from "@/utils/cinemaCameraPresets";

/** Default aspect ratio index for the 3D viewer (16:9) */
const DEFAULT_3D_ASPECT_INDEX = 2;

/**
 * Renders a loaded GLB model using the raw GLTFLoader.
 * Normalizes bounding box and fits camera.
 */
function Model({ url, onError, modelLoadedRef }: { url: string; onError?: () => void; modelLoadedRef?: React.MutableRefObject<boolean> }) {
  const groupRef = useRef<THREE.Group>(null);
  const sceneRef = useRef<THREE.Group | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { camera, invalidate } = useThree();

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    if (modelLoadedRef) modelLoadedRef.current = false;

    const loader = new GLTFLoader();
    try {
      loader.load(
        url,
        (gltf) => {
          if (cancelled) return;

          const loadedScene = gltf.scene;

          // Compute bounding box and normalize
          const box = new THREE.Box3().setFromObject(loadedScene);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);

          if (maxDim > 0) {
            const scale = 2 / maxDim;
            loadedScene.scale.setScalar(scale);
            loadedScene.position.set(
              -center.x * scale,
              -center.y * scale,
              -center.z * scale
            );
          }

          sceneRef.current = loadedScene;
          setLoaded(true);
          if (modelLoadedRef) modelLoadedRef.current = true;

          // Fit camera to model
          const dist = 3.5;
          camera.position.set(dist, dist * 0.6, dist);
          camera.lookAt(0, 0, 0);
          // On-demand frameloop: nothing repaints unless we ask.
          invalidate();
        },
        undefined,
        (error) => {
          if (cancelled) return;
          console.warn("GLB load failed:", error);
          onError?.();
        }
      );
    } catch {
      if (!cancelled) onError?.();
    }

    return () => {
      cancelled = true;
      if (modelLoadedRef) modelLoadedRef.current = false;
      if (sceneRef.current) {
        sceneRef.current.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            try { obj.geometry?.dispose(); } catch (e) { console.warn("GLB geometry dispose failed:", e); }
            try {
              if (Array.isArray(obj.material)) {
                obj.material.forEach((m) => { m.dispose(); });
              } else {
                obj.material?.dispose();
              }
            } catch (e) { console.warn("GLB material dispose failed:", e); }
          }
        });
        sceneRef.current = null;
      }
    };
  }, [url, camera, onError, invalidate]);

  if (!loaded || !sceneRef.current) return null;

  return (
    <group ref={groupRef}>
      <primitive object={sceneRef.current} />
    </group>
  );
}

/**
 * Environment lighting — hidden during capture via ref.
 */
function SceneEnvironment({ groupRef }: { groupRef: React.RefObject<THREE.Group | null> }) {
  return (
    <group ref={groupRef}>
      <spotLight
        position={[5, 8, 5]}
        angle={0.4}
        penumbra={0.8}
        intensity={1.5}
        castShadow
      />
    </group>
  );
}

/**
 * Helper component inside Canvas to expose the gl context for capture.
 * Hides environment objects before rendering the capture frame.
 * When a background image is present, composites it behind the transparent
 * 3D canvas using an offscreen canvas (CSS background is not captured by WebGL).
 */
function CaptureHelper({
  captureRef,
  envGroupRef,
  backgroundImageUrl,
  targetAspectRatio,
}: {
  captureRef: React.MutableRefObject<(() => string | null) | null>;
  envGroupRef: React.RefObject<THREE.Group | null>;
  backgroundImageUrl?: string | null;
  /** When set, crops the captured frame to this aspect ratio (width/height) */
  targetAspectRatio?: number;
}) {
  const { gl, scene, camera, invalidate } = useThree();
  const bgImageRef = useRef<HTMLImageElement | null>(null);

  // Preload background image for compositing into frame grabs
  useEffect(() => {
    if (!backgroundImageUrl) {
      bgImageRef.current = null;
      return;
    }
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { bgImageRef.current = img; invalidate(); };
    img.onerror = () => { bgImageRef.current = null; };
    img.src = backgroundImageUrl;
    return () => { bgImageRef.current = null; };
  }, [backgroundImageUrl, invalidate]);

  // Publish the capture closure once per dependency change. This used to run in
  // useFrame — rebuilding the closure 60x/second forever, and forcing the whole
  // canvas onto an always-on render loop just to keep a function reference warm.
  useEffect(() => {
    captureRef.current = () => {
      try {
        if (envGroupRef.current) {
          envGroupRef.current.visible = false;
        }
        gl.render(scene, camera);

        // Full viewport dimensions
        const fullW = gl.domElement.width;
        const fullH = gl.domElement.height;

        // Compute crop region matching the selected aspect ratio (same math as letterboxing)
        let cropX = 0, cropY = 0, cropW = fullW, cropH = fullH;
        if (targetAspectRatio) {
          const viewAspect = fullW / fullH;
          if (targetAspectRatio > viewAspect) {
            // Letterbox: crop top/bottom
            cropH = Math.round(fullW / targetAspectRatio);
            cropY = Math.round((fullH - cropH) / 2);
          } else if (targetAspectRatio < viewAspect) {
            // Pillarbox: crop left/right
            cropW = Math.round(fullH * targetAspectRatio);
            cropX = Math.round((fullW - cropW) / 2);
          }
        }

        // Create output canvas at the cropped dimensions
        const outW = cropW;
        const outH = cropH;
        const offscreen = document.createElement("canvas");
        offscreen.width = outW;
        offscreen.height = outH;
        const ctx = offscreen.getContext("2d");
        if (!ctx) {
          if (envGroupRef.current) envGroupRef.current.visible = true;
          return gl.domElement.toDataURL("image/png");
        }

        // Fill dark background
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(0, 0, outW, outH);

        // Draw background image with contain mode (fitted within cropped area)
        const bgImg = bgImageRef.current;
        if (bgImg) {
          const imgAspect = bgImg.naturalWidth / bgImg.naturalHeight;
          const outAspect = outW / outH;
          let drawW: number, drawH: number, drawX: number, drawY: number;
          if (imgAspect > outAspect) {
            drawW = outW;
            drawH = outW / imgAspect;
            drawX = 0;
            drawY = (outH - drawH) / 2;
          } else {
            drawH = outH;
            drawW = outH * imgAspect;
            drawX = (outW - drawW) / 2;
            drawY = 0;
          }
          ctx.drawImage(bgImg, drawX, drawY, drawW, drawH);
        }

        // Draw 3D canvas (cropped region) on top
        ctx.drawImage(gl.domElement, cropX, cropY, cropW, cropH, 0, 0, outW, outH);

        if (envGroupRef.current) {
          envGroupRef.current.visible = true;
        }
        return offscreen.toDataURL("image/png");
      } catch (err) {
        console.warn("3D capture failed:", err);
        if (envGroupRef.current) {
          envGroupRef.current.visible = true;
        }
        return null;
      }
    };
  }, [captureRef, envGroupRef, gl, scene, camera, targetAspectRatio]);

  return null;
}

/**
 * Auto-capture: after model loads, wait a few frames then capture once.
 * Uses modelLoadedRef to ensure capture only happens after the GLB is fully parsed and rendered.
 */
function AutoCaptureHelper({
  captureRef,
  onAutoCapture,
  modelLoadedRef,
}: {
  captureRef: React.MutableRefObject<(() => string | null) | null>;
  onAutoCapture: (imageDataUrl: string) => void;
  modelLoadedRef: React.MutableRefObject<boolean>;
}) {
  const frameCount = useRef(0);
  const captured = useRef(false);

  useFrame(() => {
    if (captured.current) return;

    // Don't start counting until the model is fully loaded
    if (!modelLoadedRef.current) {
      frameCount.current = 0;
      return;
    }

    frameCount.current++;
    // Wait 5 frames after model load for shaders to compile and scene to stabilize
    if (frameCount.current >= 5 && captureRef.current) {
      const result = captureRef.current();
      if (result) {
        captured.current = true;
        onAutoCapture(result);
      }
    }
  });

  return null;
}

/**
 * Auto-rotate the model slowly when not interacting.
 */
function AutoRotate({ enabled }: { enabled: boolean }) {
  const { camera } = useThree();

  useFrame((_, delta) => {
    if (!enabled) return;
    const angle = delta * 0.3;
    const pos = camera.position.clone();
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    camera.position.x = pos.x * cos - pos.z * sin;
    camera.position.z = pos.x * sin + pos.z * cos;
    camera.lookAt(0, 0, 0);
  });

  return null;
}

/**
 * Loading indicator (wireframe sphere) shown while GLB is parsing.
 */
function LoadingIndicator() {
  return (
    <mesh>
      <sphereGeometry args={[0.2, 16, 16]} />
      <meshBasicMaterial color="#666" wireframe />
    </mesh>
  );
}

/**
 * Reactively updates camera.fov when cinema settings change.
 */
function CameraFOVUpdater({ fov }: { fov: number }) {
  const { camera, invalidate } = useThree();

  useEffect(() => {
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
      invalidate(); // on-demand frameloop — repaint with the new framing
    }
  }, [camera, fov, invalidate]);

  return null;
}

/**
 * Toggleable ground-plane grid.
 */
function SceneGrid({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <gridHelper args={[10, 10, "#444444", "#333333"]} position={[0, -1, 0]} />
  );
}


// ─── Public Interface ────────────────────────────────────────

export interface ThreeModelViewerProps {
  /** URL of the 3D model (blob URL, HTTP URL, or data URL) */
  modelUrl: string;
  /** Enable auto-rotation of the model */
  autoRotate?: boolean;
  /** Ref to expose the capture function for external use */
  captureRef?: React.MutableRefObject<(() => string | null) | null>;
  /** When provided, automatically captures the 3D viewport after the model loads */
  onAutoCapture?: (imageDataUrl: string) => void;
  /** Called when the model fails to load */
  onLoadError?: () => void;
  /** Additional CSS class name */
  className?: string;
  /** Whether the viewer is interactive (OrbitControls enabled) */
  interactive?: boolean;
  /** Sensor preset index (into SENSOR_PRESETS) */
  sensorIndex?: number;
  /** Lens focal length index (into LENS_FOCAL_LENGTHS) */
  lensIndex?: number;
  /** Aspect ratio preset index (into ASPECT_RATIO_PRESETS) */
  aspectIndex?: number;
  /** Whether to show a ground-plane grid */
  showGrid?: boolean;
  /** Background image URL to display behind the 3D model */
  backgroundImage?: string | null;
}

/**
 * Reusable Three.js model viewer component.
 *
 * Usage:
 * - Inline node viewer: `<ThreeModelViewer modelUrl={url} captureRef={ref} />`
 * - Overlay viewer: `<ThreeModelViewer modelUrl={url} autoRotate interactive captureRef={ref} />`
 * - Auto-thumbnail: `<ThreeModelViewer modelUrl={url} onAutoCapture={handleCapture} />`
 */
export function ThreeModelViewer({
  modelUrl,
  autoRotate = false,
  captureRef: externalCaptureRef,
  onAutoCapture,
  onLoadError,
  className = "",
  interactive = true,
  sensorIndex,
  lensIndex,
  aspectIndex,
  showGrid = false,
  backgroundImage,
}: ThreeModelViewerProps) {
  const internalCaptureRef = useRef<(() => string | null) | null>(null);
  const captureRef = externalCaptureRef || internalCaptureRef;
  const envGroupRef = useRef<THREE.Group>(null);
  const modelLoadedRef = useRef(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  // Cinema camera FOV calculation
  const hasCinemaSettings = sensorIndex != null || lensIndex != null || aspectIndex != null;
  const sIdx = sensorIndex ?? DEFAULT_SENSOR_INDEX;
  const lIdx = lensIndex ?? DEFAULT_LENS_INDEX;
  const aIdx = aspectIndex ?? DEFAULT_3D_ASPECT_INDEX;
  const selectedAspect = ASPECT_RATIO_PRESETS[aIdx];
  const vFov = hasCinemaSettings
    ? calculateCameraFOV(SENSOR_PRESETS[sIdx].widthMm, LENS_FOCAL_LENGTHS[lIdx], selectedAspect.ratio)
    : 45;

  // Track container size for letterboxing
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !hasCinemaSettings) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(el);
    // Set initial size
    setContainerSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, [hasCinemaSettings]);

  // Compute letterbox/pillarbox bar dimensions
  const letterbox = useMemo(() => {
    if (!hasCinemaSettings || containerSize.width === 0 || containerSize.height === 0) return null;
    const containerAspect = containerSize.width / containerSize.height;
    const targetAspect = selectedAspect.ratio;

    if (Math.abs(containerAspect - targetAspect) < 0.01) return null;

    if (targetAspect > containerAspect) {
      // Letterbox: bars on top and bottom
      const visibleHeight = containerSize.width / targetAspect;
      const barHeight = (containerSize.height - visibleHeight) / 2;
      return { type: "letterbox" as const, barSize: Math.max(0, barHeight) };
    } else {
      // Pillarbox: bars on left and right
      const visibleWidth = containerSize.height * targetAspect;
      const barWidth = (containerSize.width - visibleWidth) / 2;
      return { type: "pillarbox" as const, barSize: Math.max(0, barWidth) };
    }
  }, [hasCinemaSettings, containerSize, selectedAspect]);

  /**
   * Continuous rendering is the exception, not the default.
   *
   * react-three-fiber's default `frameloop="always"` drives a 60fps rAF render
   * on every mounted Canvas for as long as it lives — burning GPU on a model
   * that is sitting perfectly still, once per viewer. On demand, frames are
   * drawn only when something asks for one (`invalidate()`), which the model
   * loader, the resize observer and OrbitControls all do.
   *
   * Three cases still need every frame: auto-rotation (the camera moves each
   * tick), auto-capture (it counts frames before grabbing), and an in-progress
   * user drag (OrbitControls damping settles over several frames).
   */
  const needsContinuousFrames =
    (autoRotate && !isInteracting) || !!onAutoCapture || isInteracting;

  // Stable onCreated handler — only set clear color when no background image
  const handleCreated = useCallback(({ gl }: { gl: THREE.WebGLRenderer }) => {
    if (!backgroundImage) {
      gl.setClearColor(new THREE.Color("#1a1a1a"));
    }
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.2;
  }, [backgroundImage]);

  // CSS background style for background image (contain mode — no stretching)
  const containerStyle = useMemo(() => {
    if (!backgroundImage) return undefined;
    return {
      backgroundImage: `url(${backgroundImage})`,
      backgroundSize: "contain",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      backgroundColor: "#1a1a1a",
    } as React.CSSProperties;
  }, [backgroundImage]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full ${className}`}
      onPointerDown={() => setIsInteracting(true)}
      style={containerStyle}
    >
      <Canvas
        resize={{ offsetSize: true }}
        frameloop={needsContinuousFrames ? "always" : "demand"}
        gl={{ preserveDrawingBuffer: true, antialias: true, alpha: !!backgroundImage }}
        camera={{ position: [3.5, 2.1, 3.5], fov: vFov, near: 0.01, far: 100 }}
        onCreated={handleCreated}
      >
        {/* Camera FOV updater — only when cinema settings provided */}
        {hasCinemaSettings && <CameraFOVUpdater fov={vFov} />}

        {/* Lighting */}
        <ambientLight intensity={0.5} />
        <directionalLight position={[5, 8, 5]} intensity={1} castShadow />
        <directionalLight position={[-3, 2, -2]} intensity={0.3} />
        <hemisphereLight args={["#b1e1ff", "#444444", 0.4]} />

        {/* Environment (hidden during capture) */}
        <SceneEnvironment groupRef={envGroupRef} />

        {/* Grid */}
        <SceneGrid visible={showGrid} />

        {/* Model */}
        <Suspense fallback={<LoadingIndicator />}>
          <Model url={modelUrl} onError={onLoadError} modelLoadedRef={modelLoadedRef} />
        </Suspense>

        {/* Controls */}
        {interactive && (
          <OrbitControls
            makeDefault
            enableDamping
            dampingFactor={0.1}
            enablePan
            enableZoom
            target={[0, 0, 0]}
          />
        )}
        <AutoRotate enabled={autoRotate && !isInteracting} />
        <CaptureHelper captureRef={captureRef} envGroupRef={envGroupRef} backgroundImageUrl={backgroundImage} targetAspectRatio={hasCinemaSettings ? selectedAspect.ratio : undefined} />

        {/* Auto-capture after model loads */}
        {onAutoCapture && (
          <AutoCaptureHelper captureRef={captureRef} onAutoCapture={onAutoCapture} modelLoadedRef={modelLoadedRef} />
        )}
      </Canvas>

      {/* Letterbox / Pillarbox aspect ratio framing overlay */}
      {letterbox && (
        <>
          {letterbox.type === "letterbox" ? (
            <>
              <div
                className="absolute left-0 right-0 top-0 pointer-events-none"
                style={{ height: letterbox.barSize, backgroundColor: "rgba(0,0,0,0.7)" }}
              >
                <div className="absolute bottom-0 left-0 right-0 h-px bg-white/20" />
              </div>
              <div
                className="absolute left-0 right-0 bottom-0 pointer-events-none"
                style={{ height: letterbox.barSize, backgroundColor: "rgba(0,0,0,0.7)" }}
              >
                <div className="absolute top-0 left-0 right-0 h-px bg-white/20" />
              </div>
            </>
          ) : (
            <>
              <div
                className="absolute top-0 bottom-0 left-0 pointer-events-none"
                style={{ width: letterbox.barSize, backgroundColor: "rgba(0,0,0,0.7)" }}
              >
                <div className="absolute right-0 top-0 bottom-0 w-px bg-white/20" />
              </div>
              <div
                className="absolute top-0 bottom-0 right-0 pointer-events-none"
                style={{ width: letterbox.barSize, backgroundColor: "rgba(0,0,0,0.7)" }}
              >
                <div className="absolute left-0 top-0 bottom-0 w-px bg-white/20" />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
