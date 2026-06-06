"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCompStore, type CompActiveInput } from "@/store/compStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { renderCompToCanvas, floatNodeToDataUrl, renderComp } from "@/utils/colorChain";
import { buildCompInputs, buildCompParams, compositeCompForExecutor } from "@/utils/compComposite";
import { COMP_OP_LABELS } from "@/types/comp";
import type { CompNodeData, CompMergeOp, CompReformat, CompTransform } from "@/types";

type NumKey = "hPos" | "vPos" | "rotation" | "scaleX" | "scaleY" | "centerX" | "centerY";
const NUM_FIELDS: Array<{ key: NumKey; label: string; step: number }> = [
  { key: "hPos", label: "H position", step: 1 },
  { key: "vPos", label: "V position", step: 1 },
  { key: "rotation", label: "Rotation", step: 1 },
  { key: "scaleX", label: "Scale X", step: 0.01 },
  { key: "scaleY", label: "Scale Y", step: 0.01 },
];
const REFORMATS: Array<{ v: CompReformat; label: string }> = [
  { v: "none", label: "None" },
  { v: "fill", label: "Fill" },
  { v: "fitH", label: "Fit Horizontal" },
  { v: "fitV", label: "Fit Vertical" },
];

export function CompModal() {
  const { isModalOpen, sourceNodeId, activeInput, closeModal, setActiveInput } = useCompStore();
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === sourceNodeId));
  const edges = useWorkflowStore((s) => s.edges);
  const nodes = useWorkflowStore((s) => s.nodes);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [busy, setBusy] = useState(false);

  const data = node?.data as CompNodeData | undefined;

  // Producing-node ids per input handle (for float resolution).
  const srcs = useMemo(() => {
    const r = { bgSrc: null as string | null, fgSrc: null as string | null, faSrc: null as string | null, mtSrc: null as string | null };
    if (!sourceNodeId) return r;
    for (const e of edges) {
      if (e.target !== sourceNodeId) continue;
      const src = nodes.find((n) => n.id === e.source);
      if (!src) continue;
      const out = getSourceOutput(src, e.sourceHandle, e.data as Record<string, unknown> | undefined);
      if (out.type !== "image" || !out.value) continue;
      if (e.targetHandle === "image-comp_bg") r.bgSrc = src.id;
      else if (e.targetHandle === "image-comp_fg") r.fgSrc = src.id;
      else if (e.targetHandle === "image-comp_fg_alpha") r.faSrc = src.id;
      else if (e.targetHandle === "image-comp_matte") r.mtSrc = src.id;
    }
    return r;
  }, [edges, nodes, sourceNodeId]);

  // Live preview, rAF/debounce-coalesced.
  const previewSig = data
    ? JSON.stringify({
        op: data.mergeOp, fg: data.fgTransform, fa: data.fgAlphaTransform, mt: data.matteTransform,
        far: data.fgAlphaReformat, mtr: data.matteReformat,
        bg: data.bgImage, fgU: data.fgImage, faU: data.fgAlphaImage, mtU: data.matteImage,
      })
    : "";
  useEffect(() => {
    if (!isModalOpen || !data || !sourceNodeId) return;
    let cancelled = false;
    const urls = { bg: data.bgImage, fg: data.fgImage, fgAlpha: data.fgAlphaImage, matte: data.matteImage };
    const run = async () => {
      const canvas = canvasRef.current;
      if (!canvas || !urls.bg) return;
      const ok = await renderCompToCanvas(buildCompInputs(urls, srcs), buildCompParams(data), sourceNodeId, canvas);
      if (cancelled || ok) return;
      // Fallback draw.
      const { dataUrl, outW, outH } = await compositeCompForExecutor(urls, srcs, data, sourceNodeId);
      if (cancelled || !dataUrl || !outW) return;
      const img = new Image();
      img.onload = () => { if (cancelled || !canvasRef.current) return; canvasRef.current.width = outW; canvasRef.current.height = outH; canvasRef.current.getContext("2d")?.drawImage(img, 0, 0); };
      img.src = dataUrl;
    };
    const raf = requestAnimationFrame(run);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSig, isModalOpen, srcs, sourceNodeId]);

  const activeTransform: CompTransform | undefined = data
    ? activeInput === "fg" ? data.fgTransform : activeInput === "fgAlpha" ? data.fgAlphaTransform : data.matteTransform
    : undefined;
  const activeKey = activeInput === "fg" ? "fgTransform" : activeInput === "fgAlpha" ? "fgAlphaTransform" : "matteTransform";

  const patchTransform = useCallback(
    (patch: Partial<CompTransform>) => {
      if (!sourceNodeId || !data) return;
      const cur = data[activeKey] as CompTransform;
      updateNodeData(sourceNodeId, { [activeKey]: { ...cur, ...patch } } as Partial<CompNodeData>);
    },
    [sourceNodeId, data, activeKey, updateNodeData],
  );

  const handleDone = useCallback(async () => {
    if (!sourceNodeId || !data || !data.bgImage) { closeModal(); return; }
    setBusy(true);
    try {
      const urls = { bg: data.bgImage, fg: data.fgImage, fgAlpha: data.fgAlphaImage, matte: data.matteImage };
      const res = await renderComp(buildCompInputs(urls, srcs), buildCompParams(data), sourceNodeId);
      if (res) {
        const url = (await floatNodeToDataUrl(sourceNodeId)) ?? data.bgImage;
        updateNodeData(sourceNodeId, { outputImage: url, outputImageRef: undefined, outputWidth: res.w, outputHeight: res.h });
      } else {
        const { dataUrl, outW, outH } = await compositeCompForExecutor(urls, srcs, data, sourceNodeId);
        if (dataUrl) updateNodeData(sourceNodeId, { outputImage: dataUrl, outputImageRef: undefined, outputWidth: outW, outputHeight: outH });
      }
    } finally {
      setBusy(false);
      closeModal();
    }
  }, [sourceNodeId, data, srcs, updateNodeData, closeModal]);

  if (!isModalOpen || !data) return null;

  const isFollow = activeInput === "fgAlpha" && !data.fgAlphaTransform.enabled;

  return (
    <div className="fixed inset-0 z-[100] bg-neutral-950 flex flex-col">
      <div className="h-14 bg-neutral-900 flex items-center justify-between px-4 border-b border-neutral-800">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-white mr-3">Composite</span>
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            Op
            <select
              value={data.mergeOp}
              onChange={(e) => sourceNodeId && updateNodeData(sourceNodeId, { mergeOp: e.target.value as CompMergeOp })}
              className="bg-neutral-800 text-white text-[11px] rounded px-1.5 py-1 outline-none border border-neutral-700"
            >
              {COMP_OP_LABELS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={closeModal} className="px-4 py-1.5 text-xs font-medium text-neutral-400 hover:text-white">Cancel</button>
          <button onClick={handleDone} disabled={busy} className="px-4 py-1.5 text-xs font-medium bg-white text-neutral-900 rounded hover:bg-neutral-200 disabled:opacity-60">{busy ? "…" : "Done"}</button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 overflow-hidden bg-neutral-900 flex items-center justify-center p-6">
          {data.bgImage ? (
            <canvas ref={canvasRef} className="max-w-full max-h-full object-contain" style={{ imageRendering: "auto" }} />
          ) : (
            <span className="text-sm text-neutral-500">Connect a BG image to the node.</span>
          )}
        </div>

        <div className="w-72 shrink-0 bg-neutral-900 border-l border-neutral-800 flex flex-col overflow-y-auto">
          {/* Tabs */}
          <div className="flex border-b border-neutral-800">
            {(["fg", "fgAlpha", "matte"] as CompActiveInput[]).map((t) => (
              <button
                key={t}
                onClick={() => setActiveInput(t)}
                className={`flex-1 py-2 text-[11px] font-medium ${activeInput === t ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"}`}
              >
                {t === "fg" ? "FG" : t === "fgAlpha" ? "FG α" : "Matte"}
              </button>
            ))}
          </div>

          <div className="p-3 flex flex-col gap-2.5">
            {/* Enable checkbox */}
            <label className="flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer">
              <input
                type="checkbox"
                checked={activeTransform?.enabled ?? false}
                onChange={(e) => patchTransform({ enabled: e.target.checked })}
                className="accent-teal-500"
              />
              {activeInput === "fgAlpha"
                ? (activeTransform?.enabled ? "Transform independently" : "Follow FG (uncheck-coupled)")
                : "Enable transform"}
            </label>

            {isFollow && (
              <div className="text-[10px] text-neutral-500 leading-snug">Following FG transform. Enable to move the alpha independently.</div>
            )}

            {/* Numeric fields */}
            <div className={`flex flex-col gap-1.5 ${activeTransform?.enabled ? "" : "opacity-50 pointer-events-none"}`}>
              {NUM_FIELDS.map((f) => (
                <div key={f.key} className="flex items-center gap-1.5">
                  <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">{f.label}</label>
                  <input
                    type="number"
                    step={f.step}
                    value={activeTransform ? Number(activeTransform[f.key].toFixed(4)) : 0}
                    onChange={(e) => patchTransform({ [f.key]: parseFloat(e.target.value) || 0 } as Partial<CompTransform>)}
                    className="nodrag flex-1 min-w-0 text-[10px] py-1 px-1.5 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700"
                  />
                </div>
              ))}
              {/* Center */}
              <div className="flex items-center gap-1.5 mt-1">
                <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">Center</label>
                <label className="flex items-center gap-1 text-[10px] text-neutral-400">
                  <input type="checkbox" checked={activeTransform?.centerAuto ?? true} onChange={(e) => patchTransform({ centerAuto: e.target.checked })} className="accent-teal-500" />
                  Auto
                </label>
              </div>
              {!activeTransform?.centerAuto && (
                <>
                  <div className="flex items-center gap-1.5">
                    <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">Center X</label>
                    <input type="number" step={1} value={activeTransform ? Number(activeTransform.centerX.toFixed(2)) : 0} onChange={(e) => patchTransform({ centerX: parseFloat(e.target.value) || 0 })} className="nodrag flex-1 min-w-0 text-[10px] py-1 px-1.5 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700" />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">Center Y</label>
                    <input type="number" step={1} value={activeTransform ? Number(activeTransform.centerY.toFixed(2)) : 0} onChange={(e) => patchTransform({ centerY: parseFloat(e.target.value) || 0 })} className="nodrag flex-1 min-w-0 text-[10px] py-1 px-1.5 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700" />
                  </div>
                </>
              )}
            </div>

            {/* Reformat (FG_Alpha / Matte only) */}
            {activeInput !== "fg" && (
              <div className="flex items-center gap-1.5 mt-1">
                <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">Reformat</label>
                <select
                  value={activeInput === "fgAlpha" ? data.fgAlphaReformat : data.matteReformat}
                  onChange={(e) => sourceNodeId && updateNodeData(sourceNodeId, activeInput === "fgAlpha" ? { fgAlphaReformat: e.target.value as CompReformat } : { matteReformat: e.target.value as CompReformat })}
                  className="nodrag flex-1 min-w-0 text-[10px] py-1 px-1.5 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700"
                >
                  {REFORMATS.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
                </select>
              </div>
            )}
            <div className="text-[10px] text-neutral-600 leading-snug mt-1">
              {activeInput === "fgAlpha" ? "Reformat matches FG." : activeInput === "matte" ? "Reformat matches BG. Matte limits where the merge happens." : "FG over BG. (0,0) = bottom-left."}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
