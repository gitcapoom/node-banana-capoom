"use client";

import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { ThreeModelViewer } from "@/components/ThreeModelViewer";
import { ZoomPanView } from "@/components/ZoomPanView";
import {
  SENSOR_PRESETS,
  LENS_FOCAL_LENGTHS,
  ASPECT_RATIO_PRESETS,
  getCameraSummary,
} from "@/utils/cinemaCameraPresets";

export type MediaType = "image" | "video" | "audio" | "3d";

export interface CameraSettings {
  sensorIndex: number;
  lensIndex: number;
  aspectIndex: number;
  showGrid: boolean;
}

interface MediaOverlayProps {
  /** Current media content (base64 data URL or blob URL) */
  content: string | null;
  /** Media type */
  mediaType: MediaType;
  /** Current index in history (0-based) */
  currentIndex: number;
  /** Total number of items in history */
  totalCount: number;
  /** Whether content is currently loading */
  isLoading?: boolean;
  /** Navigate to previous item */
  onPrevious: () => void;
  /** Navigate to next item */
  onNext: () => void;
  /** Close the overlay */
  onClose: () => void;
  /** Optional callback for frame grab — receives the captured frame as base64 PNG */
  onFrameGrab?: (frameDataUrl: string) => void;
  /** Camera settings for 3D viewer */
  cameraSettings?: CameraSettings;
  /** Callback when camera settings change */
  onCameraSettingsChange?: (settings: CameraSettings) => void;
  /** Background image for 3D viewer */
  backgroundImage?: string | null;
  /** When true, aspect ratio is locked (overridden by background image) */
  aspectLocked?: boolean;
  /** Override aspect index when locked by background image */
  lockedAspectIndex?: number;
}

