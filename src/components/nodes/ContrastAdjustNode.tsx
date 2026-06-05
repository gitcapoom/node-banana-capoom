"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { processImageWithShader } from "@/utils/webglProcess";
import { CONTRAST_SHADER } from "@/utils/imageShaders";
import { GpuEditorOverlay } from "./GpuEditorOverlay";
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
  const [overlayOpen, setOverlayOpen] = useState(false);

  // Subscribe to live upstream output.
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

  const lastFingerprintRef = useRef<string>("");
  useEffect(() => {
    const src = nodeData.sourceImage;
    if (!src) {
      if (nodeData.outputImage !== null) updateNodeData(id, { outputImage: null });
      lastFingerprintRef.current = "";
      return;
    }
    if (isIdentity(nodeData)) {
      if (nodeData.outputImage !== src) updateNodeData(id, { outputImage: src, outputImageRef: undefined });
      lastFingerprintRef.current = `identity:${src.length}`;
      return;
    }
    const fingerprint = `${src.length}|${nodeData.contrast}|${nodeData.rolloff}|${nodeData.pivot}`;
    if (lastFingerprintRef.current === fingerprint) return;
    lastFingerprintRef.current = fingerprint;

    processImageWithShader(src, CONTRAST_SHADER, {
      u_contrast: nodeData.contrast,
      u_rolloff: nodeData.rolloff,
      u_pivot: nodeData.pivot,
    })
      .then((output) => {
        if (lastFingerprintRef.current !== fingerprint) return;
        updateNodeData(id, { outputImage: output, outputImageRef: undefined });
      })
      .catch((err) => {
        console.error("ContrastAdjustNode: shader failed", err);
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

        <div
          className="relative w-full aspect-square bg-neutral-900/60 rounded overflow-hidden cursor-pointer"
          onDoubleClick={() => displayImage && setOverlayOpen(true)}
          title={displayImage ? "Double-click to open full-screen editor" : "Connect an image"}
        >
          {displayImage ? (
            <img src={displayImage} alt="Contrast preview" className="w-full h-full object-contain" />
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
          title="Contrast Adjust"
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
      <button
        onClick={onReset}
        className="nodrag nopan text-[10px] text-neutral-400 hover:text-white self-end"
      >
        Reset all
      </button>
    </div>
  );
}
