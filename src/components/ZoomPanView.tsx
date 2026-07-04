"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";

const MIN_SCALE = 0.1;
const MAX_SCALE = 50;

/**
 * How panning interacts with the child content.
 *   - "free":         pointerdown-drag anywhere pans. Use when the content
 *                     has no drag interactions of its own.
 *   - "alt-modifier": pan only when Alt (or Space) is held down, or when
 *                     using middle-mouse button. Use when the content has
 *                     its own drag (e.g. react-compare-slider's divider).
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
 *
 * Uses native pointerdown listeners in capture phase so pan intercepts
 * happen BEFORE descendants receive the event — necessary when children
 * (like react-compare-slider) attach their own pointerdown handlers.
 */
export function ZoomPanView({ children, panMode = "free", className, hint }: ZoomPanViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [altHeld, setAltHeld] = useState(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });

  // --- Keyboard state (Alt/Space + "0" reset) ---
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (panMode === "alt-modifier" && (e.key === "Alt" || e.key === " ")) {
        setAltHeld(true);
        if (e.key === " ") e.preventDefault(); // avoid page scroll
      }
      if (e.key === "0" && !e.ctrlKey && !e.metaKey) {
        setScale(1);
        setPan({ x: 0, y: 0 });
      }
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

  // --- Wheel zoom (cursor-centered) ---
  const handleWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;

      const zoomFactor = Math.exp(-e.deltaY * 0.0015);
      setScale((prevScale) => {
        const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prevScale * zoomFactor));
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

  // --- Pan: capture-phase pointerdown so we beat descendants ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Use refs to read latest mode/altHeld without re-binding the listener.
    const panModeRef = panMode;
    const altHeldRefValue = altHeld;

    const canStartPan = (e: PointerEvent): boolean => {
      // Only primary or middle mouse button.
      if (e.button !== 0 && e.button !== 1) return false;
      if (panModeRef === "alt-modifier") {
        if (e.button === 1) return true;
        return e.altKey || altHeldRefValue;
      }
      return true;
    };

    const onDown = (e: PointerEvent) => {
      if (!canStartPan(e)) return;
      // Stop the slider / any descendant from seeing this event.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      setIsDragging(true);
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    };

    // Capture phase fires BEFORE any descendant's bubble-phase listener.
    el.addEventListener("pointerdown", onDown, { capture: true });
    return () => el.removeEventListener("pointerdown", onDown, { capture: true });
  }, [panMode, altHeld]);

  // --- Track drag globally so cursor leaving the container doesn't break drag ---
  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - lastMouseRef.current.x;
      const dy = e.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    };
    const onUp = () => setIsDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [isDragging]);

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
      style={{ cursor, overflow: "hidden", position: "relative", userSelect: "none", touchAction: "none" }}
    >
      <div
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transformOrigin: "center center",
          // NOTE: deliberately NOT `will-change: transform`. That pins the layer
          // to a texture rasterized once at the fit size, so zooming in just
          // GPU-upscales a blurry copy — the source's real pixels never appear.
          // Without it, the browser re-rasterizes from the full-res image at the
          // current zoom, so wheel-zoom reveals actual pixels. Pan is a pure
          // translate (no re-raster), so dragging stays smooth.
          width: "100%",
          height: "100%",
        }}
      >
        {children}
      </div>

      {/* Reset + zoom level badge */}
      <div
        className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 backdrop-blur rounded-full px-3 py-1 text-[11px] text-white/80"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
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
