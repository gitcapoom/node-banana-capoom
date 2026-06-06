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
import type { CompNodeData } from "@/types";

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
  const modalOpenForThis = useCompStore((s) => s.isModalOpen && s.sourceNodeId === id);
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
    op: nodeData.mergeOp, pm: nodeData.premultiplyFg,
    fgT: nodeData.fgTransform, faT: nodeData.fgAlphaTransform, mtT: nodeData.matteTransform,
    far: nodeData.fgAlphaReformat, mtr: nodeData.matteReformat,
    bgUrl: incoming.bg, fgUrl: incoming.fg, faUrl: incoming.fgAlpha, mtUrl: incoming.matte,
  });

  useEffect(() => {
    if (modalOpenForThis) return; // editor owns rendering while open
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
  }, [sig, modalOpenForThis]);

  // Free the float texture when the node is removed.
  useEffect(() => () => releaseColorNode(id), [id]);

  const handleEdit = useCallback(() => {
    if (!nodeData.bgImage) { return; }
    openModal(id);
  }, [id, nodeData.bgImage, openModal]);

  const hasBg = !!nodeData.bgImage;

  // Whole node = the GPU-rendered composite (full-bleed), sized to the output.
  // No controls live on the node — double-click opens the editor for everything.
  return (
    <BaseNode id={id} selected={selected} fullBleed aspectFitMedia={nodeData.outputImage}>
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
          className="absolute z-10 text-[9px] text-white/80 font-medium drop-shadow"
          style={{ left: 5, top: h.top, transform: "translateY(-50%)", pointerEvents: "none" }}
        >
          {h.label}
        </div>
      ))}
      <Handle type="source" position={Position.Right} id="image" data-handletype="image" style={{ top: "50%", width: 11, height: 11, background: "#2dd4bf", border: "1px solid #0008" }} />

      <div
        className="group absolute inset-0 overflow-hidden rounded-lg bg-neutral-900/60 cursor-pointer"
        onDoubleClick={() => hasBg && handleEdit()}
        title={hasBg ? "Double-click to open the comp editor" : "Connect a BG image"}
      >
        {hasBg ? (
          <>
            <canvas ref={canvasRef} className="w-full h-full object-contain" />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/15 transition-colors flex items-center justify-center pointer-events-none">
              <span className="text-[10px] font-medium text-white opacity-0 group-hover:opacity-100 bg-black/50 px-2 py-1 rounded">Double-click to edit</span>
            </div>
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-neutral-500">
            Connect a BG image
          </div>
        )}
      </div>
    </BaseNode>
  );
}
