"use client";

import { useState, useCallback } from "react";
import type { CameraPath } from "./cameraAnimation";

// ─── Types ──────────────────────────────────────────────────────

export type ExportMode = "rgb" | "depth" | "both";

export interface ExportSettings {
  mode: ExportMode;
  resolution: { width: number; height: number };
  fps: number;
  durationFrames: number;
  includeColmap: boolean;
}

export interface ExportDialogProps {
  path: CameraPath;
  sensorWidthMm: number;
  focalLengthMm: number;
  onExport: (settings: ExportSettings) => void;
  onClose: () => void;
  isExporting: boolean;
  exportProgress: { frame: number; total: number } | null;
}

// ─── Resolution presets ─────────────────────────────────────────

const RESOLUTION_PRESETS = [
  { label: "1280x720 (HD)", width: 1280, height: 720 },
  { label: "1920x1080 (Full HD)", width: 1920, height: 1080 },
  { label: "3840x2160 (4K)", width: 3840, height: 2160 },
];

const FPS_OPTIONS = [12, 24, 30, 60];

// ─── Component ──────────────────────────────────────────────────

export default function ExportDialog({
  path,
  onExport,
  onClose,
  isExporting,
  exportProgress,
}: ExportDialogProps) {
  const [mode, setMode] = useState<ExportMode>("rgb");
  const [resIndex, setResIndex] = useState(1); // default Full HD
  const [fps, setFps] = useState(path.fps);
  const [durationFrames, setDurationFrames] = useState(path.durationFrames);
  const [includeColmap, setIncludeColmap] = useState(true);

  const resolution = RESOLUTION_PRESETS[resIndex];
  const durationSec = fps > 0 ? (durationFrames / fps).toFixed(1) : "0";

  const handleExport = useCallback(() => {
    onExport({
      mode,
      resolution: { width: resolution.width, height: resolution.height },
      fps,
      durationFrames,
      includeColmap,
    });
  }, [mode, resolution, fps, durationFrames, includeColmap, onExport]);

  const progressPct =
    exportProgress && exportProgress.total > 0
      ? Math.round((exportProgress.frame / exportProgress.total) * 100)
      : 0;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl w-full max-w-sm p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white text-sm font-medium">Export Video</h2>
          <button
            onClick={onClose}
            disabled={isExporting}
            className="text-neutral-500 hover:text-white transition-colors disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Keyframe warning */}
        {path.keyframes.length < 2 && (
          <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-lg px-3 py-2 mb-4">
            <p className="text-yellow-400 text-[11px]">
              Add at least 2 keyframes before exporting.
            </p>
          </div>
        )}

        {/* Output mode */}
        <div className="mb-3">
          <label className="text-[10px] text-neutral-500 block mb-1.5">Output</label>
          <div className="flex gap-1.5">
            {(["rgb", "depth", "both"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                disabled={isExporting}
                className={`flex-1 text-[11px] py-1.5 rounded transition-colors ${
                  mode === m
                    ? "bg-indigo-600 text-white"
                    : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                } disabled:opacity-50`}
              >
                {m === "rgb" ? "RGB" : m === "depth" ? "Depth" : "Both"}
              </button>
            ))}
          </div>
        </div>

        {/* Resolution */}
        <div className="mb-3">
          <label className="text-[10px] text-neutral-500 block mb-1.5">Resolution</label>
          <select
            value={resIndex}
            onChange={(e) => setResIndex(Number(e.target.value))}
            disabled={isExporting}
            className="w-full bg-neutral-800 text-neutral-200 text-[11px] rounded px-2 py-1.5 border border-neutral-700 focus:border-indigo-500 focus:outline-none appearance-none disabled:opacity-50"
          >
            {RESOLUTION_PRESETS.map((r, i) => (
              <option key={r.label} value={i}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {/* FPS */}
        <div className="mb-3">
          <label className="text-[10px] text-neutral-500 block mb-1.5">FPS</label>
          <div className="flex gap-1.5">
            {FPS_OPTIONS.map((f) => (
              <button
                key={f}
                onClick={() => setFps(f)}
                disabled={isExporting}
                className={`flex-1 text-[11px] py-1.5 rounded transition-colors ${
                  fps === f
                    ? "bg-indigo-600 text-white"
                    : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                } disabled:opacity-50`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* Duration */}
        <div className="mb-3">
          <label className="text-[10px] text-neutral-500 block mb-1.5">
            Total Frames ({durationSec}s)
          </label>
          <input
            type="number"
            min={2}
            max={9999}
            value={durationFrames}
            onChange={(e) => setDurationFrames(Math.max(2, parseInt(e.target.value) || 2))}
            disabled={isExporting}
            className="w-full bg-neutral-800 text-neutral-200 text-[11px] rounded px-2 py-1.5 border border-neutral-700 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        {/* COLMAP checkbox */}
        <label className="flex items-center gap-2 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={includeColmap}
            onChange={(e) => setIncludeColmap(e.target.checked)}
            disabled={isExporting}
            className="rounded border-neutral-600 bg-neutral-800 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50"
          />
          <span className="text-neutral-300 text-[11px]">
            Include COLMAP camera data (cameras.txt + images.txt)
          </span>
        </label>

        {/* Progress bar */}
        {isExporting && exportProgress && (
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-neutral-400 text-[10px]">
                Rendering frame {exportProgress.frame}/{exportProgress.total}
              </span>
              <span className="text-indigo-400 text-[10px] font-mono">{progressPct}%</span>
            </div>
            <div className="h-1.5 bg-neutral-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}

        {/* Export button */}
        <button
          onClick={handleExport}
          disabled={isExporting || path.keyframes.length < 2}
          className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-sm font-medium py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          {isExporting ? (
            <>
              <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Exporting...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export
            </>
          )}
        </button>
      </div>
    </div>
  );
}
