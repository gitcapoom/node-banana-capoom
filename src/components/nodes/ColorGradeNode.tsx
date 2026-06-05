"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { GpuEditorOverlay } from "./GpuEditorOverlay";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import {
  channelToHex,
  coerceChannel,
  hexToChannel,
  IDENTITY_GRADE,
  isIdentityGrade,
  isMaster,
  masterValue,
  type GradeChannelValue,
  type GradeParams,
} from "@/utils/colorGrade";
import { useGpuLivePreview, useGpuCommit } from "@/hooks/useGpuPreview";
import { GRADE_SHADER } from "@/utils/imageShaders";
import type { UniformValue } from "@/utils/webglProcess";
import type { ColorGradeNodeData } from "@/types";

type ColorGradeNodeType = Node<ColorGradeNodeData, "colorGrade">;

interface SliderDef {
  key: keyof GradeParams;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

const SLIDERS: SliderDef[] = [
  { key: "blackpoint", label: "Blackpoint", min: -0.5, max: 0.5, step: 0.005, defaultValue: 0 },
  { key: "whitepoint", label: "Whitepoint", min: 0.1,  max: 2.0, step: 0.005, defaultValue: 1 },
  { key: "lift",       label: "Lift",       min: -0.5, max: 0.5, step: 0.005, defaultValue: 0 },
  { key: "gain",       label: "Gain",       min: 0.0,  max: 3.0, step: 0.005, defaultValue: 1 },
  { key: "multiply",   label: "Multiply",   min: 0.0,  max: 3.0, step: 0.005, defaultValue: 1 },
  { key: "offset",     label: "Offset",     min: -0.5, max: 0.5, step: 0.005, defaultValue: 0 },
  { key: "gamma",      label: "Gamma",      min: 0.1,  max: 4.0, step: 0.01,  defaultValue: 1 },
];

const CHANNEL_COLOR: Record<"r" | "g" | "b", string> = {
  r: "#ef4444",
  g: "#22c55e",
  b: "#3b82f6",
};

interface RowProps {
  def: SliderDef;
  value: GradeChannelValue;
  expanded: boolean;
  onChange: (next: GradeChannelValue) => void;
  onToggleExpanded: () => void;
}

/**
 * One slider-row in master mode (single track) or split mode (three R/G/B
 * tracks). The colour swatch (always visible) opens a native colour picker
 * and assigns the picked RGB into r/g/b — clamping into the row's slider
 * range.
 */
function GradeRow({ def, value, expanded, onChange, onToggleExpanded }: RowProps) {
  const isDefault = value.r === def.defaultValue && value.g === def.defaultValue && value.b === def.defaultValue;
  const colorInputRef = useRef<HTMLInputElement>(null);

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

  const onColorPicked = useCallback(
    (hex: string) => {
      const picked = hexToChannel(hex);
      const clamp = (n: number) => Math.max(def.min, Math.min(def.max, n));
      onChange({
        r: clamp(picked.r),
        g: clamp(picked.g),
        b: clamp(picked.b),
      });
    },
    [def.min, def.max, onChange]
  );

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
          className="text-[9px] text-neutral-300 w-[58px] shrink-0 cursor-pointer truncate"
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

        {/* Colour swatch — opens native picker, assigns clamped RGB. */}
        <button
          type="button"
          onClick={() => colorInputRef.current?.click()}
          className="w-4 h-4 shrink-0 rounded border border-neutral-600 cursor-pointer"
          style={{ backgroundColor: swatchHex }}
          title="Pick a colour to set R/G/B"
        />
        <input
          ref={colorInputRef}
          type="color"
          value={swatchHex}
          onChange={(e) => onColorPicked(e.target.value)}
          className="hidden"
        />

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
        <div className="space-y-0.5 mt-0.5 pl-[58px]">
          {(["r", "g", "b"] as const).map((ch) => (
            <div key={ch} className="flex items-center gap-1">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: CHANNEL_COLOR[ch] }}
                title={ch.toUpperCase()}
              />
              {renderTrack(value[ch], (v) => setChannel(ch, v), CHANNEL_COLOR[ch])}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ColorGradeNode({ id, data, selected }: NodeProps<ColorGradeNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  // Scoped selector that returns just the incoming image string. Zustand
  // bails out when the result is === across renders, so this node only
  // re-renders when its upstream image actually changes — NOT on every
  // unrelated store update (which subscribing to the whole `nodes` array
  // would cause, and which was a chunk of the Color Grade drag lag).
  const incomingImage = useWorkflowStore((state): string | null => {
    for (const edge of state.edges) {
      if (edge.target !== id) continue;
      if (edge.targetHandle !== "image" && edge.targetHandle != null) continue;
      const src = state.nodes.find((n) => n.id === edge.source);
      if (!src) continue;
      const out = getSourceOutput(
        src,
        edge.sourceHandle,
        edge.data as Record<string, unknown> | undefined
      );
      if (out.type === "image" && out.value) return out.value;
    }
    return null;
  });

  useEffect(() => {
    if (incomingImage !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: incomingImage });
    }
  }, [id, incomingImage, nodeData.sourceImage, updateNodeData]);

  // Coerce stored params (handles legacy single-number values from before
  // per-channel was added) into a stable GradeParams object.
  const params: GradeParams = useMemo(
    () => ({
      blackpoint: coerceChannel(nodeData.blackpoint, 0),
      whitepoint: coerceChannel(nodeData.whitepoint, 1),
      lift:       coerceChannel(nodeData.lift, 0),
      gain:       coerceChannel(nodeData.gain, 1),
      multiply:   coerceChannel(nodeData.multiply, 1),
      offset:     coerceChannel(nodeData.offset, 0),
      gamma:      coerceChannel(nodeData.gamma, 1),
    }),
    [
      nodeData.blackpoint, nodeData.whitepoint, nodeData.lift,
      nodeData.gain, nodeData.multiply, nodeData.offset, nodeData.gamma,
    ]
  );

  // Which rows are currently in split-mode UI? We DON'T persist this — if a
  // row is master-equal (r===g===b) it shows as a single slider, otherwise
  // as three. The toggle button forces split-mode even when values match
  // (so the user can split, edit one channel, etc.).
  const [forceSplit, setForceSplit] = useState<Record<keyof GradeParams, boolean>>({
    blackpoint: false, whitepoint: false, lift: false,
    gain: false, multiply: false, offset: false, gamma: false,
  });

  const toggleExpanded = useCallback((key: keyof GradeParams) => {
    setForceSplit((s) => ({ ...s, [key]: !s[key] }));
  }, []);

  const setParamValue = useCallback(
    (key: keyof GradeParams, next: GradeChannelValue) => {
      updateNodeData(id, { [key]: next });
      // If user entered a non-master value, auto-stick the row in split mode.
      if (!isMaster(next)) setForceSplit((s) => ({ ...s, [key]: true }));
    },
    [id, updateNodeData]
  );

  const resetAll = useCallback(() => {
    updateNodeData(id, { ...IDENTITY_GRADE });
    setForceSplit({
      blackpoint: false, whitepoint: false, lift: false,
      gain: false, multiply: false, offset: false, gamma: false,
    });
  }, [id, updateNodeData]);

  // GPU uniforms — each grade parameter is a vec3 (per-channel R/G/B).
  const uniforms: Record<string, UniformValue> = useMemo(
    () => ({
      u_blackpoint: [params.blackpoint.r, params.blackpoint.g, params.blackpoint.b],
      u_whitepoint: [params.whitepoint.r, params.whitepoint.g, params.whitepoint.b],
      u_lift:       [params.lift.r,       params.lift.g,       params.lift.b],
      u_gain:       [params.gain.r,       params.gain.g,       params.gain.b],
      u_multiply:   [params.multiply.r,   params.multiply.g,   params.multiply.b],
      u_offset:     [params.offset.r,     params.offset.g,     params.offset.b],
      u_gamma:      [params.gamma.r,      params.gamma.g,      params.gamma.b],
    }),
    [params],
  );
  const identity = isIdentityGrade(params);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const nodeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Live GPU preview (in-node always, overlay only while open) + a
  // debounced commit of outputImage for downstream / save.
  useGpuLivePreview(nodeCanvasRef, nodeData.sourceImage, GRADE_SHADER, uniforms);
  useGpuLivePreview(overlayCanvasRef, nodeData.sourceImage, GRADE_SHADER, uniforms, overlayOpen);
  useGpuCommit(id, nodeData.sourceImage, GRADE_SHADER, uniforms, identity);

  const hasImage = !!nodeData.sourceImage;

  return (
    <>
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip flex flex-col"
      aspectFitMedia={nodeData.outputImage}
    >
      <Handle type="target" position={Position.Left} id="image" data-handletype="image" />
      <Handle type="source" position={Position.Right} id="image" data-handletype="image" />

      <div className="nodrag nowheel max-h-[260px] overflow-y-auto rounded bg-neutral-900/30 mb-1">
        {SLIDERS.map((s) => {
          const value = params[s.key];
          const expanded = forceSplit[s.key] || !isMaster(value);
          return (
            <GradeRow
              key={s.key}
              def={s}
              value={value}
              expanded={expanded}
              onChange={(next) => setParamValue(s.key, next)}
              onToggleExpanded={() => toggleExpanded(s.key)}
            />
          );
        })}
      </div>

      <div className="flex items-center justify-between mb-1 px-1 nodrag">
        <button
          onClick={resetAll}
          disabled={identity}
          className={`text-[10px] py-0.5 px-2 rounded transition-colors ${
            identity
              ? "bg-neutral-800 text-neutral-600"
              : "bg-neutral-700 text-neutral-200 hover:bg-neutral-600"
          }`}
          title="Reset all to identity"
        >
          Reset all
        </button>
        {identity && (
          <span className="text-[9px] text-neutral-600 italic">passthrough</span>
        )}
      </div>

      {hasImage ? (
        <div
          className="relative w-full flex-1 min-h-0 cursor-pointer"
          onDoubleClick={() => setOverlayOpen(true)}
          title="Double-click for full-screen editor"
        >
          <canvas ref={nodeCanvasRef} className="w-full h-full object-contain" />
        </div>
      ) : (
        <div className="w-full flex-1 min-h-0 bg-neutral-900/40 flex flex-col items-center justify-center">
          <svg className="w-6 h-6 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z" />
          </svg>
          <span className="text-[10px] text-neutral-500 mt-1">
            Connect an image
          </span>
        </div>
      )}
    </BaseNode>

    {overlayOpen && hasImage && (
      <GpuEditorOverlay
        title="Color Grade"
        canvasRef={overlayCanvasRef}
        onClose={() => setOverlayOpen(false)}
      >
        {/* Sliders write through to nodeData; the live GPU preview hook
            re-renders the overlay canvas immediately on each change. */}
        <div className="nodrag nowheel max-h-[60vh] overflow-y-auto">
          {SLIDERS.map((s) => {
            const value = params[s.key];
            const expanded = forceSplit[s.key] || !isMaster(value);
            return (
              <GradeRow
                key={s.key}
                def={s}
                value={value}
                expanded={expanded}
                onChange={(next) => setParamValue(s.key, next)}
                onToggleExpanded={() => toggleExpanded(s.key)}
              />
            );
          })}
        </div>
        <button
          onClick={resetAll}
          disabled={identity}
          className={`mt-2 text-[11px] py-1 px-3 rounded transition-colors ${
            identity
              ? "bg-neutral-800 text-neutral-600"
              : "bg-neutral-700 text-neutral-200 hover:bg-neutral-600"
          }`}
        >
          Reset all
        </button>
      </GpuEditorOverlay>
    )}
    </>
  );
}
