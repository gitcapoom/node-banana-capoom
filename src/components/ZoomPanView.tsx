"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";

const MIN_SCALE = 0.1;
const MAX_SCALE = 50;

/**
 * How panning interacts with the child content.
 *   - "free":       left-drag anywhere pans. Use when the content has no
 *                   draggable elements of its own (single image / video).
 *   - "alt-modifier": left-drag pans only when Alt (or Space) is held down.
 *                   Use when the content has its own drag interactions (e.g.
 *                   react-compare-slider's divider).
 */
export type ZoomPanMode = "free" | "alt-modifier";

interface ZoomPanViewProps {
  children: ReactNode;
  panMode?: ZoomPanMode;
  className?: string;
  /** Shown once, fades out. Default reflects panMode. */
  hint?: string;
}

/**
 * Generic wheel-zoom / drag-pan wrapper. Zoom is cursor-centered and
 * unconstrained (up to 50×, down to 0.1×). Press "0" to reset.
 */
export function ZoomPanView({ children, panMode = "free", className, hint }: ZoomPanViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [altHeld, setAltHeld] = useState(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });

  // Track alt/space key for alt-modifier pan mode.
  useEffect(() => {
    if (panMode !== "alt-modifier") return;
    const down = (e: KeyboardEvent) => {
      if (e.key === "Alt" || e.key === " ") setAltHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt" || e.key === " ") setAltHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [panMode]);

  // Reset on "0" key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "0" && !e.ctrlKey && !e.metaKey) {
        setScale(1);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      // Cursor position relative to container center
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;

      const zoomFactor = Math.exp(-e.deltaY * 0.0015);
      setScale((prevScale) => {
        const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prevScale * zoomFactor));
        // Adjust pan so the point under the cursor stays fixed.
        const ratio = nextScale / prevScale;
        setPan((prevPan) => ({
          x: cx - (cx - prevPan.x) * ratio,
          y: cy - (cy - prevPan.y) * ratio,
        }));
        return nextScale;
      });
    },
    []
  );

  const canStartPan = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): boolean => {
      if (e.button !== 0 && e.button !== 1) return false; // left or middle
      if (panMode === "alt-modifier") {
        if (e.button === 1) return true;
        return e.altKey || altHeld;
      }
      return true;
    },
    [panMode, altHeld]
  );

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!canStartPan(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    },
    [canStartPan]
  );

  const handleMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      const dx = e.clientX - lastMouseRef.current.x;
      const dy = e.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    },
    [isDragging]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const reset = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const effectiveHint =
    hint ??
    (panMode === "alt-modifier"
      ? "wheel = zoom • alt/space + drag = pan • 0 = reset"
      : "wheel = zoom • drag = pan • 0 = reset");

  const cursor = isDragging
    ? "grabbing"
    : panMode === "alt-modifier"
    ? (altHeld ? "grab" : "default")
    : "grab";

  return (
    <div
      ref={containerRef}
      className={className}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor, overflow: "hidden", position: "relative", userSelect: "none" }}
    >
      <div
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transformOrigin: "center center",
          willChange: "transform",
          width: "100%",
          height: "100%",
        }}
      >
        {children}
      </div>

      {/* Reset + zoom level badge */}
      <div
        className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 backdrop-blur rounded-full px-3 py-1 text-[11px] text-white/80 pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="tabular-nums">{Math.round(scale * 100)}%</span>
        <span className="text-white/30">|</span>
        <button
          onClick={reset}
          className="hover:text-white transition-colors"
          title="Reset (0)"
        >
          Reset
        </button>
        <span className="text-white/30">|</span>
        <span className="text-white/40 text-[10px]">{effectiveHint}</span>
      </div>
    </div>
  );
}
