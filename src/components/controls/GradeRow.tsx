"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ColorWheel } from "@/components/nodes/ColorWheel";
import {
  channelToHex,
  hexToChannel,
  masterValue,
  type GradeChannelValue,
  type GradeParams,
} from "@/utils/colorGrade";
import {
  channelLevel,
  channelToWheel,
  wheelToChannel,
  type WheelPoint,
} from "@/utils/gradeWheel";

/**
 * The Grade parameter control, shared by every editor that offers a Nuke-style
 * Grade — the standalone Color Grade node and the Comp node's per-layer colour
 * block.
 *
 * It lives here rather than in ColorGradeNode because the ranges are not a
 * cosmetic choice: `strength` (the wheel's radius → channel mapping) is derived
 * from them, so a second hand-maintained copy of `min`/`max` is a second,
 * silently different colour wheel. One definition, one control, one behaviour
 * wherever a user meets a grade.
 */

export interface GradeSliderDef {
  key: keyof GradeParams;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

/**
 * The seven Grade parameters, their ranges and their identity values.
 *
 * `defaultValue` is the identity for that parameter and must stay equal to
 * `IDENTITY_GRADE` (and to `normalizeCompGrade(undefined)`, which is the same
 * identity expressed in the comp's data layer) — a "reset" that landed anywhere
 * else would leave a row reading as default while still grading. Guarded by a
 * test rather than derived, so the table stays readable.
 */
export const GRADE_SLIDERS: GradeSliderDef[] = [
  { key: "blackpoint", label: "Blackpoint", min: -0.5, max: 0.5, step: 0.005, defaultValue: 0 },
  { key: "whitepoint", label: "Whitepoint", min: 0.1,  max: 2.0, step: 0.005, defaultValue: 1 },
  { key: "lift",       label: "Lift",       min: -0.5, max: 0.5, step: 0.005, defaultValue: 0 },
  { key: "gain",       label: "Gain",       min: 0.0,  max: 3.0, step: 0.005, defaultValue: 1 },
  { key: "multiply",   label: "Multiply",   min: 0.0,  max: 3.0, step: 0.005, defaultValue: 1 },
  { key: "offset",     label: "Offset",     min: -0.5, max: 0.5, step: 0.005, defaultValue: 0 },
  { key: "gamma",      label: "Gamma",      min: 0.1,  max: 4.0, step: 0.01,  defaultValue: 1 },
];

export const GRADE_CHANNEL_COLOR: Record<"r" | "g" | "b", string> = {
  r: "#ef4444",
  g: "#22c55e",
  b: "#3b82f6",
};

/**
 * DOM id of the wheel popover. Exported because the popover is portaled to
 * `document.body` — OUTSIDE the React tree of whatever editor opened it — and
 * binds Escape on `window` to close itself. A host that also binds Escape on
 * `window` (CompModal, where Escape discards the draft) has no other way to ask
 * "is the wheel taking this key?".
 */
export const GRADE_WHEEL_POP_ID = "grade-wheel-pop";

export interface GradeRowProps {
  def: GradeSliderDef;
  value: GradeChannelValue;
  expanded: boolean;
  onChange: (next: GradeChannelValue) => void;
  onToggleExpanded: () => void;
  /**
   * Label column width in px. Only exists so the row can line up with the
   * host's other rows (the comp panel's are 64px wide); the default is what the
   * Color Grade node has always used.
   */
  labelWidth?: number;
}

/**
 * One slider-row in master mode (single track) or split mode (three R/G/B
 * tracks). The colour swatch (always visible) opens a native colour picker
 * and assigns the picked RGB into r/g/b — clamping into the row's slider
 * range.
 */
export function GradeRow({ def, value, expanded, onChange, onToggleExpanded, labelWidth = 58 }: GradeRowProps) {
  const isDefault = value.r === def.defaultValue && value.g === def.defaultValue && value.b === def.defaultValue;

  const setChannel = useCallback(
    (ch: "r" | "g" | "b", v: number) => {
      onChange({ ...value, [ch]: v });
    },
    [value, onChange]
  );

  const setMaster = useCallback(
    (v: number) => {
      onChange(masterValue(v));
    },
    [onChange]
  );

  const reset = useCallback(() => {
    onChange(masterValue(def.defaultValue));
  }, [def.defaultValue, onChange]);

  // Native colour picker — kept as an option alongside the wheel. Sets
  // r/g/b directly to the picked colour, clamped to the row's range.
  const colorInputRef = useRef<HTMLInputElement>(null);
  const onColorPicked = useCallback(
    (hex: string) => {
      const picked = hexToChannel(hex);
      const clamp = (n: number) => Math.max(def.min, Math.min(def.max, n));
      onChange({ r: clamp(picked.r), g: clamp(picked.g), b: clamp(picked.b) });
    },
    [def.min, def.max, onChange],
  );

  // ─── Colour wheel (balance) + level (master) ───────────────────
  // Disk radius maps to ±(¼ of the row's range) of channel balance.
  const strength = (def.max - def.min) * 0.25;
  const clampCh = useCallback(
    (n: number) => Math.max(def.min, Math.min(def.max, n)),
    [def.min, def.max],
  );
  const wheelPoint = channelToWheel(value, strength);
  const level = channelLevel(value);

  const onWheel = useCallback(
    (pt: WheelPoint) => {
      const nv = wheelToChannel(pt, channelLevel(value), strength);
      onChange({ r: clampCh(nv.r), g: clampCh(nv.g), b: clampCh(nv.b) });
    },
    [value, strength, clampCh, onChange],
  );
  const onLevel = useCallback(
    (newLevel: number) => {
      const old = channelLevel(value);
      const d = newLevel - old;
      onChange({ r: clampCh(value.r + d), g: clampCh(value.g + d), b: clampCh(value.b + d) });
    },
    [value, clampCh, onChange],
  );

  // Wheel popover anchored to the swatch (portaled to body so it isn't
  // clipped by the node's scroll container). Position is clamped into the
  // viewport on open and the user can drag it by its header.
  const POP_W = 210;
  const POP_H = 220;
  const swatchRef = useRef<HTMLButtonElement>(null);
  const [wheelOpen, setWheelOpen] = useState(false);
  const [popPos, setPopPos] = useState<{ left: number; top: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const clampPos = (left: number, top: number) => ({
    left: Math.max(8, Math.min(window.innerWidth - POP_W - 8, left)),
    top: Math.max(8, Math.min(window.innerHeight - POP_H - 8, top)),
  });

  const openWheel = useCallback(() => {
    const rect = swatchRef.current?.getBoundingClientRect();
    if (rect) {
      // Prefer below the swatch; flip above if it would overflow the bottom.
      let top = rect.bottom + 4;
      if (top + POP_H > window.innerHeight) top = rect.top - POP_H - 4;
      setPopPos(clampPos(rect.left, top));
    }
    setWheelOpen(true);
  }, []);

  const onHeaderDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    setPopPos((cur) => {
      if (cur) dragRef.current = { dx: e.clientX - cur.left, dy: e.clientY - cur.top };
      return cur;
    });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);
  const onHeaderMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    setPopPos(clampPos(e.clientX - dragRef.current.dx, e.clientY - dragRef.current.dy));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onHeaderUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);
  useEffect(() => {
    if (!wheelOpen) return;
    const close = (e: MouseEvent) => {
      const pop = document.getElementById(GRADE_WHEEL_POP_ID);
      if (pop && pop.contains(e.target as HTMLElement)) return;
      if (swatchRef.current?.contains(e.target as HTMLElement)) return;
      setWheelOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setWheelOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [wheelOpen]);

  const swatchHex = channelToHex(value);

  // Slider+number block factored out so the master row and each channel
  // row in split mode share rendering.
  //
  // IMPORTANT: this is a plain render *function*, called inline as
  // `{renderTrack(...)}` — NOT a nested React component used as
  // `<Track />`. A nested component gets a fresh type identity on every
  // GradeRow render, which makes React unmount + remount both <input>s
  // each tick — catastrophic mid-slider-drag, ×7 rows. Calling it as a
  // function inlines the JSX and reconciles normally (no remount).
  const renderTrack = (
    chValue: number,
    onCh: (v: number) => void,
    accent?: string,
  ) => (
    <>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={chValue}
        onChange={(e) => onCh(parseFloat(e.target.value))}
        className="flex-1 h-1 cursor-pointer min-w-0"
        style={{ accentColor: accent ?? "#3b82f6" }}
      />
      <input
        type="number"
        min={def.min}
        max={def.max}
        step={def.step}
        value={chValue}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onCh(v);
        }}
        className="w-[44px] shrink-0 text-[9px] py-0.5 px-1 rounded bg-[#1a1a1a] focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white tabular-nums"
      />
    </>
  );