export function MediaOverlay({
  content,
  mediaType,
  currentIndex,
  totalCount,
  isLoading = false,
  onPrevious,
  onNext,
  onClose,
  onFrameGrab,
  cameraSettings,
  onCameraSettingsChange,
  backgroundImage,
  aspectLocked = false,
  lockedAspectIndex,
}: MediaOverlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const threeCaptureRef = useRef<(() => string | null) | null>(null);
  const [videoBlobUrl, setVideoBlobUrl] = useState<string | null>(null);

  // Convert video data URL to blob URL for better performance
  useEffect(() => {
    if (mediaType !== "video" || !content) {
      setVideoBlobUrl(null);
      return;
    }

    // If already a blob URL or HTTP URL, use directly
    if (content.startsWith("blob:") || content.startsWith("http")) {
      setVideoBlobUrl(content);
      return;
    }

    // Convert data URL to blob
    try {
      const match = content.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        const mimeType = match[1];
        const base64 = match[2];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: mimeType });
        const url = URL.createObjectURL(blob);
        setVideoBlobUrl(url);
        return () => URL.revokeObjectURL(url);
      }
    } catch {
      // Fallback to direct URL
      setVideoBlobUrl(content);
    }
  }, [content, mediaType]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onPrevious();
      else if (e.key === "ArrowRight") onNext();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onPrevious, onNext]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  // Frame grab: capture current video frame or 3D viewport as PNG
  const handleFrameGrab = useCallback(() => {
    if (!onFrameGrab) return;

    if (mediaType === "video") {
      const video = videoRef.current;
      if (!video) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0);
          const dataUrl = canvas.toDataURL("image/png");
          onFrameGrab(dataUrl);
        }
      } catch (err) {
        console.warn("Video frame grab failed:", err);
      }
    } else if (mediaType === "3d") {
      // Capture from Three.js viewport
      if (threeCaptureRef.current) {
        const dataUrl = threeCaptureRef.current();
        if (dataUrl) {
          onFrameGrab(dataUrl);
        }
      }
    }
  }, [onFrameGrab, mediaType]);

  // Effective aspect index (locked by bg image or from settings)
  const effectiveAspectIndex = aspectLocked && lockedAspectIndex != null
    ? lockedAspectIndex
    : (cameraSettings?.aspectIndex ?? 2);

  // Camera summary text
  const cameraSummary = useMemo(() => {
    if (!cameraSettings) return null;
    const sensor = SENSOR_PRESETS[cameraSettings.sensorIndex];
    const focalLength = LENS_FOCAL_LENGTHS[cameraSettings.lensIndex];
    const aspect = ASPECT_RATIO_PRESETS[effectiveAspectIndex];
    return getCameraSummary(sensor, focalLength, aspect);
  }, [cameraSettings, effectiveAspectIndex]);

  const hasPrevNext = totalCount > 1;
  const showFrameGrab = (mediaType === "video" || mediaType === "3d") && onFrameGrab;
  const show3dControls = mediaType === "3d" && cameraSettings && onCameraSettingsChange;

  const overlay = (
    <div
      className="fixed inset-0 bg-black/85 z-[200] flex items-center justify-center"
      onClick={handleBackdropClick}
    >
      {/* Top-right controls */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
        {/* Frame grab button (video and 3D) */}
        {showFrameGrab && (
          <button
            onClick={handleFrameGrab}
            tabIndex={-1}
            onKeyDown={(e) => e.preventDefault()}
            className="w-10 h-10 rounded-full bg-red-600/80 hover:bg-red-500 flex items-center justify-center text-white transition-colors"
            title="Grab frame"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="4" fill="currentColor" />
            </svg>
          </button>
        )}
        {/* Close button */}
        <button
          onClick={onClose}
          className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Previous button */}
      {hasPrevNext && (
        <button
          onClick={(e) => { e.stopPropagation(); onPrevious(); }}
          disabled={isLoading}
          className="absolute left-4 top-1/2 -translate-y-1/2 z-10 w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30 flex items-center justify-center text-white transition-colors"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}

      {/* Content area */}
      <div className="max-w-[90vw] max-h-[85vh] flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {isLoading ? (
          <div className="flex items-center justify-center w-64 h-64">
            <svg className="w-10 h-10 animate-spin text-white/60" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
        ) : content ? (
          <>
            {mediaType === "image" && (
              <ZoomPanView
                className="w-[90vw] h-[80vh] rounded-lg"
                panMode="free"
              >
                <div className="w-full h-full flex items-center justify-center">
                  <img
                    src={content}
                    alt="Full view"
                    className="max-w-full max-h-full object-contain"
                    draggable={false}
                  />
                </div>
              </ZoomPanView>
            )}
            {mediaType === "video" && videoBlobUrl && (
              <ZoomPanView
                className="w-[90vw] h-[80vh] rounded-lg"
                panMode="alt-modifier"
              >
                <div className="w-full h-full flex items-center justify-center">
                  <video
                    ref={videoRef}
                    src={videoBlobUrl}
                    controls
                    autoPlay
                    className="max-w-full max-h-full"
                  />
                </div>
              </ZoomPanView>
            )}
            {mediaType === "audio" && (
              <div className="bg-neutral-800 rounded-lg p-8 min-w-[400px]">
                <audio src={content} controls autoPlay className="w-full" />
              </div>
            )}
            {mediaType === "3d" && (
              <div className="w-[80vw] h-[70vh] rounded-lg overflow-hidden">
                <ThreeModelViewer
                  modelUrl={content}
                  autoRotate
                  captureRef={threeCaptureRef}
                  interactive
                  className="w-full h-full"
                  sensorIndex={cameraSettings?.sensorIndex}
                  lensIndex={cameraSettings?.lensIndex}
                  aspectIndex={effectiveAspectIndex}
                  showGrid={cameraSettings?.showGrid}
                  backgroundImage={backgroundImage}
                />
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center w-64 h-64 text-white/40">
            Content not available
          </div>
        )}

        {/* Counter */}
        {hasPrevNext && (
          <span className="text-sm text-white/60">
            {currentIndex + 1} / {totalCount}
          </span>
        )}
      </div>

      {/* Next button */}
      {hasPrevNext && (
        <button
          onClick={(e) => { e.stopPropagation(); onNext(); }}
          disabled={isLoading}
          className="absolute right-4 top-1/2 -translate-y-1/2 z-10 w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30 flex items-center justify-center text-white transition-colors"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}

      {/* 3D Camera Controls Panel — bottom-left */}
      {show3dControls && (
        <div
          className="absolute bottom-4 left-4 z-10 bg-black/70 backdrop-blur-md rounded-lg p-3 text-white min-w-[280px]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Camera summary */}
          {cameraSummary && (
            <div className="text-[11px] text-white/60 mb-2 truncate">{cameraSummary}</div>
          )}

          {/* Controls grid */}
          <div className="grid grid-cols-3 gap-2">
            {/* Sensor */}
            <div>
              <label className="text-[10px] text-white/40 block mb-0.5">Sensor</label>
              <select
                value={cameraSettings!.sensorIndex}
                onChange={(e) => onCameraSettingsChange!({ ...cameraSettings!, sensorIndex: Number(e.target.value) })}
                className="w-full text-[11px] bg-white/10 border border-white/10 rounded px-1 py-1 text-white appearance-none cursor-pointer hover:bg-white/15 transition-colors"
              >
                {SENSOR_PRESETS.map((s, i) => (
                  <option key={s.name} value={i} className="bg-neutral-800">{s.name}</option>
                ))}
              </select>
            </div>

            {/* Lens */}
            <div>
              <label className="text-[10px] text-white/40 block mb-0.5">Lens</label>
              <select
                value={cameraSettings!.lensIndex}
                onChange={(e) => onCameraSettingsChange!({ ...cameraSettings!, lensIndex: Number(e.target.value) })}
                className="w-full text-[11px] bg-white/10 border border-white/10 rounded px-1 py-1 text-white appearance-none cursor-pointer hover:bg-white/15 transition-colors"
              >
                {LENS_FOCAL_LENGTHS.map((fl, i) => (
                  <option key={fl} value={i} className="bg-neutral-800">{fl}mm</option>
                ))}
              </select>
            </div>

            {/* Aspect Ratio */}
            <div>
              <label className="text-[10px] text-white/40 block mb-0.5">
                Aspect{aspectLocked && <span className="text-white/30 ml-1">(BG)</span>}
              </label>
              <select
                value={effectiveAspectIndex}
                onChange={(e) => onCameraSettingsChange!({ ...cameraSettings!, aspectIndex: Number(e.target.value) })}
                disabled={aspectLocked}
                className={`w-full text-[11px] bg-white/10 border border-white/10 rounded px-1 py-1 text-white appearance-none transition-colors ${
                  aspectLocked ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-white/15"
                }`}
                title={aspectLocked ? "Aspect ratio set by background image" : undefined}
              >
                {ASPECT_RATIO_PRESETS.map((ar, i) => (
                  <option key={ar.name} value={i} className="bg-neutral-800">{ar.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Grid toggle */}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => onCameraSettingsChange!({ ...cameraSettings!, showGrid: !cameraSettings!.showGrid })}
              className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                cameraSettings!.showGrid
                  ? "bg-white/20 border-white/30 text-white"
                  : "bg-transparent border-white/10 text-white/50 hover:text-white/70 hover:border-white/20"
              }`}
            >
              {/* Grid icon */}
              <span className="flex items-center gap-1">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18" />
                </svg>
                Grid
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(overlay, document.body);
}
