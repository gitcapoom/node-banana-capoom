"use client";

import { useCallback, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { releaseColorNode, renderBlurNodeToCanvas, commitBlurNode, type BlurNodeParams } from "@/utils/colorChain";
import { resolveInputRef } from "@/utils/compComposite";
import { cheapUrlKey, RenderSignatureCache } from "@/utils/renderSignature";
import type { BlurNodeData, BlurFilterType } from "@/types";

type BlurNodeType = Node<BlurNodeData, "blur">;

/** Last committed blur per node — survives viewport-culling remounts. */
const committedBlurs = new RenderSignatureCache();

const FILTERS: Array<{ v: BlurFilterType; label: string }> = [
  { v: "gaussian", label: "Gaussian" },
  { v: "box", label: "Box" },
  { v: "motion", label: "Motion" },
  { v: "zoom", label: "Zoom" },
  { v: "spin", label: "Spin" },
];

function paramsOf(d: BlurNodeData): BlurNodeParams {
  return {
    filter: d.filter ?? "gaussian",
    radius: d.radius ?? 10,
    angle: d.angle ?? 0,
    invertMatte: !!d.invertMatte,
    mixAmount: d.mixAmount ?? 1,
  };
}

export function BlurNode({ id, data, selected }: NodeProps<BlurNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const loadNodeFullResInputs = useWorkflowStore((s) => s.loadNodeFullResInputs);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Resolve the two inputs (url + producing node id) by targetHandle.
  const incoming = useWorkflowStore(
    useShallow((state) => {
      const r = {
        src: null as string | null, srcId: null as string | null,
        matte: null as string | null, matteId: null as string | null,
        srcConn: false, matteConn: false,
      };
      for (const e of state.edges) {
        if (e.target !== id) continue;
        const isPrimary = e.targetHandle === "image" || e.targetHandle == null;
        const isMatte = e.targetHandle === "image-blur_matte";
        if (isPrimary) r.srcConn = true;
        else if (isMatte) r.matteConn = true;
        else continue;
        const src = state.nodes.find((n) => n.id === e.source);
        if (!src) continue;
        const out = getSourceOutput(src, e.sourceHandle, e.data as Record<string, unknown> | undefined);
        if (out.type !== "image" || !out.value) continue;
        if (isPrimary) { r.src = out.value; r.srcId = src.id; }
        else { r.matte = out.value; r.matteId = src.id; }
      }
      return r;
    }),
  );

  // A connected pin must have a loaded value before rendering — a lazily
  // unloaded matte would silently render as "no matte" (blur everywhere).
  const allInputsResolved =
    (!incoming.srcConn || !!incoming.src) && (!incoming.matteConn || !!incoming.matte);

  // Mirror resolved inputs into node data (guarded against loops).
  useEffect(() => {
    const patch: Partial<BlurNodeData> = {};
    if (incoming.src !== nodeData.sourceImage) { patch.sourceImage = incoming.src; patch.sourceImageRef = undefined; }
    if (incoming.matte !== nodeData.matteImage) { patch.matteImage = incoming.matte; patch.matteImageRef = undefined; }
    if (Object.keys(patch).length) updateNodeData(id, patch);
  }, [incoming.src, incoming.matte, nodeData.sourceImage, nodeData.matteImage, id, updateNodeData]);

  const params = paramsOf(nodeData);
  // Cheap keys for the image URLs — see renderSignature.ts.
  const sig = JSON.stringify({
    src: cheapUrlKey(incoming.src), srcId: incoming.srcId,
    mt: cheapUrlKey(incoming.matte), mtId: incoming.matteId, p: params,
  });
  const latest = useRef({ incoming, params });
  latest.current = { incoming, params };

  // Live preview into the node canvas (fast GPU path, no PNG encode).
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const { incoming: inc, params: p } = latest.current;
      if (!inc.src) return;
      if (!allInputsResolved) { void loadNodeFullResInputs(id); return; }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ok = await renderBlurNodeToCanvas(
        resolveInputRef(inc.src, inc.srcId), resolveInputRef(inc.matte, inc.matteId), p, id, canvas,
      );
      if (!ok && !cancelled) console.warn("[blur] GPU preview unavailable", { id });
    };
    const t = setTimeout(run, 60);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, allInputsResolved, id]);

  // Debounced commit: publish the float texture + 8-bit PNG to outputImage.
  useEffect(() => {
    const { incoming: inc } = latest.current;
    if (!inc.src) {
      if (nodeData.outputImage !== null) updateNodeData(id, { outputImage: null, outputImageRef: undefined });
      committedBlurs.forget(id);
      return;
    }
    if (!allInputsResolved) return;
    // Unchanged since the last commit (typically a viewport-culling remount):
    // the live-preview effect above already repainted the canvas, and a commit
    // would re-encode the identical PNG and cascade a store update downstream.
    if (committedBlurs.matches(id, sig) && nodeData.outputImage) return;
    const t = setTimeout(async () => {
      const { incoming: cur, params: p } = latest.current;
      if (!cur.src) return;
      const out = await commitBlurNode(
        resolveInputRef(cur.src, cur.srcId), resolveInputRef(cur.matte, cur.matteId), p, id, cur.src,
      );
      committedBlurs.set(id, sig);
      updateNodeData(id, { outputImage: out, outputImageRef: undefined });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, allInputsResolved, id]);

  // Free the float texture + pooled blur targets when the node is removed.
  useEffect(() => () => releaseColorNode(id), [id]);

  const setParam = useCallback(
    (patch: Partial<BlurNodeData>) => updateNodeData(id, patch),
    [id, updateNodeData],
  );

  const hasSrc = !!nodeData.sourceImage;
  const thumb = nodeData.outputImageThumb;
  const isMotion = (nodeData.filter ?? "gaussian") === "motion";

  return (
    <BaseNode id={id} selected={selected} contentClassName="flex flex-col gap-1.5 p-2">
      <Handle type="target" position={Position.Left} id="image" data-handletype="image" style={{ top: "35%" }} />
      <Handle
        type="target" position={Position.Left} id="image-blur_matte" data-handletype="image"
        style={{ top: "70%", background: "#a3a3a3" }}
      />
      <div
        className="absolute z-10 text-[9px] text-white/70 font-medium drop-shadow"
        style={{ left: 5, top: "70%", transform: "translateY(-50%)", pointerEvents: "none" }}
      >
        Matte
      </div>
      <Handle type="source" position={Position.Right} id="image" data-handletype="image" />

      <div
        data-node-media="outputImage"
        className="relative w-full aspect-square bg-neutral-900/60 rounded overflow-hidden cursor-pointer"
        title="Double-click to view full screen"
      >
        {hasSrc && allInputsResolved ? (
          <canvas ref={canvasRef} className="w-full h-full object-contain" />
        ) : thumb ? (
          <img src={thumb} alt="Blur" className="w-full h-full object-contain" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-neutral-500">
            Connect an image
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <label className="text-[10px] text-neutral-400 w-[52px] shrink-0">Filter</label>
        <select
          value={nodeData.filter ?? "gaussian"}
          onChange={(e) => setParam({ filter: e.target.value as BlurFilterType })}
          className="nodrag nopan flex-1 min-w-0 text-[10px] py-1 px-1.5 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700"
        >
          {FILTERS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
        </select>
      </div>

      <SliderRow label="Amount" min={0} max={100} step={1} value={nodeData.radius ?? 10}
        format={(v) => `${Math.round(v)}px`} onChange={(v) => setParam({ radius: v })} resetValue={10} />
      {isMotion && (
        <SliderRow label="Angle" min={0} max={360} step={1} value={nodeData.angle ?? 0}
          format={(v) => `${Math.round(v)}°`} onChange={(v) => setParam({ angle: v })} resetValue={0} />
      )}
      <SliderRow label="Mix" min={0} max={1} step={0.01} value={nodeData.mixAmount ?? 1}
        format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setParam({ mixAmount: v })} resetValue={1} />

      <label
        className={`flex items-center gap-1.5 text-[10px] cursor-pointer ${incoming.matteConn ? "text-neutral-300" : "text-neutral-500"}`}
        title={incoming.matteConn ? "Blur where the matte is black instead of white" : "Connect a matte to gate where the blur lands"}
      >
        <input
          type="checkbox"
          checked={!!nodeData.invertMatte}
          onChange={(e) => setParam({ invertMatte: e.target.checked })}
          className="nodrag nopan accent-indigo-500"
        />
        Invert matte
      </label>
    </BaseNode>
  );
}

interface SliderRowProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  resetValue: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}

function SliderRow({ label, min, max, step, value, resetValue, format, onChange }: SliderRowProps) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="text-[10px] text-neutral-400 w-[52px] shrink-0">{label}</label>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onDoubleClick={() => onChange(resetValue)}
        className="nodrag nopan flex-1 h-1 accent-indigo-500 cursor-pointer min-w-0"
        title="Double-click to reset"
      />
      <span className="text-[10px] text-neutral-300 w-[40px] shrink-0 tabular-nums text-right">{format(value)}</span>
    </div>
  );
}
