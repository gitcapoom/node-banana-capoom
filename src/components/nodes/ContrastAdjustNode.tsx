"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { useColorNode } from "@/hooks/useGpuPreview";
import { CONTRAST_SHADER } from "@/utils/imageShaders";
import type { UniformValue } from "@/utils/webglProcess";
import { GpuEditorOverlay } from "./GpuEditorOverlay";
import { ClampToggles, COLOR_NODE_TYPES } from "./colorNodeShared";
import type { ContrastAdjustNodeData } from "@/types";

type ContrastAdjustNodeType = Node<ContrastAdjustNodeData, "contrastAdjust">;

const DEFAULTS = { contrast: 1, rolloff: 0.3, pivot: 0.5 } as const;

interface SliderDef {
  key: "contrast" | "rolloff" | "pivot";
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  format: (v: number) => string;
}

const SLIDERS: SliderDef[] = [
  { key: "contrast", label: "Contrast", min: 0,   max: 3,    step: 0.01, defaultValue: 1,   format: (v) => v.toFixed(2) },
  { key: "rolloff",  label: "Roll-off", min: 0,   max: 1,    step: 0.01, defaultValue: 0.3, format: (v) => v.toFixed(2) },
  { key: "pivot",    label: "Pivot",    min: 0.1, max: 0.9,  step: 0.01, defaultValue: 0.5, format: (v) => v.toFixed(2) },
];

function isIdentity(d: Pick<ContrastAdjustNodeData, "contrast">): boolean {
  return d.contrast === 1;
}

export function ContrastAdjustNode({ id, data, selected }: NodeProps<ContrastAdjustNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const loadNodeFullResInputs = useWorkflowStore((s) => s.loadNodeFullResInputs);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const nodeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const incomingImage = useWorkflowStore((state): string | null => {
    const edge = state.edges.find((e) => e.target === id && e.targetHandle === "image");
    if (!edge) return null;
    const src = state.nodes.find((n) => n.id === edge.source);
    if (!src) return null;
    const out = getSourceOutput(src, edge.sourceHandle);
    return out.type === "image" ? out.value : null;
  });
  const upstreamColorNodeId = useWorkflowStore((state): string | null => {
    const edge = state.edges.find((e) => e.target === id && e.targetHandle === "image");
    if (!edge) return null;
    const src = state.nodes.find((n) => n.id === edge.source);
    return src && COLOR_NODE_TYPES.has(src.type as string) ? src.id : null;
  });

  useEffect(() => {
    if (incomingImage !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: incomingImage, sourceImageRef: undefined });
    }
  }, [id, incomingImage, nodeData.sourceImage, updateNodeData]);

  const uniforms: Record<string, UniformValue> = useMemo(
    () => ({ u_contrast: nodeData.contrast, u_rolloff: nodeData.rolloff, u_pivot: nodeData.pivot }),
    [nodeData.contrast, nodeData.rolloff, nodeData.pivot],
  );

  useColorNode({
    id,
    sourceImage: nodeData.sourceImage,
    upstreamColorNodeId,
    shaderSource: CONTRAST_SHADER,
    uniforms,
    clampBlacks: nodeData.clampBlacks ?? false,
    clampWhites: nodeData.clampWhites ?? false,
    isIdentity: isIdentity(nodeData),
    nodeCanvasRef,
    overlayCanvasRef,
    overlayOpen,
  });

  const handleSliderChange = useCallback(
    (key: SliderDef["key"], v: number) => updateNodeData(id, { [key]: v }),
    [id, updateNodeData],
  );
  const handleReset = useCallback(() => updateNodeData(id, DEFAULTS), [id, updateNodeData]);
  const setClamp = useCallback(
    (which: "clampBlacks" | "clampWhites", v: boolean) => updateNodeData(id, { [which]: v }),
    [id, updateNodeData],
  );

  // Live GPU preview needs the full-res source (lazily null on open) → show the
  // saved thumb until the editor opens / a run loads it. No WebGL work on open.
  const hasFullRes = !!nodeData.sourceImage;
  const thumb = nodeData.outputImageThumb;
  const handleOpenEditor = useCallback(() => {
    setOverlayOpen(true);
    void loadNodeFullResInputs(id);
  }, [id, loadNodeFullResInputs]);

  const controls = (
    <>
      <SliderRows nodeData={nodeData} onSlider={handleSliderChange} onReset={handleReset} />
      <ClampToggles
        clampBlacks={nodeData.clampBlacks ?? false}
        clampWhites={nodeData.clampWhites ?? false}
        onChange={setClamp}
      />
    </>
  );

  return (
    <>
      <BaseNode id={id} selected={selected} contentClassName="flex flex-col gap-1 p-2">
        <Handle type="target" position={Position.Left} id="image" data-handletype="image" />
        <Handle type="source" position={Position.Right} id="image" data-handletype="image" />

        <div
          className="relative w-full aspect-square bg-neutral-900/60 rounded overflow-hidden cursor-pointer"
          onDoubleClick={handleOpenEditor}
          title={hasFullRes || thumb ? "Double-click to open full-screen editor" : "Connect an image"}
        >
          {hasFullRes ? (
            <canvas ref={nodeCanvasRef} className="w-full h-full object-contain" />
          ) : thumb ? (
            <img src={thumb} alt="Contrast adjust" className="w-full h-full object-contain" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] text-neutral-500">
              Connect an image
            </div>
          )}
        </div>

        {controls}
      </BaseNode>

      {overlayOpen && hasFullRes && (
        <GpuEditorOverlay title="Contrast Adjust" canvasRef={overlayCanvasRef} onClose={() => setOverlayOpen(false)}>
          {controls}
        </GpuEditorOverlay>
      )}
    </>
  );
}

interface SliderRowsProps {
  nodeData: ContrastAdjustNodeData;
  onSlider: (key: SliderDef["key"], v: number) => void;
  onReset: () => void;
}

function SliderRows({ nodeData, onSlider, onReset }: SliderRowsProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {SLIDERS.map((def) => {
        const v = nodeData[def.key];
        return (
          <div key={def.key} className="flex items-center gap-1.5">
            <label className="text-[10px] text-neutral-400 w-[58px] shrink-0">{def.label}</label>
            <input
              type="range"
              min={def.min}
              max={def.max}
              step={def.step}
              value={v}
              onChange={(e) => onSlider(def.key, parseFloat(e.target.value))}
              onDoubleClick={() => onSlider(def.key, def.defaultValue)}
              className="nodrag nopan flex-1 h-1 accent-indigo-500 cursor-pointer min-w-0"
              title="Double-click to reset"
            />
            <span className="text-[10px] text-neutral-300 w-[44px] shrink-0 tabular-nums text-right">
              {def.format(v)}
            </span>
          </div>
        );
      })}
      <button onClick={onReset} className="nodrag nopan text-[10px] text-neutral-400 hover:text-white self-end">
        Reset all
      </button>
    </div>
  );
}
