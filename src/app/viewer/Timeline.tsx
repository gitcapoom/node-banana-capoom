"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import type { CameraPath } from "./cameraAnimation";
import { timeToFrame, frameToTime } from "./cameraAnimation";

// ─── Types ──────────────────────────────────────────────────────

export interface TimelineProps {
  path: CameraPath;
  currentFrame: number;
  isPlaying: boolean;
  onScrub: (frame: number) => void;
  onPlay: () => void;
  onStop: () => void;
  onAddKeyframe: () => void;
  onRemoveKeyframe: (index: number) => void;
  onMoveKeyframe: (index: number, newTime: number) => void;
  onSelectKeyframe: (index: number | null) => void;
  selectedKeyframe: number | null;
}

// ─── Constants ──────────────────────────────────────────────────

const TIMELINE_HEIGHT = 48;
const TRACK_Y = 16;
const TRACK_HEIGHT = 20;
const KEYFRAME_SIZE = 8;
const PLAYHEAD_WIDTH = 2;

// ─── Component ──────────────────────────────────────────────────

export default function Timeline({
  path,
  currentFrame,
  isPlaying,
  onScrub,
  onPlay,
  onStop,
  onAddKeyframe,
  onRemoveKeyframe,
  onMoveKeyframe,
  onSelectKeyframe,
  selectedKeyframe,
}: TimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragKeyframe, setDragKeyframe] = useState<number | null>(null);
  const widthRef = useRef(800);

  // ─── Coordinate helpers ─────────────────────────────────
  const frameToX = useCallback(
    (frame: number) => {
      const padding = 40;
      const trackWidth = widthRef.current - padding * 2;
      return (
        padding + (frame / Math.max(1, path.durationFrames - 1)) * trackWidth
      );
    },
    [path.durationFrames]
  );

  const xToFrame = useCallback(
    (x: number) => {
      const padding = 40;
      const trackWidth = widthRef.current - padding * 2;
      const t = Math.max(0, Math.min(1, (x - padding) / trackWidth));
      return Math.round(t * (path.durationFrames - 1));
    },
    [path.durationFrames]
  );

  // ─── Canvas drawing ─────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const dpr = window.devicePixelRatio || 1;

    ctx.clearRect(0, 0, w, h);

    // Scale for device pixel ratio
    ctx.save();
    ctx.scale(dpr, dpr);

    const logicalW = w / dpr;
    widthRef.current = logicalW;

    const padding = 40;
    const trackWidth = logicalW - padding * 2;

    // ─── Track background ─────────────────────────────
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(padding, TRACK_Y, trackWidth, TRACK_HEIGHT);

    // ─── Frame ticks ──────────────────────────────────
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.font = "9px monospace";
    ctx.textAlign = "center";

    const tickInterval = Math.max(
      1,
      Math.ceil(path.durationFrames / (logicalW / 50))
    );
    for (let f = 0; f <= path.durationFrames; f += tickInterval) {
      const x = padding + (f / Math.max(1, path.durationFrames - 1)) * trackWidth;
      ctx.fillRect(x, TRACK_Y, 1, TRACK_HEIGHT);

      // Label every other tick
      if (f % (tickInterval * 2) === 0 || f === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.fillText(String(f), x, TRACK_Y + TRACK_HEIGHT + 10);
        ctx.fillStyle = "rgba(255,255,255,0.2)";
      }
    }

    // ─── Keyframe diamonds ────────────────────────────
    path.keyframes.forEach((kf, i) => {
      const frame = timeToFrame(kf.time, path.durationFrames);
      const x = padding + (frame / Math.max(1, path.durationFrames - 1)) * trackWidth;
      const cy = TRACK_Y + TRACK_HEIGHT / 2;

      ctx.save();
      ctx.translate(x, cy);
      ctx.rotate(Math.PI / 4);

      const isSelected = selectedKeyframe === i;
      ctx.fillStyle = isSelected ? "#f59e0b" : "#eab308";
      ctx.strokeStyle = isSelected ? "#ffffff" : "rgba(255,255,255,0.3)";
      ctx.lineWidth = isSelected ? 1.5 : 0.5;

      ctx.fillRect(
        -KEYFRAME_SIZE / 2,
        -KEYFRAME_SIZE / 2,
        KEYFRAME_SIZE,
        KEYFRAME_SIZE
      );
      ctx.strokeRect(
        -KEYFRAME_SIZE / 2,
        -KEYFRAME_SIZE / 2,
        KEYFRAME_SIZE,
        KEYFRAME_SIZE
      );

      ctx.restore();
    });

    // ─── Playhead ─────────────────────────────────────
    const playheadX = padding + (currentFrame / Math.max(1, path.durationFrames - 1)) * trackWidth;

    ctx.fillStyle = "#ef4444";
    ctx.fillRect(
      playheadX - PLAYHEAD_WIDTH / 2,
      TRACK_Y - 4,
      PLAYHEAD_WIDTH,
      TRACK_HEIGHT + 8
    );

    // Playhead triangle
    ctx.beginPath();
    ctx.moveTo(playheadX - 5, TRACK_Y - 4);
    ctx.lineTo(playheadX + 5, TRACK_Y - 4);
    ctx.lineTo(playheadX, TRACK_Y + 2);
    ctx.closePath();
    ctx.fillStyle = "#ef4444";
    ctx.fill();

    ctx.restore();
  }, [path, currentFrame, selectedKeyframe]);

  // ─── Resize observer ────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = TIMELINE_HEIGHT * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${TIMELINE_HEIGHT}px`;
      widthRef.current = rect.width;
      draw();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    return () => observer.disconnect();
  }, [draw]);

  // Redraw on state changes
  useEffect(() => {
    draw();
  }, [draw]);

  // ─── Mouse interaction ──────────────────────────────────
  const getCanvasX = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return 0;
      const rect = canvas.getBoundingClientRect();
      return e.clientX - rect.left;
    },
    []
  );

  const findKeyframeAtX = useCallback(
    (x: number): number | null => {
      const hitRadius = 10;
      for (let i = path.keyframes.length - 1; i >= 0; i--) {
        const frame = timeToFrame(path.keyframes[i].time, path.durationFrames);
        const kfX = frameToX(frame);
        if (Math.abs(x - kfX) < hitRadius) return i;
      }
      return null;
    },
    [path.keyframes, path.durationFrames, frameToX]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const x = getCanvasX(e);

      // Check if clicking on a keyframe
      const hitKf = findKeyframeAtX(x);
      if (hitKf !== null) {
        onSelectKeyframe(hitKf);
        setDragKeyframe(hitKf);
        setIsDragging(true);
        return;
      }

      // Otherwise, scrub the playhead
      onSelectKeyframe(null);
      setIsDragging(true);
      setDragKeyframe(null);
      const frame = xToFrame(x);
      onScrub(frame);
    },
    [getCanvasX, findKeyframeAtX, onSelectKeyframe, xToFrame, onScrub]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const x = getCanvasX(e);
      if (dragKeyframe !== null) {
        // Drag keyframe to new time position
        const frame = xToFrame(x);
        const newTime = frameToTime(frame, path.durationFrames);
        onMoveKeyframe(dragKeyframe, newTime);
      } else {
        // Scrub playhead
        const frame = xToFrame(x);
        onScrub(frame);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setDragKeyframe(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, dragKeyframe, getCanvasX, xToFrame, onScrub, onMoveKeyframe, path.durationFrames]);

  // ─── Render ─────────────────────────────────────────────
  const durationSec = path.fps > 0 ? (path.durationFrames / path.fps).toFixed(1) : "0";

  return (
    <div className="bg-black/80 backdrop-blur-md border-t border-neutral-800 pointer-events-auto">
      {/* Controls row */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        {/* Play/Stop */}
        <button
          onClick={isPlaying ? onStop : onPlay}
          className="text-white hover:text-indigo-400 transition-colors"
          title={isPlaying ? "Stop" : "Play"}
        >
          {isPlaying ? (
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="2" width="4" height="12" rx="1" />
              <rect x="9" y="2" width="4" height="12" rx="1" />
            </svg>
          ) : (
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 2l10 6-10 6V2z" />
            </svg>
          )}
        </button>

        {/* Prev keyframe */}
        <button
          onClick={() => {
            for (let i = path.keyframes.length - 1; i >= 0; i--) {
              const f = timeToFrame(path.keyframes[i].time, path.durationFrames);
              if (f < currentFrame) {
                onScrub(f);
                onSelectKeyframe(i);
                return;
              }
            }
          }}
          className="text-neutral-400 hover:text-white transition-colors"
          title="Previous keyframe"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M12 2L5 8l7 6V2zM4 2h1v12H4V2z" />
          </svg>
        </button>

        {/* Next keyframe */}
        <button
          onClick={() => {
            for (let i = 0; i < path.keyframes.length; i++) {
              const f = timeToFrame(path.keyframes[i].time, path.durationFrames);
              if (f > currentFrame) {
                onScrub(f);
                onSelectKeyframe(i);
                return;
              }
            }
          }}
          className="text-neutral-400 hover:text-white transition-colors"
          title="Next keyframe"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 2l7 6-7 6V2zM11 2h1v12h-1V2z" />
          </svg>
        </button>

        {/* Add keyframe */}
        <button
          onClick={onAddKeyframe}
          className="text-yellow-500 hover:text-yellow-400 transition-colors ml-1"
          title="Add keyframe (K)"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1l3 5h-2v4h2l-3 5-3-5h2V6H5l3-5z" transform="rotate(45 8 8)" />
          </svg>
        </button>

        {/* Delete keyframe */}
        <button
          onClick={() => {
            if (selectedKeyframe !== null) {
              onRemoveKeyframe(selectedKeyframe);
              onSelectKeyframe(null);
            }
          }}
          disabled={selectedKeyframe === null}
          className="text-neutral-500 hover:text-red-400 disabled:text-neutral-700 disabled:cursor-not-allowed transition-colors"
          title="Delete selected keyframe (Del)"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z" />
            <path fillRule="evenodd" d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 01-1-1V2a1 1 0 011-1H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1v1zM4.118 4L4 4.059V13a1 1 0 001 1h6a1 1 0 001-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z" />
          </svg>
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Frame counter */}
        <span className="text-neutral-500 text-[10px] font-mono tabular-nums">
          {currentFrame} / {path.durationFrames - 1} · {durationSec}s · {path.fps}fps
        </span>

        {/* Keyframe count */}
        <span className="text-yellow-600 text-[10px]">
          {path.keyframes.length} keys
        </span>
      </div>

      {/* Canvas timeline track */}
      <div ref={containerRef} className="w-full cursor-pointer">
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          className="block w-full"
          style={{ height: TIMELINE_HEIGHT }}
        />
      </div>
    </div>
  );
}
