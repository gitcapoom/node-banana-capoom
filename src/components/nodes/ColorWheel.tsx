"use client";

import { useCallback, useEffect, useRef } from "react";
import type { WheelPoint } from "@/utils/gradeWheel";

interface ColorWheelProps {
  /** Handle position on the unit disk (x,y in [-1,1], y up). */
  point: WheelPoint;
  /** Fired continuously while dragging with the new clamped point. */
  onChange: (pt: WheelPoint) => void;
  /** Double-click / center reset. */
  onReset?: () => void;
  size?: number;
}

/**
 * Interactive grading color wheel: an HSV disk (hue = angle, saturation
 * = radius) with a draggable handle. Emits a unit-disk point that the
 * caller maps to channel balance. The colourful disk is rendered once
 * to a canvas; the handle + center cross are DOM overlays so they stay
 * crisp and easy to hit.
 */
export function ColorWheel({ point, onChange, onReset, size = 130 }: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // Render the HSV disk once per size.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const c = size / 2;
    const R = c - 1;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const dx = px - c;
        const dy = py - c;
        const rr = Math.hypot(dx, dy);
        const idx = (py * size + px) * 4;
        if (rr > R) {
          data[idx + 3] = 0; // transparent outside the disk
          continue;
        }
        // angle: up (−dy) = top = red.
        const ang = Math.atan2(-dy, dx); // [-π, π], 0 = right, +π/2 = up
        let hueDeg = ((ang * 180) / Math.PI - 90 + 360) % 360; // up → 0 (red)
        const sat = Math.min(1, rr / R);
        const [r, g, b] = hsvToRgb(hueDeg / 360, sat, 1);
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        // soft anti-aliased rim
        data[idx + 3] = rr > R - 1 ? Math.round(255 * (R - rr + 1)) : 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [size]);

  const pointFromEvent = useCallback(
    (clientX: number, clientY: number): WheelPoint => {
      const wrap = wrapRef.current;
      if (!wrap) return { x: 0, y: 0 };
      const rect = wrap.getBoundingClientRect();
      const c = size / 2;
      let x = (clientX - rect.left - c) / (c - 1);
      let y = -(clientY - rect.top - c) / (c - 1); // flip to y-up
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      return { x, y };
    },
    [size],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      draggingRef.current = true;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      onChange(pointFromEvent(e.clientX, e.clientY));
    },
    [onChange, pointFromEvent],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      e.stopPropagation();
      onChange(pointFromEvent(e.clientX, e.clientY));
    },
    [onChange, pointFromEvent],
  );
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  // Handle position in CSS px (y-down).
  const c = size / 2;
  const handleLeft = c + point.x * (c - 1);
  const handleTop = c - point.y * (c - 1);

  return (
    <div
      ref={wrapRef}
      className="relative nodrag nopan touch-none cursor-crosshair"
      style={{ width: size, height: size }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => { e.stopPropagation(); onReset?.(); }}
      title="Drag to set colour balance · double-click to center"
    >
      <canvas ref={canvasRef} className="absolute inset-0 rounded-full" />
      {/* center cross */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full border border-white/50 pointer-events-none" />
      {/* handle */}
      <div
        className="absolute w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow pointer-events-none"
        style={{ left: handleLeft, top: handleTop, backgroundColor: "rgba(0,0,0,0.25)" }}
      />
    </div>
  );
}

/** HSV → RGB (0-255). h,s,v in [0,1]. */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