  return (
    <div className="px-1 py-0.5 border-b border-neutral-800/40 last:border-b-0">
      {/* Header line: label + (master slider | empty) + buttons */}
      <div className="flex items-center gap-1">
        <label
          className="text-[9px] text-neutral-300 shrink-0 cursor-pointer truncate"
          style={{ width: labelWidth }}
          title={`${def.label} — double-click to reset`}
          onDoubleClick={reset}
        >
          {def.label}
        </label>

        {!expanded ? (
          // Master mode → single track
          renderTrack(value.r, setMaster)
        ) : (
          // In split mode the master track row is replaced by spacer so
          // the buttons stay right-aligned.
          <span className="flex-1" />
        )}

        {/* Colour swatch — opens the grading colour-wheel popover. */}
        <button
          ref={swatchRef}
          type="button"
          onClick={() => (wheelOpen ? setWheelOpen(false) : openWheel())}
          className="w-4 h-4 shrink-0 rounded border border-neutral-600 cursor-pointer"
          style={{ backgroundColor: swatchHex }}
          title="Colour balance wheel"
        />
        {wheelOpen && popPos && createPortal(
          <div
            id={GRADE_WHEEL_POP_ID}
            className="fixed z-[300] bg-neutral-900/95 border border-neutral-700 rounded-lg shadow-2xl backdrop-blur-sm"
            style={{ left: popPos.left, top: popPos.top, width: POP_W }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Draggable header */}
            <div
              className="flex items-center justify-between px-3 py-1.5 border-b border-neutral-800 cursor-move select-none touch-none"
              onPointerDown={onHeaderDown}
              onPointerMove={onHeaderMove}
              onPointerUp={onHeaderUp}
            >
              <span className="text-[10px] text-neutral-300">{def.label}</span>
              <button
                onClick={() => setWheelOpen(false)}
                className="w-4 h-4 flex items-center justify-center text-neutral-500 hover:text-white"
                title="Close"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex items-start gap-2 p-3">
              <ColorWheel point={wheelPoint} onChange={onWheel} onReset={reset} />
              {/* Vertical level (master) slider */}
              <div className="flex flex-col items-center gap-1 h-[130px]">
                <input
                  type="range"
                  min={def.min}
                  max={def.max}
                  step={def.step}
                  value={level}
                  onChange={(e) => onLevel(parseFloat(e.target.value))}
                  className="nodrag nopan accent-indigo-500 cursor-pointer"
                  style={{ writingMode: "vertical-lr", direction: "rtl", height: "110px" }}
                  title="Level (master)"
                />
                <span className="text-[9px] text-neutral-400 tabular-nums">{level.toFixed(2)}</span>
              </div>
            </div>
            <div className="flex items-center justify-between px-3 pb-3 -mt-1">
              <span className="text-[9px] text-neutral-500 tabular-nums">
                R{value.r.toFixed(2)} G{value.g.toFixed(2)} B{value.b.toFixed(2)}
              </span>
              <div className="flex items-center gap-1.5">
                {/* Native colour picker — alternative to the wheel. */}
                <button
                  onClick={() => colorInputRef.current?.click()}
                  className="flex items-center gap-1 text-[9px] px-2 py-0.5 rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                  title="Pick a colour directly (sets R/G/B)"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-sm border border-neutral-600"
                    style={{ backgroundColor: swatchHex }}
                  />
                  Picker
                </button>
                <input
                  ref={colorInputRef}
                  type="color"
                  value={swatchHex}
                  onChange={(e) => onColorPicked(e.target.value)}
                  className="sr-only"
                />
                <button
                  onClick={reset}
                  className="text-[9px] px-2 py-0.5 rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                >
                  Reset
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

        {/* Master ⇄ split toggle */}
        <button
          type="button"
          onClick={onToggleExpanded}
          className="w-4 h-4 shrink-0 rounded text-[9px] flex items-center justify-center bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
          title={expanded ? "Collapse to master (uses red value)" : "Split into R/G/B"}
        >
          {expanded ? "↻" : "⊕"}
        </button>

        {/* Reset */}
        <button
          type="button"
          onClick={reset}
          disabled={isDefault}
          className={`w-4 h-4 shrink-0 rounded text-[9px] flex items-center justify-center ${
            isDefault
              ? "bg-neutral-800 text-neutral-700"
              : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
          }`}
          title={`Reset ${def.label}`}
        >
          ↺
        </button>
      </div>

      {/* Split mode: three R/G/B sub-rows. */}
      {expanded && (
        <div className="space-y-0.5 mt-0.5" style={{ paddingLeft: labelWidth }}>
          {(["r", "g", "b"] as const).map((ch) => (
            <div key={ch} className="flex items-center gap-1">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: GRADE_CHANNEL_COLOR[ch] }}
                title={ch.toUpperCase()}
              />
              {renderTrack(value[ch], (v) => setChannel(ch, v), GRADE_CHANNEL_COLOR[ch])}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
