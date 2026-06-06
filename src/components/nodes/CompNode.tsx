"use client";

import { useCallback, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { useCompStore } from "@/store/compStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { releaseColorNode, renderCompToCanvas, floatNodeToDataUrl } from "@/utils/colorChain";
import { buildCompInputs, buildCompParams, compositeCompForExecutor } from "@/utils/compComposite";
import { COMP_OP_LABELS } from "@/types/comp";
import type { CompNodeData, CompMergeOp } from "@/types";

type CompNodeType = Node<CompNodeData, "comp">;

const INPUT_HANDLES: Array<{ id: string; label: string; top: string; color: string }> = [
  { id: "image-comp_bg", label: "BG", top: "22%", color: "#2dd4bf" },
  { id: "image-comp_fg", label: "FG", top: "42%", color: "#38bdf8" },
  { id: "image-comp_fg_alpha", label: "FG α", top: "62%", color: "#a3a3a3" },
  { id: "image-comp_matte", label: "Matte", top: "82%", color: "#a3a3a3" },
];

export function CompNode({ id, data, selected }: NodeProps<CompNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const openModal = useCompStore((s) => s.openModal);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Resolve the 4 inputs (url + producing node id) by targetHandle.
  const incoming = useWorkflowStore(
    useShallow((state) => {
      const r = {
        bg: null as string | null, fg: null as string | null, fgAlpha: null as string | null, matte: null as string | null,
        bgSrc: null as string | null, fgSrc: null as string | null, faSrc: null as string | null, mtSrc: null as string | null,
      };
      for (const e of state.edges) {
        if (e.target !== id) continue;
        const src = state.nodes.find((n) => n.id === e.source);
        if (!src) continue;
        const out = getSourceOutput(src, e.sourceHandle, e.data as Record<string, unknown> | undefined);
        if (out.type !== "image" || !out.value) continue;
        if (e.targetHandle === "image-comp_bg") { r.bg = out.value; r.bgSrc = src.id; }
        else if (e.targetHandle === "image-comp_fg") { r.fg = out.value; r.fgSrc = src.id; }
        else if (e.targetHandle === "image-comp_fg_alpha") { r.fgAlpha = out.value; r.faSrc = src.id; }
        else if (e.targetHandle === "image-comp_matte") { r.matte = out.value; r.mtSrc = src.id; }
      }
      return r;
    }),
  );

  // Mirror resolved inputs into node data (guarded against loops).
  useEffect(() => {
    const patch: Partial<CompNodeData> = {};
    if (incoming.bg !== nodeData.bgImage) { patch.bgImage = incoming.bg; patch.bgImageRef = undefined; }
    if (incoming.fg !== nodeData.fgImage) { patch.fgImage = incoming.fg; patch.fgImageRef = undefined; }
    if (incoming.fgAlpha !== nodeData.fgAlphaImage) { patch.fgAlphaImage = incoming.fgAlpha; patch.fgAlphaImageRef = undefined; }
    if (incoming.matte !== nodeData.matteImage) { patch.matteImage = incoming.matte; patch.matteImageRef = undefined; }
    if (Object.keys(patch).length) updateNodeData(id, patch);
  }, [incoming, nodeData.bgImage, nodeData.fgImage, nodeData.fgAlphaImage, nodeData.matteImage, id, updateNodeData]);

  // Live preview + commit whenever inputs/params change.
  const sig = JSON.stringify({
    bgSrc: incoming.bgSrc, fgSrc: incoming.fgSrc, faSrc: incoming.faSrc, mtSrc: incoming.mtSrc,
    op: nodeData.mergeOp,
    fgT: nodeData.fgTransform, faT: nodeData.fgAlphaTransform, mtT: nodeData.matteTransform,
    far: nodeData.fgAlphaReformat, mtr: nodeData.matteReformat,
    bgUrl: incoming.bg, fgUrl: incoming.fg, faUrl: incoming.fgAlpha, mtUrl: incoming.matte,
  });

  useEffect(() => {
    let cancelled = false;
    const urls = { bg: incoming.bg, fg: incoming.fg, fgAlpha: incoming.fgAlpha, matte: incoming.matte };
    const srcs = { bgSrc: incoming.bgSrc, fgSrc: incoming.fgSrc, faSrc: incoming.faSrc, mtSrc: incoming.mtSrc };
    const run = async () => {
      if (!urls.bg) {
        if (nodeData.outputImage !== null) updateNodeData(id, { outputImage: null, outputImageRef: undefined });
        return;
      }
      const canvas = canvasRef.current;
      const ok = canvas ? await renderCompToCanvas(buildCompInputs(urls, srcs), buildCompParams(nodeData), id, canvas) : false;
      if (cancelled) return;
      if (ok) {
        const url = await floatNodeToDataUrl(id);
        if (!cancelled && url && url !== nodeData.outputImage) {
          updateNodeData(id, { outputImage: url, outputImageRef: undefined });
        }
      } else {
        const { dataUrl, outW, outH } = await compositeCompForExecutor(urls, srcs, nodeData, id);
        if (cancelled || !dataUrl) return;
        if (canvas && outW > 0) {
          const img = new Image();
          img.onload = () => { if (cancelled || !canvasRef.current) return; canvasRef.current.width = outW; canvasRef.current.height = outH; canvasRef.current.getContext("2d")?.drawImage(img, 0, 0); };
          img.src = dataUrl;
        }
        if (dataUrl !== nodeData.outputImage) {
          updateNodeData(id, { outputImage: dataUrl, outputImageRef: undefined, outputWidth: outW, outputHeight: outH });
        }
      }
    };
    const t = setTimeout(run, 80);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Free the float texture when the node is removed.
  useEffect(() => () => releaseColorNode(id), [id]);

  const handleEdit = useCallback(() => {
    if (!nodeData.bgImage) { return; }
    openModal(id);
  }, [id, nodeData.bgImage, openModal]);

  const handleOpChange = useCallback(
    (op: CompMergeOp) => updateNodeData(id, { mergeOp: op }),
    [id, updateNodeData],
  );

  const hasBg = !!nodeData.bgImage;

  return (
    <BaseNode id={id} selected={selected} contentClassName="flex flex-col gap-1 p-2">
      {INPUT_HANDLES.map((h) => (
        <Handle
          key={h.id}
          type="target"
          position={Position.Left}
          id={h.id}
          data-handletype="image"
          style={{ top: h.top, width: 11, height: 11, background: h.color, border: "1px solid #0008" }}
        />
      ))}
      {INPUT_HANDLES.map((h) => (
        <div
          key={`lbl-${h.id}`}
          className="absolute text-[9px] text-neutral-400 font-medium"
          style={{ left: 6, top: h.top, transform: "translateY(-50%)", pointerEvents: "none" }}
        >
          {h.label}
        </div>
      ))}
      <Handle type="source" position={Position.Right} id="image" data-handletype="image" style={{ top: "50%", width: 11, height: 11, background: "#2dd4bf", border: "1px solid #0008" }} />

      <div
        className="relative w-full aspect-square bg-neutral-900/60 rounded overflow-hidden cursor-pointer"
        onDoubleClick={() => hasBg && handleEdit()}
        title={hasBg ? "Double-click to open the comp editor" : "Connect a BG image"}
      >
        {hasBg ? (
          <>
            <canvas ref={canvasRef} className="w-full h-full object-contain" />
            <div className="absolute inset-0 bg-black/0 hover:bg-black/10 transition-colors flex items-center justify-center pointer-events-none">
              <button
                onClick={(e) => { e.stopPropagation(); handleEdit(); }}
                className="nodrag nopan text-[10px] font-medium text-white opacity-0 hover:opacity-100 bg-black/50 px-2 py-1 rounded pointer-events-auto cursor-pointer"
              >
                Edit comp
              </button>
            </div>
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-neutral-500">
            Connect a BG image
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <label className="text-[10px] text-neutral-400 shrink-0">Op</label>
        <select
          value={nodeData.mergeOp}
          onChange={(e) => handleOpChange(e.target.value as CompMergeOp)}
          className="nodrag nopan flex-1 min-w-0 text-[10px] py-0.5 px-1 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700"
        >
          {COMP_OP_LABELS.map((o) => (
            <option key={o.op} value={o.op}>{o.label}</option>
          ))}
        </select>
      </div>
    </BaseNode>
  );
}
