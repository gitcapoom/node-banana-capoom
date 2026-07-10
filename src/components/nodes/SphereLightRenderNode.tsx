"use client";

import { useCallback, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { renderSphereLight } from "@/utils/renderSphereLight";
import type { SphereLightRenderNodeData } from "@/types";

type SphereLightRenderNodeType = Node<SphereLightRenderNodeData, "sphereLightRender">;

const RENDER_SIZE = 512;

/** A filled-bar slider with the label + value centered on it (matches the design). */
function LightSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="relative nodrag nopan h-6 rounded overflow-hidden bg-neutral-800 select-none">
      <div className="absolute inset-y-0 left-0 bg-slate-500/70" style={{ width: `${pct}%` }} />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize"
        title={`${label} ${format(value)}`}
      />
      <span className="absolute inset-0 flex items-center justify-center text-[11px] text-white pointer-events-none">
        {label} {format(value)}
      </span>
    </div>
  );
}

export function SphereLightRenderNode({ id, data, selected }: NodeProps<SphereLightRenderNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const { rotation, elevation, intensity, outputImage } = nodeData;

  const set = useCallback(
    (patch: Partial<SphereLightRenderNodeData>) => updateNodeData(id, patch),
    [id, updateNodeData],
  );

  // Re-render locally whenever the light params change. Immediate on first paint
  // (so a fresh node shows something), debounced during slider drags. Does NOT
  // depend on outputImage, so writing the result back can't re-trigger it.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const doRender = () => {
      const url = renderSphereLight({ rotation, elevation, intensity }, RENDER_SIZE);
      if (url) updateNodeData(id, { outputImage: url, outputImageRef: undefined, status: "complete", error: null });
    };
    if (!outputImage) {
      doRender();
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(doRender, 120);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, rotation, elevation, intensity, updateNodeData]);

  return (
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip flex flex-col gap-1.5 p-1.5"
      aspectFitMedia={outputImage}
    >
      {/* Rendered image output */}
      <Handle type="source" position={Position.Right} id="image" data-handletype="image" title="render" />

      <LightSlider label="rotation" value={rotation} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}`} onChange={(v) => set({ rotation: v })} />
      <LightSlider label="elevation" value={elevation} min={-90} max={90} step={1} format={(v) => `${Math.round(v)}`} onChange={(v) => set({ elevation: v })} />
      <LightSlider label="intensity" value={intensity} min={0} max={10} step={0.1} format={(v) => v.toFixed(1)} onChange={(v) => set({ intensity: v })} />

      <div className="relative w-full flex-1 min-h-0 rounded-md overflow-hidden bg-neutral-900/40 flex items-center justify-center">
        {outputImage ? (
          <img src={outputImage} alt="Sphere light render" className="w-full h-full object-contain" draggable={false} />
        ) : (
          <span className="text-[10px] text-neutral-500">Rendering…</span>
        )}
      </div>
    </BaseNode>
  );
}
