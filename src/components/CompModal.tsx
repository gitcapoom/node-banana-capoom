"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Line, Circle, Rect } from "react-konva";
import Konva from "konva";
import { useCompStore, type CompActiveInput } from "@/store/compStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { renderCompToCanvas, floatNodeToDataUrl, renderComp } from "@/utils/colorChain";
import { buildCompInputs, buildCompParams, compositeCompForExecutor } from "@/utils/compComposite";
import { computePieces, reformatScale, forwardPoint, forwardCorners, type CompPieces } from "@/utils/compTransform";
import { COMP_OP_LABELS, defaultCompTransform } from "@/types/comp";
import { RESAMPLE_FILTER_LABELS, type ResampleFilter } from "@/utils/resampleFilters";
import type { CompNodeData, CompMergeOp, CompReformat, CompTransform } from "@/types";

type Pt = { x: number; y: number };
type NumKey = "hPos" | "vPos" | "rotation" | "scaleX" | "scaleY";
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

function loadSize(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export function CompModal() {
  const { isModalOpen, sourceNodeId, activeInput, closeModal, setActiveInput } = useCompStore();
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === sourceNodeId));
  const edges = useWorkflowStore((s) => s.edges);
  const nodes = useWorkflowStore((s) => s.nodes);

  const stageRef = useRef<Konva.Stage>(null);
  const imageNodeRef = useRef<Konva.Image>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const translateRef = useRef<{ startPL: { x: number; y: number }; startH: number; startV: number } | null>(null);
  const offscreen = useMemo(() => (typeof document !== "undefined" ? document.createElement("canvas") : null), []);
  // Checkerboard tile for visualizing transparency behind the composite.
  const checkerTile = useMemo(() => {
    if (typeof document === "undefined") return null;
    const cell = 8, c = document.createElement("canvas");
    c.width = cell * 2; c.height = cell * 2;
    const cx = c.getContext("2d");
    if (cx) { cx.fillStyle = "#454545"; cx.fillRect(0, 0, cell * 2, cell * 2); cx.fillStyle = "#5e5e5e"; cx.fillRect(0, 0, cell, cell); cx.fillRect(cell, cell, cell, cell); }
    return c;
  }, []);
  const [, setPreviewTick] = useState(0);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [sizes, setSizes] = useState<{ bg?: { w: number; h: number }; bgAlpha?: { w: number; h: number }; fg?: { w: number; h: number }; fgAlpha?: { w: number; h: number }; matte?: { w: number; h: number } }>({});
  const [busy, setBusy] = useState(false);

  const data = node?.data as CompNodeData | undefined;
  const resSrc = data?.outputResolution === "fg" && sizes.fg ? sizes.fg : sizes.bg;
  const outW = resSrc?.w ?? 0;
  const outH = resSrc?.h ?? 0;

  const srcs = useMemo(() => {
    const r = { bgSrc: null as string | null, baSrc: null as string | null, fgSrc: null as string | null, faSrc: null as string | null, mtSrc: null as string | null };
    if (!sourceNodeId) return r;
    for (const e of edges) {
      if (e.target !== sourceNodeId) continue;
      const src = nodes.find((n) => n.id === e.source);
      if (!src) continue;
      const out = getSourceOutput(src, e.sourceHandle, e.data as Record<string, unknown> | undefined);
      if (out.type !== "image" || !out.value) continue;
      if (e.targetHandle === "image-comp_bg") r.bgSrc = src.id;
      else if (e.targetHandle === "image-comp_bg_alpha") r.baSrc = src.id;
      else if (e.targetHandle === "image-comp_fg") r.fgSrc = src.id;
      else if (e.targetHandle === "image-comp_fg_alpha") r.faSrc = src.id;
      else if (e.targetHandle === "image-comp_matte") r.mtSrc = src.id;
    }
    return r;
  }, [edges, nodes, sourceNodeId]);

  // Decode input sizes (for handle geometry + stage fit).
  useEffect(() => {
    if (!isModalOpen || !data) return;
    let cancelled = false;
    (async () => {
      const [bg, ba, fg, fa, mt] = await Promise.all([
        data.bgImage ? loadSize(data.bgImage) : Promise.resolve(undefined),
        data.bgAlphaImage ? loadSize(data.bgAlphaImage) : Promise.resolve(undefined),
        data.fgImage ? loadSize(data.fgImage) : Promise.resolve(undefined),
        data.fgAlphaImage ? loadSize(data.fgAlphaImage) : Promise.resolve(undefined),
        data.matteImage ? loadSize(data.matteImage) : Promise.resolve(undefined),
      ]);
      if (cancelled) return;
      setSizes({ bg: bg ?? undefined, bgAlpha: ba ?? undefined, fg: fg ?? undefined, fgAlpha: fa ?? undefined, matte: mt ?? undefined });
    })();
    return () => { cancelled = true; };
  }, [isModalOpen, data?.bgImage, data?.bgAlphaImage, data?.fgImage, data?.fgAlphaImage, data?.matteImage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom-to-fit when BG size known / container ready.
  useEffect(() => {
    if (!isModalOpen || !outW || !outH || !containerRef.current) return;
    const cw = containerRef.current.clientWidth;
    const ch = containerRef.current.clientHeight;
    setStageSize({ width: cw, height: ch });
    const s = Math.min((cw - 80) / outW, (ch - 80) / outH, 1);
    setScale(s);
    setPosition({ x: (cw - outW * s) / 2, y: (ch - outH * s) / 2 });
  }, [isModalOpen, outW, outH]);

  // Live preview into the offscreen canvas, rAF-coalesced.
  const previewSig = data
    ? JSON.stringify({ op: data.mergeOp, pm: data.premultiplyFg, pmb: data.premultiplyBg, sw: data.swapBgFg, res: data.outputResolution, flt: data.compFilter, bo: [data.bgBlackOutside, data.fgBlackOutside], bgT: data.bgTransform, baT: data.bgAlphaTransform, fg: data.fgTransform, fa: data.fgAlphaTransform, mt: data.matteTransform, bar: data.bgAlphaReformat, far: data.fgAlphaReformat, mtr: data.matteReformat, bg: data.bgImage, baU: data.bgAlphaImage, fgU: data.fgImage, faU: data.fgAlphaImage, mtU: data.matteImage })
    : "";
  useEffect(() => {
    if (!isModalOpen || !data || !sourceNodeId || !offscreen) return;
    let cancelled = false;
    const urls = { bg: data.bgImage, bgAlpha: data.bgAlphaImage, fg: data.fgImage, fgAlpha: data.fgAlphaImage, matte: data.matteImage };
    const run = async () => {
      if (!urls.bg) return;
      const ok = await renderCompToCanvas(buildCompInputs(urls, srcs), buildCompParams(data), sourceNodeId, offscreen);
      if (!cancelled && !ok) {
        const { dataUrl, outW: w, outH: h } = await compositeCompForExecutor(urls, srcs, data, sourceNodeId);
        if (cancelled || !dataUrl || !w) return;
        await new Promise<void>((res) => { const img = new Image(); img.onload = () => { offscreen.width = w; offscreen.height = h; offscreen.getContext("2d")?.drawImage(img, 0, 0); res(); }; img.onerror = () => res(); img.src = dataUrl; });
      }
      if (!cancelled) { imageNodeRef.current?.getLayer()?.batchDraw(); setPreviewTick((t) => t + 1); }
    };
    const raf = requestAnimationFrame(run);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [previewSig, isModalOpen, srcs, sourceNodeId, offscreen]);

  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const by = 1.1;
    setScale((s) => Math.min(Math.max(e.evt.deltaY > 0 ? s / by : s * by, 0.05), 8));
  }, []);

  const TKEY = { bg: "bgTransform", bgAlpha: "bgAlphaTransform", fg: "fgTransform", fgAlpha: "fgAlphaTransform", matte: "matteTransform" } as const;
  const activeKey = TKEY[activeInput];
  // Merge against defaults so legacy/partial transforms always have every field.
  const activeTransform: CompTransform | undefined = data
    ? { ...defaultCompTransform(), ...((data[activeKey] as Partial<CompTransform> | undefined) ?? {}) }
    : undefined;
  const activeSize = activeInput === "bg" ? sizes.bg : activeInput === "bgAlpha" ? sizes.bgAlpha : activeInput === "fg" ? sizes.fg : activeInput === "fgAlpha" ? sizes.fgAlpha : sizes.matte;
  // Which input does this one follow when its checkbox is off? (alpha pins)
  const followsLabel = activeInput === "bgAlpha" ? "BG" : activeInput === "fgAlpha" ? "FG" : null;

  const patchTransform = useCallback(
    (patch: Partial<CompTransform>) => {
      if (!sourceNodeId || !data) return;
      const cur = { ...defaultCompTransform(), ...((data[activeKey] as Partial<CompTransform> | undefined) ?? {}) };
      const next = { ...cur, ...patch };
      // Scale lock: Scale Y follows Scale X (a Y-only edit drives X, then Y mirrors X).
      if (next.scaleLock) {
        if ("scaleY" in patch && !("scaleX" in patch)) next.scaleX = next.scaleY;
        next.scaleY = next.scaleX;
      }
      updateNodeData(sourceNodeId, { [activeKey]: next } as Partial<CompNodeData>);
    },
    [sourceNodeId, data, activeKey, updateNodeData],
  );

  // Active input placement pieces (for handles). Hidden unless enabled.
  const showHandles = !!(activeTransform?.enabled && activeSize && outW && outH);
  const pieces: CompPieces | null = useMemo(() => {
    if (!showHandles || !data || !activeTransform || !activeSize) return null;
    if (activeInput === "bg" || activeInput === "fg") return computePieces(activeTransform, "none", activeSize.w, activeSize.h, activeSize.w, activeSize.h);
    if (activeInput === "fgAlpha") {
      const rw = sizes.fg?.w ?? activeSize.w, rh = sizes.fg?.h ?? activeSize.h;
      return computePieces(activeTransform, data.fgAlphaReformat, rw, rh, activeSize.w, activeSize.h);
    }
    if (activeInput === "bgAlpha") {
      const rw = sizes.bg?.w ?? activeSize.w, rh = sizes.bg?.h ?? activeSize.h;
      return computePieces(activeTransform, data.bgAlphaReformat, rw, rh, activeSize.w, activeSize.h);
    }
    const mrw = sizes.bg?.w ?? outW, mrh = sizes.bg?.h ?? outH;
    return computePieces(activeTransform, data.matteReformat, mrw, mrh, activeSize.w, activeSize.h);
  }, [showHandles, data, activeTransform, activeSize, activeInput, sizes.fg, sizes.bg, outW, outH]);

  const sx0sy0 = useMemo<[number, number]>(() => {
    if (!data || !activeSize) return [1, 1];
    if (activeInput === "bg" || activeInput === "fg") return [1, 1];
    if (activeInput === "fgAlpha") return reformatScale(data.fgAlphaReformat, sizes.fg?.w ?? activeSize.w, sizes.fg?.h ?? activeSize.h, activeSize.w, activeSize.h);
    if (activeInput === "bgAlpha") return reformatScale(data.bgAlphaReformat, sizes.bg?.w ?? activeSize.w, sizes.bg?.h ?? activeSize.h, activeSize.w, activeSize.h);
    return reformatScale(data.matteReformat, sizes.bg?.w ?? outW, sizes.bg?.h ?? outH, activeSize.w, activeSize.h);
  }, [data, activeSize, activeInput, sizes.fg, sizes.bg, outW, outH]);

  // konva (top-left) <-> output bottom-left
  const toKonva = (o: Pt): Pt => ({ x: o.x, y: outH - o.y });
  const targetBL = (e: Konva.KonvaEventObject<DragEvent>): Pt => ({ x: e.target.x(), y: outH - e.target.y() });
  // Stage pointer → output bottom-left px (for live box translate).
  const stagePosBL = (): Pt => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const t = stage.getAbsoluteTransform().copy().invert();
    const pos = stage.getPointerPosition();
    if (!pos) return { x: 0, y: 0 };
    const p = t.point(pos);
    return { x: p.x, y: outH - p.y };
  };
  const onStageMove = () => {
    const d = translateRef.current;
    if (!d) return;
    const p = stagePosBL();
    patchTransform({ hPos: d.startH + (p.x - d.startPL.x), vPos: d.startV + (p.y - d.startPL.y) });
  };
  const endTranslate = () => { translateRef.current = null; };
  // Inverse rotation Rᵀ applied to a vector
  const invRot = (p: Pt, c: Pt): Pt => {
    if (!pieces) return p;
    const [cos, sin] = pieces.rot;
    const dx = p.x - c.x, dy = p.y - c.y;
    return { x: cos * dx + sin * dy, y: -sin * dx + cos * dy };
  };

  const hpx = (v: number) => v / scale;

  const handleDone = useCallback(async () => {
    if (!sourceNodeId || !data || !data.bgImage) { closeModal(); return; }
    setBusy(true);
    try {
      const urls = { bg: data.bgImage, bgAlpha: data.bgAlphaImage, fg: data.fgImage, fgAlpha: data.fgAlphaImage, matte: data.matteImage };
      const res = await renderComp(buildCompInputs(urls, srcs), buildCompParams(data), sourceNodeId);
      if (res) {
        const url = (await floatNodeToDataUrl(sourceNodeId)) ?? data.bgImage;
        updateNodeData(sourceNodeId, { outputImage: url, outputImageRef: undefined, outputWidth: res.w, outputHeight: res.h });
      } else {
        const { dataUrl, outW: w, outH: h } = await compositeCompForExecutor(urls, srcs, data, sourceNodeId);
        if (dataUrl) updateNodeData(sourceNodeId, { outputImage: dataUrl, outputImageRef: undefined, outputWidth: w, outputHeight: h });
      }
    } finally { setBusy(false); closeModal(); }
  }, [sourceNodeId, data, srcs, updateNodeData, closeModal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && isModalOpen) closeModal(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isModalOpen, closeModal]);

  if (!isModalOpen || !data) return null;

  const iw = activeSize?.w ?? 0, ih = activeSize?.h ?? 0;
  const corners = pieces ? forwardCorners(pieces).map(toKonva) : [];
  const center = pieces ? toKonva({ x: pieces.c[0], y: pieces.c[1] }) : { x: 0, y: 0 };
  const rightMid = pieces ? toKonva(forwardPoint(pieces, iw, ih / 2)) : { x: 0, y: 0 };
  const topMid = pieces ? toKonva(forwardPoint(pieces, iw / 2, ih)) : { x: 0, y: 0 };
  const trCorner = pieces ? toKonva(forwardPoint(pieces, iw, ih)) : { x: 0, y: 0 };
  // rotate handle: extend from center through topMid by a constant screen offset
  const rotDir = pieces ? (() => { const dx = topMid.x - center.x, dy = topMid.y - center.y; const len = Math.hypot(dx, dy) || 1; return { x: dx / len, y: dy / len }; })() : { x: 0, y: -1 };
  const rotHandle = { x: topMid.x + rotDir.x * hpx(28), y: topMid.y + rotDir.y * hpx(28) };

  const applyScaleFromCorner = (P: Pt) => {
    if (!pieces) return;
    const c = { x: pieces.c[0], y: pieces.c[1] };
    const local = invRot(P, c);
    const lx = local.x - (pieces.t[0] - c.x);
    const ly = local.y - (pieces.t[1] - c.y);
    const sX = iw ? lx / iw : 0, sY = ih ? ly / ih : 0;
    patchTransform({ scaleX: sx0sy0[0] ? sX / sx0sy0[0] : 1, scaleY: sx0sy0[1] ? sY / sx0sy0[1] : 1 });
  };
  const applyScaleAxis = (P: Pt, axis: "x" | "y") => {
    if (!pieces) return;
    const c = { x: pieces.c[0], y: pieces.c[1] };
    const local = invRot(P, c);
    if (axis === "x") { const lx = local.x - (pieces.t[0] - c.x); const sX = iw ? lx / iw : 0; patchTransform({ scaleX: sx0sy0[0] ? sX / sx0sy0[0] : 1 }); }
    else { const ly = local.y - (pieces.t[1] - c.y); const sY = ih ? ly / ih : 0; patchTransform({ scaleY: sx0sy0[1] ? sY / sx0sy0[1] : 1 }); }
  };
  const applyRotate = (P: Pt) => {
    if (!pieces) return;
    const c = { x: pieces.c[0], y: pieces.c[1] };
    const dx = P.x - c.x, dy = P.y - c.y;
    const len = Math.hypot(dx, dy) || 1;
    const d = { x: dx / len, y: dy / len };
    patchTransform({ rotation: (Math.atan2(-d.x, d.y) * 180) / Math.PI });
  };

  const HANDLE = "#2dd4bf";

  return (
    <div className="fixed inset-0 z-[100] bg-neutral-950 flex flex-col">
      <div className="h-14 bg-neutral-900 flex items-center justify-between px-4 border-b border-neutral-800">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-white mr-3">Composite</span>
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            Op
            <select value={data.mergeOp} onChange={(e) => sourceNodeId && updateNodeData(sourceNodeId, { mergeOp: e.target.value as CompMergeOp })} className="bg-neutral-800 text-white text-[11px] rounded px-1.5 py-1 outline-none border border-neutral-700">
              {COMP_OP_LABELS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </select>
          </label>
          <div className="w-px h-6 bg-neutral-700 mx-2" />
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer" title="Multiply the FG's RGB by its alpha before compositing">
            <input type="checkbox" checked={data.premultiplyFg ?? false} onChange={(e) => sourceNodeId && updateNodeData(sourceNodeId, { premultiplyFg: e.target.checked })} className="accent-teal-500" />
            Premultiply FG
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer ml-2" title="Multiply the BG's RGB by its alpha before compositing">
            <input type="checkbox" checked={data.premultiplyBg ?? false} onChange={(e) => sourceNodeId && updateNodeData(sourceNodeId, { premultiplyBg: e.target.checked })} className="accent-teal-500" />
            Premultiply BG
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer ml-2" title="Swap the BG and FG layers (and their alphas) in the merge">
            <input type="checkbox" checked={data.swapBgFg ?? false} onChange={(e) => sourceNodeId && updateNodeData(sourceNodeId, { swapBgFg: e.target.checked })} className="accent-teal-500" />
            Swap BG/FG
          </label>
          <div className="w-px h-6 bg-neutral-700 mx-2" />
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-400" title="Which input's resolution defines the output">
            Output res
            <select value={data.outputResolution ?? "bg"} onChange={(e) => sourceNodeId && updateNodeData(sourceNodeId, { outputResolution: e.target.value as "bg" | "fg" })} className="bg-neutral-800 text-white text-[11px] rounded px-1.5 py-1 outline-none border border-neutral-700">
              <option value="bg">BG</option>
              <option value="fg">FG</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-400 ml-2" title="Interpolation filter for the transformed inputs (Nuke-style). Impulse/Bilinear are fastest for realtime dragging.">
            Filter
            <select value={data.compFilter ?? "cubic"} onChange={(e) => sourceNodeId && updateNodeData(sourceNodeId, { compFilter: e.target.value as ResampleFilter })} className="bg-neutral-800 text-white text-[11px] rounded px-1.5 py-1 outline-none border border-neutral-700">
              {RESAMPLE_FILTER_LABELS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
            </select>
          </label>
          <div className="w-px h-6 bg-neutral-700 mx-2" />
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer" title="Show transparent pixels as a checkerboard instead of black">
            <input type="checkbox" checked={data.checkerboard ?? false} onChange={(e) => sourceNodeId && updateNodeData(sourceNodeId, { checkerboard: e.target.checked })} className="accent-teal-500" />
            Checkerboard
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={closeModal} className="px-4 py-1.5 text-xs font-medium text-neutral-400 hover:text-white">Cancel</button>
          <button onClick={handleDone} disabled={busy} className="px-4 py-1.5 text-xs font-medium bg-white text-neutral-900 rounded hover:bg-neutral-200 disabled:opacity-60">{busy ? "…" : "Done"}</button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div ref={containerRef} className="flex-1 overflow-hidden bg-neutral-900">
          {data.bgImage && offscreen ? (
            <Stage ref={stageRef} width={stageSize.width} height={stageSize.height} scaleX={scale} scaleY={scale} x={position.x} y={position.y} onWheel={handleWheel} onMouseMove={onStageMove} onMouseUp={endTranslate} onMouseLeave={endTranslate}>
              <Layer listening={false}>
                {/* transparency backdrop: solid black, or checkerboard if enabled */}
                {data.checkerboard && checkerTile
                  ? <Rect x={0} y={0} width={outW} height={outH} fillPatternImage={checkerTile as unknown as HTMLImageElement} fillPatternRepeat="repeat" />
                  : <Rect x={0} y={0} width={outW} height={outH} fill="#000" />}
                <KonvaImage ref={imageNodeRef} image={offscreen} width={outW} height={outH} />
              </Layer>
              <Layer>
                {showHandles && pieces && (
                  <>
                    {/* bounding box — press + drag the body to translate live
                        (stage-pointer tracked, so the composite updates in realtime) */}
                    <Line
                      points={corners.flatMap((p) => [p.x, p.y])}
                      closed stroke={HANDLE} strokeWidth={hpx(1.5)} dash={[hpx(5), hpx(4)]}
                      fill="rgba(45,212,191,0.06)" hitStrokeWidth={hpx(10)}
                      onMouseDown={(e) => { e.cancelBubble = true; if (activeTransform) translateRef.current = { startPL: stagePosBL(), startH: activeTransform.hPos, startV: activeTransform.vPos }; }}
                    />
                    {/* right-edge: scale X */}
                    <Circle x={rightMid.x} y={rightMid.y} radius={hpx(5)} fill="#fff" stroke={HANDLE} strokeWidth={hpx(1.5)} draggable onDragMove={(e) => applyScaleAxis(targetBL(e), "x")} onDragEnd={(e) => e.target.position({ x: rightMid.x, y: rightMid.y })} />
                    {/* top-edge: scale Y */}
                    <Circle x={topMid.x} y={topMid.y} radius={hpx(5)} fill="#fff" stroke={HANDLE} strokeWidth={hpx(1.5)} draggable onDragMove={(e) => applyScaleAxis(targetBL(e), "y")} onDragEnd={(e) => e.target.position({ x: topMid.x, y: topMid.y })} />
                    {/* TR corner: scale both */}
                    <Circle x={trCorner.x} y={trCorner.y} radius={hpx(5.5)} fill={HANDLE} stroke="#000" strokeWidth={hpx(1)} draggable onDragMove={(e) => applyScaleFromCorner(targetBL(e))} onDragEnd={(e) => e.target.position({ x: trCorner.x, y: trCorner.y })} />
                    {/* rotate handle */}
                    <Line points={[center.x, center.y, rotHandle.x, rotHandle.y]} stroke={HANDLE} strokeWidth={hpx(1)} listening={false} />
                    <Circle x={rotHandle.x} y={rotHandle.y} radius={hpx(5)} fill="#f59e0b" stroke="#000" strokeWidth={hpx(1)} draggable onDragMove={(e) => applyRotate(targetBL(e))} onDragEnd={(e) => e.target.position({ x: rotHandle.x, y: rotHandle.y })} />
                    {/* center / pivot handle */}
                    <Circle
                      x={center.x} y={center.y} radius={hpx(6)} fill="rgba(45,212,191,0.3)" stroke={HANDLE} strokeWidth={hpx(1.5)} draggable
                      onDragMove={(e) => { const P = targetBL(e); patchTransform({ centerAuto: false, centerX: P.x, centerY: P.y }); }}
                      onDblClick={(e) => { e.cancelBubble = true; patchTransform({ centerAuto: true }); }}
                    />
                  </>
                )}
              </Layer>
            </Stage>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-sm text-neutral-500">Connect a BG image to the node.</div>
          )}
        </div>

        <div className="w-72 shrink-0 bg-neutral-900 border-l border-neutral-800 flex flex-col overflow-y-auto">
          <div className="flex border-b border-neutral-800">
            {(["bg", "bgAlpha", "fg", "fgAlpha", "matte"] as CompActiveInput[]).map((t) => (
              <button key={t} onClick={() => setActiveInput(t)} className={`flex-1 py-2 text-[10px] font-medium ${activeInput === t ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"}`}>
                {t === "bg" ? "BG" : t === "bgAlpha" ? "BG α" : t === "fg" ? "FG" : t === "fgAlpha" ? "FG α" : "Matte"}
              </button>
            ))}
          </div>

          <div className="p-3 flex flex-col gap-2.5">
            {/* Black outside — BG & FG only */}
            {(activeInput === "bg" || activeInput === "fg") && (
              <label className="flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer" title="Transparent (on) vs. hold edge pixels (off) outside the transformed image">
                <input
                  type="checkbox"
                  checked={(activeInput === "bg" ? data.bgBlackOutside : data.fgBlackOutside) ?? true}
                  onChange={(e) => sourceNodeId && updateNodeData(sourceNodeId, activeInput === "bg" ? { bgBlackOutside: e.target.checked } : { fgBlackOutside: e.target.checked })}
                  className="accent-teal-500"
                />
                Black outside
              </label>
            )}

            <label className="flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer">
              <input type="checkbox" checked={activeTransform?.enabled ?? false} onChange={(e) => patchTransform({ enabled: e.target.checked })} className="accent-teal-500" />
              {followsLabel ? (activeTransform?.enabled ? "Transform independently" : `Follow ${followsLabel}`) : "Enable transform"}
            </label>
            {followsLabel && !activeTransform?.enabled && (
              <div className="text-[10px] text-neutral-500 leading-snug">Following the {followsLabel} transform. Enable to move it independently.</div>
            )}

            <div className={`flex flex-col gap-1.5 ${activeTransform?.enabled ? "" : "opacity-50 pointer-events-none"}`}>
              {NUM_FIELDS.map((f) => {
                const locked = !!activeTransform?.scaleLock;
                const yLocked = f.key === "scaleY" && locked;
                const val = activeTransform ? (yLocked ? activeTransform.scaleX : activeTransform[f.key]) : 0;
                return (
                  <div key={f.key} className="flex items-center gap-1.5">
                    <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">{f.label}</label>
                    <input type="number" step={f.step} disabled={yLocked} value={Number(val.toFixed(4))} onChange={(e) => patchTransform({ [f.key]: parseFloat(e.target.value) || 0 } as Partial<CompTransform>)} className={`nodrag flex-1 min-w-0 text-[10px] py-1 px-1.5 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700 ${yLocked ? "opacity-50" : ""}`} />
                  </div>
                );
              })}
              <label className="flex items-center gap-2 text-[10px] text-neutral-400 cursor-pointer">
                <input type="checkbox" checked={!!activeTransform?.scaleLock} onChange={(e) => patchTransform({ scaleLock: e.target.checked })} className="accent-teal-500" />
                Lock scale (Y follows X)
              </label>
              <div className="flex items-center gap-1.5 mt-1">
                <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">Center</label>
                <label className="flex items-center gap-1 text-[10px] text-neutral-400">
                  <input type="checkbox" checked={activeTransform?.centerAuto ?? true} onChange={(e) => patchTransform({ centerAuto: e.target.checked })} className="accent-teal-500" />
                  Auto (image center)
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

            {(activeInput === "bgAlpha" || activeInput === "fgAlpha" || activeInput === "matte") && (
              <div className="flex items-center gap-1.5 mt-1">
                <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">Reformat</label>
                <select
                  value={(activeInput === "bgAlpha" ? data.bgAlphaReformat : activeInput === "fgAlpha" ? data.fgAlphaReformat : data.matteReformat) ?? "none"}
                  onChange={(e) => {
                    if (!sourceNodeId) return;
                    const v = e.target.value as CompReformat;
                    updateNodeData(sourceNodeId, activeInput === "bgAlpha" ? { bgAlphaReformat: v } : activeInput === "fgAlpha" ? { fgAlphaReformat: v } : { matteReformat: v });
                  }}
                  className="nodrag flex-1 min-w-0 text-[10px] py-1 px-1.5 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700"
                >
                  {REFORMATS.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
                </select>
              </div>
            )}
            <div className="text-[10px] text-neutral-600 leading-snug mt-1">
              Drag the box to move · corner = scale both · edge dots = scale X/Y · amber = rotate · center dot = pivot (double-click = auto). (0,0) = bottom-left.
              {activeInput === "bgAlpha" ? " Reformat matches BG." : activeInput === "fgAlpha" ? " Reformat matches FG." : activeInput === "matte" ? " Reformat matches BG; matte limits the merge." : ""}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
