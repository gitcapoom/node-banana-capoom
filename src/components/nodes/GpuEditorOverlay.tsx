"use client";

import { useEffect, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ZoomPanView } from "@/components/ZoomPanView";

/**
 * Shared full-screen viewer for the GPU-native image-processing nodes
 * (Color Grade / HSV Correct / Contrast Adjust). The processed image
 * fills the viewport via a <canvas> the host draws into with the live
 * GPU preview (no data-URL round-trip), and the node's slider controls
 * float on top in a translucent panel.
 *
 * The host node owns `canvasRef` and runs `useGpuLivePreview` against it
 * while the overlay is open, so dragging sliders updates this big canvas
 * at 60 fps. Escape / backdrop click / × closes.
 *
 * Portaled to document.body so it isn't bounded by React Flow's pan/zoom.
 */

interface GpuEditorOverlayProps {
  /** Header / accessible title (e.g. "Color Grade"). */
  title: string;
  /** Canvas the host draws the live GPU preview into. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Callback to close — wired to Escape, backdrop click, and the × button. */
  onClose: () => void;
  /** Slider controls (and anything else) the host node wants to render. */
  children: ReactNode;
}

export function GpuEditorOverlay({ title, canvasRef, onClose, children }: GpuEditorOverlayProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const overlay = (
    <div
      className="fixed inset-0 bg-black/90 z-[200] flex items-center justify-center select-none"
      onClick={onClose}
    >
      {/* Live GPU preview (full-res canvas) — wheel to zoom, drag to pan, 0 to
          reset. Zooming reveals full resolution. */}
      <div className="w-[96vw] h-[94vh]" onClick={(e) => e.stopPropagation()}>
        <ZoomPanView className="w-full h-full" panMode="free" hint="Scroll to zoom · drag to pan · 0 to reset">
          <div className="w-full h-full flex items-center justify-center">
            <canvas
              ref={canvasRef}
              className="max-w-full max-h-full object-contain shadow-2xl"
              style={{ imageRendering: "auto" }}
              draggable={false}
            />
          </div>
        </ZoomPanView>
      </div>

      {/* Header bar */}
      <div className="absolute top-4 left-4 right-4 flex items-center justify-between text-white pointer-events-none">
        <span className="text-sm font-medium tracking-wide bg-black/40 px-3 py-1 rounded backdrop-blur-sm">
          {title}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="pointer-events-auto w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
          title="Close (Esc)"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Floating controls panel — bottom-right. */}
      <div
        className="absolute bottom-6 right-6 w-[340px] max-w-[40vw] bg-neutral-900/80 backdrop-blur-md rounded-lg shadow-2xl p-4 border border-neutral-700/60"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
