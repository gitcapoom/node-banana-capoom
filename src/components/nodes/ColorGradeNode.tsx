"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { applyGrade, IDENTITY_GRADE, isIdentityGrade, type GradeParams } from "@/utils/colorGrade";
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

export function ColorGradeNode({ id, data, selected }: NodeProps<ColorGradeNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);

  // Live upstream image: subscribe to nodes+edges, derive via memo (returns
  // a string so Object.is comparison works downstream).
  const incomingImage = useMemo<string | null>(() => {
    for (const edge of edges) {
      if (edge.target !== id) continue;
      if (edge.targetHandle !== "image" && edge.targetHandle != null) continue;
      const src = nodes.find((n) => n.id === edge.source);
      if (!src) continue;
      const out = getSourceOutput(
        src,
        edge.sourceHandle,
        edge.data as Record<string, unknown> | undefined
      );
      if (out.type === "image" && out.value) return out.value;
    }
    return null;
  }, [edges, nodes, id]);

  // Mirror upstream into sourceImage (for save/load round-trip).
  useEffect(() => {
    if (incomingImage !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: incomingImage });
    }
  }, [id, incomingImage, nodeData.sourceImage, updateNodeData]);

  // Current grade params, derived from nodeData with defaults.
  const params: GradeParams = useMemo(
    () => ({
      blackpoint: nodeData.blackpoint ?? 0,
      whitepoint: nodeData.whitepoint ?? 1,
      lift:       nodeData.lift ?? 0,
      gain:       nodeData.gain ?? 1,
      multiply:   nodeData.multiply ?? 1,
      offset:     nodeData.offset ?? 0,
      gamma:      nodeData.gamma ?? 1,
    }),
    [
      nodeData.blackpoint, nodeData.whitepoint, nodeData.lift,
      nodeData.gain, nodeData.multiply, nodeData.offset, nodeData.gamma,
    ]
  );

  // Re-grade whenever source or params change. Fingerprint-guarded so the
  // settled promise self-cancels if a newer change supersedes it.
  const lastFingerprintRef = useRef<string>("");
  const [busy, setBusy] = useState(false);
  const fingerprint = useMemo(() => {
    const src = nodeData.sourceImage;
    if (!src) return "";
    return `${src.length}|${params.blackpoint}|${params.whitepoint}|${params.lift}|${params.gain}|${params.multiply}|${params.offset}|${params.gamma}`;
  }, [nodeData.sourceImage, params]);

  useEffect(() => {
    const src = nodeData.sourceImage;

    if (!src) {
      if (nodeData.outputImage) updateNodeData(id, { outputImage: null });
      lastFingerprintRef.current = "";
      setBusy(false);
      return;
    }

    if (isIdentityGrade(params)) {
      if (nodeData.outputImage !== src) updateNodeData(id, { outputImage: src });
      lastFingerprintRef.current = fingerprint;
      setBusy(false);
      return;
    }

    if (lastFingerprintRef.current === fingerprint) return;
    lastFingerprintRef.current = fingerprint;

    setBusy(true);
    applyGrade(src, params)
      .then((output) => {
        if (lastFingerprintRef.current !== fingerprint) return;
        updateNodeData(id, { outputImage: output, outputImageRef: undefined });
        setBusy(false);
      })
      .catch((err) => {
        if (lastFingerprintRef.current !== fingerprint) return;
        console.error("ColorGradeNode: grade failed", err);
        updateNodeData(id, { outputImage: src });
        setBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fingerprint, updateNodeData]);

  const setParam = useCallback(
    (key: keyof GradeParams, value: number) => {
      updateNodeData(id, { [key]: value });
    },
    [id, updateNodeData]
  );

  const resetAll = useCallback(() => {
    updateNodeData(id, { ...IDENTITY_GRADE });
  }, [id, updateNodeData]);

  const displayImage = nodeData.outputImage || nodeData.sourceImage;
  const isIdentity = isIdentityGrade(params);

  return (
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip flex flex-col"
      aspectFitMedia={nodeData.outputImage}
    >
      <Handle type="target" position={Position.Left} id="image" data-handletype="image" />
      <Handle type="source" position={Position.Right} id="image" data-handletype="image" />

      {/* Sliders */}
      <div className="space-y-1 mb-1 px-1 nodrag nowheel">
        {SLIDERS.map((s) => {
          const value = params[s.key];
          const isDefault = value === s.defaultValue;
          return (
            <div key={s.key} className="flex items-center gap-1">
              <label
                className="text-[9px] text-neutral-400 w-[58px] shrink-0 cursor-pointer"
                title={s.label}
                onDoubleClick={() => setParam(s.key, s.defaultValue)}
              >
                {s.label}
              </label>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={value}
                onChange={(e) => setParam(s.key, parseFloat(e.target.value))}
                className="flex-1 h-1 accent-blue-500 cursor-pointer min-w-0"
              />
              <input
                type="number"
                min={s.min}
                max={s.max}
                step={s.step}
                value={value}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (Number.isFinite(v)) setParam(s.key, v);
                }}
                className="w-[44px] shrink-0 text-[9px] py-0.5 px-1 rounded bg-[#1a1a1a] focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white tabular-nums"
              />
              <button
                onClick={() => setParam(s.key, s.defaultValue)}
                disabled={isDefault}
                title={`Reset ${s.label}`}
                className={`w-3 h-3 shrink-0 rounded-full text-[10px] flex items-center justify-center ${
                  isDefault
                    ? "bg-neutral-800 text-neutral-700"
                    : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
                }`}
              >
                ↺
              </button>
            </div>
          );
        })}
      </div>

      {/* Reset all button */}
      <div className="flex items-center justify-between mb-1 px-1 nodrag">
        <button
          onClick={resetAll}
          disabled={isIdentity}
          className={`text-[10px] py-0.5 px-2 rounded transition-colors ${
            isIdentity
              ? "bg-neutral-800 text-neutral-600"
              : "bg-neutral-700 text-neutral-200 hover:bg-neutral-600"
          }`}
          title="Reset all to identity"
        >
          Reset all
        </button>
        {isIdentity && (
          <span className="text-[9px] text-neutral-600 italic">passthrough</span>
        )}
      </div>

      {/* Preview */}
      {displayImage ? (
        <div className="relative w-full flex-1 min-h-0">
          <img
            src={displayImage}
            alt="Graded"
            className="w-full h-full object-contain"
          />
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
              <span className="text-[10px] text-white/80 bg-black/60 px-2 py-0.5 rounded">
                grading…
              </span>
            </div>
          )}
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
  );
}
