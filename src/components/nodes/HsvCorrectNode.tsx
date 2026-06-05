"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { processImageWithShader } from "@/utils/webglProcess";
import { HSV_SHADER } from "@/utils/imageShaders";
import { GpuEditorOverlay } from "./GpuEditorOverlay";
import type { HsvCorrectNodeData } from "@/types";

type HsvCorrectNodeType = Node<HsvCorrectNodeData, "hsvCorrect">;

const DEFAULTS = { hueShift: 0, saturation: 1, value: 1 } as const;

interface SliderDef {
  key: "hueShift" | "saturation" | "value";
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  format: (v: number) => string;
}

const SLIDERS: SliderDef[] = [
  { key: "hueShift",   label: "Hue",        min: -180, max: 180, step: 1,    defaultValue: 0, format: (v) => `${v.toFixed(0)}°` },
  { key: "saturation", label: "Saturation", min: 0,    max: 2,   step: 0.01, defaultValue: 1, format: (v) => v.toFixed(2) },
  { key: "value",      label: "Value",      min: 0,    max: 2,   step: 0.01, defaultValue: 1, format: (v) => v.toFixed(2) },
];

function isIdentityHsv(d: Pick<HsvCorrectNodeData, "hueShift" | "saturation" | "value">): boolean {
  return d.hueShift === 0 && d.saturation === 1 && d.value === 1;
}

export function HsvCorrectNode({ id, data, selected }: NodeProps<HsvCorrectNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const [overlayOpen, setOverlayOpen] = useState(false);

  // Subscribe live to upstream output so we re-render when it changes.
  const incomingImage = useWorkflowStore((state) => {
    const edge = state.edges.find((e) => e.target === id && e.targetHandle === "image");
    if (!edge) return null;
    const sourceNode = state.nodes.find((n) => n.id === edge.source);
    if (!sourceNode) return null;
    const out = getSourceOutput(sourceNode, edge.sourceHandle);
    return out.type === "image" ? out.value : null;
  });

  useEffect(() => {
    if (incomingImage !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: incomingImage, sourceImageRef: undefined });
    }
  }, [id, incomingImage, nodeData.sourceImage, updateNodeData]);

  // Auto-process on slider change. Debounces via a single in-flight job
  // ref + a stale-fingerprint guard so quick drags don't pile up.
  const lastFingerprintRef = useRef<string>("");
  useEffect(() => {
    const src = nodeData.sourceImage;
    if (!src) {
      if (nodeData.outputImage !== null) updateNodeData(id, { outputImage: null });
      lastFingerprintRef.current = "";
      return;
    }
    if (isIdentityHsv(nodeData)) {
      if (nodeData.outputImage !== src) updateNodeData(id, { outputImage: src, outputImageRef: undefined });
      lastFingerprintRef.current = `identity:${src.length}`;
      return;
    }
    const fingerprint = `${src.length}|${nodeData.hueShift}|${nodeData.saturation}|${nodeData.value}`;
    if (lastFingerprintRef.current === fingerprint) return;
    lastFingerprintRef.current = fingerprint;

    processImageWithShader(src, HSV_SHADER, {
      u_hueShift: nodeData.hueShift,
      u_saturation: nodeData.saturation,
      u_value: nodeData.value,
    })
      .then((output) => {
        if (lastFingerprintRef.current !== fingerprint) return; // dropped by newer drag
        updateNodeData(id, { outputImage: output, outputImageRef: undefined });
      })
      .catch((err) => {
        console.error("HsvCorrectNode: shader failed", err);
        updateNodeData(id, { outputImage: src, outputImageRef: undefined });
      });
  }, [id, nodeData, updateNodeData]);

  const handleSliderChange = useCallback(
    (key: SliderDef["key"], v: number) => {
      updateNodeData(id, { [key]: v });
    },
    [id, updateNodeData],
  );
  const handleReset = useCallback(() => {
    updateNodeData(id, DEFAULTS);
  }, [id, updateNodeData]);

  const displayImage = nodeData.outputImage || nodeData.sourceImage;

  return (
    <>
      <BaseNode id={id} selected={selected} contentClassName="flex flex-col gap-1 p-2">
        <Handle type="target" position={Position.Left} id="image" data-handletype="image" />
        <Handle type="source" position={Position.Right} id="image" data-handletype="image" />

        {/* Tiny live preview — double-click to open the fullscreen editor */}
        <div
          className="relative w-full aspect-square bg-neutral-900/60 rounded overflow-hidden cursor-pointer"
          onDoubleClick={() => displayImage && setOverlayOpen(true)}
          title={displayImage ? "Double-click to open full-screen editor" : "Connect an image"}
        >
          {displayImage ? (
            <img src={displayImage} alt="HSV preview" className="w-full h-full object-contain" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] text-neutral-500">
              Connect an image
            </div>
          )}
        </div>

        <SliderRows nodeData={nodeData} onSlider={handleSliderChange} onReset={handleReset} />
      </BaseNode>

      {overlayOpen && displayImage && (
        <GpuEditorOverlay
          title="HSV Color Correct"
          image={displayImage}
          onClose={() => setOverlayOpen(false)}
        >
          <SliderRows nodeData={nodeData} onSlider={handleSliderChange} onReset={handleReset} />
        </GpuEditorOverlay>
      )}
    </>
  );
}

interface SliderRowsProps {
  nodeData: HsvCorrectNodeData;
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
      <button
        onClick={onReset}
        className="nodrag nopan text-[10px] text-neutral-400 hover:text-white self-end"
      >
        Reset all
      </button>
    </div>
  );
}
