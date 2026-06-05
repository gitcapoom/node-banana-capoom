"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Shape as KonvaShape, Circle, Rect, Line } from "react-konva";
import Konva from "konva";
import { useRotoStore } from "@/store/rotoStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { rasterizeRoto } from "@/utils/rasterizeRoto";
import type { RotoShape, RotoPoint } from "@/types";

type Pt = { x: number; y: number };
const uid = () => `${Date.now().toString(36)}-${Math.floor(performance.now() % 1e6).toString(36)}`;
const mirror = (a: Pt, h: Pt): Pt => ({ x: 2 * a.x - h.x, y: 2 * a.y - h.y });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
    y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
  };
}
/** A fresh corner point: all handles coincide with the anchor (no curve). */
function newCorner(p: Pt): RotoPoint {
  return {
    id: uid(), anchor: { ...p }, inHandle: { ...p }, outHandle: { ...p },
    feather: { ...p }, featherIn: { ...p }, featherOut: { ...p }, broken: false, featherBroken: false,
  };
}
/** Compute smooth (symmetric) tangents for point i from its neighbours. */
function smoothTangents(pts: RotoPoint[], i: number, closed: boolean): { inH: Pt; outH: Pt } {
  const n = pts.length;
  const a = pts[i].anchor;
  const prev = closed ? pts[(i - 1 + n) % n].anchor : pts[Math.max(0, i - 1)].anchor;
  const next = closed ? pts[(i + 1) % n].anchor : pts[Math.min(n - 1, i + 1)].anchor;
  let dx = next.x - prev.x, dy = next.y - prev.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const handleLen = Math.min(dist(a, prev), dist(a, next)) / 3 || 30;
  return {
    inH: { x: a.x - dx * handleLen, y: a.y - dy * handleLen },
    outH: { x: a.x + dx * handleLen, y: a.y + dy * handleLen },
  };
}
/** Multiply every coordinate of every shape by s (for downscaled preview). */
function scaleShapes(shapes: RotoShape[], s: number): RotoShape[] {
  const sp = (p: Pt) => ({ x: p.x * s, y: p.y * s });
  return shapes.map((sh) => ({
    ...sh,
    points: sh.points.map((p) => ({
      ...p, anchor: sp(p.anchor), inHandle: sp(p.inHandle), outHandle: sp(p.outHandle),
      feather: sp(p.feather), featherIn: sp(p.featherIn), featherOut: sp(p.featherOut),
    })),
  }));
}

function drawShapePath(ctx: Konva.Context, shape: RotoShape) {
  const pts = shape.points;
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].anchor.x, pts[0].anchor.y);
  const segCount = shape.closed ? pts.length : pts.length - 1;
  for (let s = 0; s < segCount; s++) {
    const a = pts[s], b = pts[(s + 1) % pts.length];
    ctx.bezierCurveTo(a.outHandle.x, a.outHandle.y, b.inHandle.x, b.inHandle.y, b.anchor.x, b.anchor.y);
  }
  if (shape.closed) ctx.closePath();
}
function drawFeatherPath(ctx: Konva.Context, shape: RotoShape) {
  const pts = shape.points;
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].feather.x, pts[0].feather.y);
  const segCount = shape.closed ? pts.length : pts.length - 1;
  for (let s = 0; s < segCount; s++) {
    const a = pts[s], b = pts[(s + 1) % pts.length];
    ctx.bezierCurveTo(a.featherOut.x, a.featherOut.y, b.featherIn.x, b.featherIn.y, b.feather.x, b.feather.y);
  }
  if (shape.closed) ctx.closePath();
}

export function RotoModal() {
  const {
    isModalOpen, sourceNodeId, sourceImage, shapes, selectedShapeId, selectedPointId,
    currentTool, closeModal, addShape, replaceShape, updateShape, deleteShape, moveShape,
    setTool, setSelectedShape, setSelectedPoint, undo, redo,
  } = useRotoStore();
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const nodes = useWorkflowStore((s) => s.nodes);

  const stageRef = useRef<Konva.Stage>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [editMode, setEditMode] = useState<"points" | "feather">("points");
  const [mattePreview, setMattePreview] = useState(false);
  const [matteImg, setMatteImg] = useState<HTMLImageElement | null>(null);

  const [work, setWork] = useState<RotoShape[]>(shapes);
  useEffect(() => { setWork(shapes); }, [shapes]);
  const workRef = useRef(work);
  useEffect(() => { workRef.current = work; }, [work]);

  const [draft, setDraft] = useState<RotoShape | null>(null);
  const penDownRef = useRef(false);

  const invert = sourceNodeId
    ? ((nodes.find((n) => n.id === sourceNodeId)?.data as { invert?: boolean })?.invert ?? false)
    : false;

  useEffect(() => {
    if (!sourceImage) return;
    const img = new window.Image();
    img.onload = () => {
      setImage(img);
      if (containerRef.current) {
        const cw = containerRef.current.clientWidth - 100;
        const ch = containerRef.current.clientHeight - 100;
        const newScale = Math.min(cw / img.width, ch / img.height, 1);
        setScale(newScale);
        setStageSize({ width: img.width, height: img.height });
        setPosition({ x: (cw - img.width * newScale) / 2 + 50, y: (ch - img.height * newScale) / 2 + 50 });
      }
    };
    img.src = sourceImage;
  }, [sourceImage]);

  // Live matte preview (downscaled + rAF-coalesced).
  useEffect(() => {
    if (!mattePreview || !image) { setMatteImg(null); return; }
    const raf = requestAnimationFrame(() => {
      const maxDim = 1024;
      const sc = Math.min(1, maxDim / Math.max(image.width, image.height));
      const w = Math.max(1, Math.round(image.width * sc));
      const h = Math.max(1, Math.round(image.height * sc));
      const url = rasterizeRoto(scaleShapes(work, sc), w, h, { invert });
      const mi = new window.Image();
      mi.onload = () => setMatteImg(mi);
      mi.src = url;
    });
    return () => cancelAnimationFrame(raf);
  }, [work, invert, mattePreview, image]);

  const getPos = useCallback((): Pt => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const t = stage.getAbsoluteTransform().copy().invert();
    const pos = stage.getPointerPosition();
    if (!pos) return { x: 0, y: 0 };
    return t.point(pos);
  }, []);

  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const by = 1.1;
    setScale((s) => Math.min(Math.max(e.evt.deltaY > 0 ? s / by : s * by, 0.1), 8));
  }, []);

  const selShape = work.find((s) => s.id === selectedShapeId) || null;

  const editPoint = useCallback((shapeId: string, pointId: string, fn: (p: RotoPoint) => RotoPoint) => {
    setWork((ws) => ws.map((s) => (s.id !== shapeId ? s : { ...s, points: s.points.map((p) => (p.id === pointId ? fn(p) : p)) })));
  }, []);
  const commitShape = useCallback((shapeId: string) => {
    const s = workRef.current.find((x) => x.id === shapeId);
    if (s) replaceShape(shapeId, s);
  }, [replaceShape]);

  // Double-click an anchor → smooth (auto tangents, unbroken); Alt → corner.
  const toggleSmooth = useCallback((shapeId: string, pointId: string, toCorner: boolean) => {
    const s = workRef.current.find((x) => x.id === shapeId);
    if (!s) return;
    const i = s.points.findIndex((p) => p.id === pointId);
    if (i < 0) return;
    const p = s.points[i];
    let next: RotoPoint;
    if (toCorner) {
      next = { ...p, inHandle: { ...p.anchor }, outHandle: { ...p.anchor }, broken: false };
    } else {
      const { inH, outH } = smoothTangents(s.points, i, s.closed);
      next = { ...p, inHandle: inH, outHandle: outH, broken: false };
    }
    replaceShape(shapeId, { ...s, points: s.points.map((q) => (q.id === pointId ? next : q)) });
  }, [replaceShape]);
  const toggleFeatherSmooth = useCallback((shapeId: string, pointId: string, toCorner: boolean) => {
    const s = workRef.current.find((x) => x.id === shapeId);
    if (!s) return;
    const i = s.points.findIndex((p) => p.id === pointId);
    if (i < 0) return;
    const p = s.points[i];
    let next: RotoPoint;
    if (toCorner) {
      next = { ...p, featherIn: { ...p.feather }, featherOut: { ...p.feather }, featherBroken: false };
    } else {
      // Symmetric feather tangents from the feather neighbours.
      const fpts = s.points.map((q) => ({ ...q, anchor: q.feather }));
      const { inH, outH } = smoothTangents(fpts, i, s.closed);
      next = { ...p, featherIn: inH, featherOut: outH, featherBroken: false };
    }
    replaceShape(shapeId, { ...s, points: s.points.map((q) => (q.id === pointId ? next : q)) });
  }, [replaceShape]);

  // ─── Pen ─────────────────────────────────────────────────────────
  const onStageMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.target !== e.target.getStage() && e.target.name() !== "imagebg" && e.target.name() !== "fill") return;
    const pos = getPos();
    if (currentTool === "pen") {
      if (!draft) { setDraft({ id: uid(), points: [newCorner(pos)], closed: false, op: "union", opacity: 1 }); penDownRef.current = true; return; }
      if (draft.points.length >= 2 && dist(pos, draft.points[0].anchor) * scale < 10) {
        addShape({ ...draft, closed: true }); setDraft(null); return;
      }
      setDraft({ ...draft, points: [...draft.points, newCorner(pos)] }); penDownRef.current = true; return;
    }
    if (currentTool === "select") {
      if (e.target.name() === "fill") { setSelectedShape(e.target.attrs.shapeId); return; }
      if (selShape) tryInsertPoint(pos);
    }
  }, [currentTool, draft, getPos, scale, addShape, selShape, setSelectedShape]);

  const onStageMouseMove = useCallback(() => {
    if (currentTool === "pen" && draft && penDownRef.current) {
      const pos = getPos();
      setDraft((d) => {
        if (!d) return d;
        const pts = [...d.points];
        const i = pts.length - 1;
        const a = pts[i].anchor;
        const inH = mirror(a, pos);
        pts[i] = { ...pts[i], outHandle: { ...pos }, inHandle: inH, feather: { ...a }, featherIn: { ...inH }, featherOut: { ...pos } };
        return { ...d, points: pts };
      });
    }
  }, [currentTool, draft, getPos]);
  const onStageMouseUp = useCallback(() => { penDownRef.current = false; }, []);

  const tryInsertPoint = useCallback((click: Pt) => {
    if (!selShape) return;
    const pts = selShape.points;
    const segCount = selShape.closed ? pts.length : pts.length - 1;
    let best = { d: Infinity, seg: -1, t: 0 };
    for (let s = 0; s < segCount; s++) {
      const a = pts[s], b = pts[(s + 1) % pts.length];
      for (let k = 1; k < 20; k++) {
        const t = k / 20;
        const p = cubicAt(a.anchor, a.outHandle, b.inHandle, b.anchor, t);
        const d = dist(p, click);
        if (d < best.d) best = { d, seg: s, t };
      }
    }
    if (best.seg < 0 || best.d * scale > 8) return;
    const a = pts[best.seg], b = pts[(best.seg + 1) % pts.length];
    const t = best.t;
    const split = (P0: Pt, P1: Pt, P2: Pt, P3: Pt) => {
      const P01 = lerp(P0, P1, t), P12 = lerp(P1, P2, t), P23 = lerp(P2, P3, t);
      const P012 = lerp(P01, P12, t), P123 = lerp(P12, P23, t);
      return { mid: lerp(P012, P123, t), aOut: P01, bIn: P23, midIn: P012, midOut: P123 };
    };
    const m = split(a.anchor, a.outHandle, b.inHandle, b.anchor);
    const fm = split(a.feather, a.featherOut, b.featherIn, b.feather);
    const newPts = [...pts];
    newPts[best.seg] = { ...a, outHandle: m.aOut, featherOut: fm.aOut };
    newPts[(best.seg + 1) % pts.length] = { ...b, inHandle: m.bIn, featherIn: fm.bIn };
    const inserted: RotoPoint = {
      id: uid(), anchor: m.mid, inHandle: m.midIn, outHandle: m.midOut,
      feather: fm.mid, featherIn: fm.midIn, featherOut: fm.midOut, broken: false, featherBroken: false,
    };
    newPts.splice(best.seg + 1, 0, inserted);
    replaceShape(selShape.id, { ...selShape, points: newPts });
    setSelectedPoint(inserted.id);
  }, [selShape, scale, replaceShape, setSelectedPoint]);

  // ─── Keyboard ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModalOpen) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") { if (draft) setDraft(null); else closeModal(); }
      if (e.key === "Enter" && draft && draft.points.length >= 2) { addShape({ ...draft, closed: true }); setDraft(null); }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if (e.key === "p" || e.key === "P") setTool("pen");
      if (e.key === "v" || e.key === "V") setTool("select");
      if ((e.key === "Delete" || e.key === "Backspace") && currentTool === "select" && selShape) {
        if (selectedPointId && selShape.points.length > 2) {
          replaceShape(selShape.id, { ...selShape, points: selShape.points.filter((p) => p.id !== selectedPointId) });
          setSelectedPoint(null);
        } else { deleteShape(selShape.id); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isModalOpen, draft, currentTool, selShape, selectedPointId, closeModal, addShape, setTool, undo, redo, replaceShape, deleteShape, setSelectedPoint]);

  const handleDone = useCallback(() => {
    if (!sourceNodeId || !image) return;
    const outputMask = rasterizeRoto(work, image.width, image.height, { invert });
    updateNodeData(sourceNodeId, { shapes: work, outputMask, imageWidth: image.width, imageHeight: image.height });
    closeModal();
  }, [sourceNodeId, image, work, invert, updateNodeData, closeModal]);

  if (!isModalOpen) return null;
  const hpx = (v: number) => v / scale;

  return (
    <div className="fixed inset-0 z-[100] bg-neutral-950 flex flex-col">
      {/* Top bar */}
      <div className="h-14 bg-neutral-900 flex items-center justify-between px-4 border-b border-neutral-800">
        <div className="flex items-center gap-1.5">
          {(["pen", "select"] as const).map((t) => (
            <button key={t} onClick={() => setTool(t)} className={`px-3.5 py-1.5 text-xs font-medium rounded ${currentTool === t ? "bg-white text-neutral-900" : "text-neutral-400 hover:text-white"}`}>
              {t === "pen" ? "Pen" : "Select"}
            </button>
          ))}
          {currentTool === "select" && (
            <>
              <div className="w-px h-6 bg-neutral-700 mx-2" />
              {(["points", "feather"] as const).map((m) => (
                <button key={m} onClick={() => setEditMode(m)} className={`px-3 py-1.5 text-xs rounded ${editMode === m ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`}>
                  {m === "points" ? "Points" : "Feather"}
                </button>
              ))}
            </>
          )}
          <div className="w-px h-6 bg-neutral-700 mx-2" />
          <button
            onClick={() => setMattePreview((v) => !v)}
            className={`px-3 py-1.5 text-xs rounded ${mattePreview ? "bg-white text-neutral-900" : "text-neutral-400 hover:text-white"}`}
            title="Preview the black & white matte"
          >
            Matte
          </button>
          <div className="w-px h-6 bg-neutral-700 mx-2" />
          <button onClick={undo} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white">Undo</button>
          <button onClick={redo} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white">Redo</button>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer">
            <input type="checkbox" checked={invert} onChange={(e) => sourceNodeId && updateNodeData(sourceNodeId, { invert: e.target.checked })} className="accent-white" />
            Invert
          </label>
          <button onClick={closeModal} className="px-4 py-1.5 text-xs font-medium text-neutral-400 hover:text-white">Cancel</button>
          <button onClick={handleDone} className="px-4 py-1.5 text-xs font-medium bg-white text-neutral-900 rounded hover:bg-neutral-200">Done</button>
        </div>
      </div>

      {/* Canvas + layer panel */}
      <div className="flex-1 flex min-h-0">
        <div ref={containerRef} className="flex-1 overflow-hidden bg-neutral-900">
          <Stage
            ref={stageRef}
            width={containerRef.current?.clientWidth || 800}
            height={containerRef.current?.clientHeight || 600}
            scaleX={scale} scaleY={scale} x={position.x} y={position.y}
            onMouseDown={onStageMouseDown} onMouseMove={onStageMouseMove} onMouseUp={onStageMouseUp} onWheel={handleWheel}
            style={{ cursor: currentTool === "pen" ? "crosshair" : "default" }}
          >
            <Layer listening>
              {mattePreview && matteImg
                ? <KonvaImage name="imagebg" image={matteImg} width={stageSize.width} height={stageSize.height} />
                : image && <KonvaImage name="imagebg" image={image} width={stageSize.width} height={stageSize.height} />}
            </Layer>

            {/* translucent fills (hidden in matte preview) */}
            {!mattePreview && (
              <Layer listening={currentTool === "select"}>
                {work.map((shape) => (
                  <KonvaShape
                    key={shape.id} name="fill" shapeId={shape.id}
                    sceneFunc={(ctx, s) => { drawShapePath(ctx, shape); ctx.fillStrokeShape(s); }}
                    fill={shape.op === "subtract" ? "rgba(239,68,68,0.22)" : "rgba(56,189,248,0.18)"}
                    listening={currentTool === "select"}
                  />
                ))}
                {draft && <KonvaShape listening={false} sceneFunc={(ctx, s) => { drawShapePath(ctx, draft); ctx.fillStrokeShape(s); }} fill="rgba(56,189,248,0.15)" />}
              </Layer>
            )}

            {/* selected shape outline + handles */}
            <Layer>
              {selShape && (
                <>
                  <KonvaShape listening={false} sceneFunc={(ctx, s) => { drawShapePath(ctx, selShape); ctx.strokeShape(s); }} stroke="#0ea5e9" strokeWidth={hpx(1.5)} />
                  {editMode === "feather" && (
                    <KonvaShape listening={false} sceneFunc={(ctx, s) => { drawFeatherPath(ctx, selShape); ctx.strokeShape(s); }} stroke="#f59e0b" strokeWidth={hpx(1)} dash={[hpx(4), hpx(4)]} />
                  )}

                  {selShape.points.map((p) => {
                    if (editMode === "feather") {
                      return (
                        <Fragment key={p.id}>
                          <Line points={[p.feather.x, p.feather.y, p.featherIn.x, p.featherIn.y]} stroke="#b45309" strokeWidth={hpx(0.75)} listening={false} />
                          <Line points={[p.feather.x, p.feather.y, p.featherOut.x, p.featherOut.y]} stroke="#b45309" strokeWidth={hpx(0.75)} listening={false} />
                          <Rect x={p.featherIn.x - hpx(3)} y={p.featherIn.y - hpx(3)} width={hpx(6)} height={hpx(6)} fill="#fbbf24" draggable
                            onMouseDown={(e) => { e.cancelBubble = true; setSelectedPoint(p.id); }}
                            onDragMove={(e) => { const np = { x: e.target.x() + hpx(3), y: e.target.y() + hpx(3) }; const broken = p.featherBroken || e.evt.altKey || e.evt.ctrlKey; editPoint(selShape.id, p.id, (pp) => ({ ...pp, featherIn: np, featherBroken: broken, featherOut: broken ? pp.featherOut : mirror(pp.feather, np) })); }}
                            onDragEnd={() => commitShape(selShape.id)} />
                          <Rect x={p.featherOut.x - hpx(3)} y={p.featherOut.y - hpx(3)} width={hpx(6)} height={hpx(6)} fill="#fbbf24" draggable
                            onMouseDown={(e) => { e.cancelBubble = true; setSelectedPoint(p.id); }}
                            onDragMove={(e) => { const np = { x: e.target.x() + hpx(3), y: e.target.y() + hpx(3) }; const broken = p.featherBroken || e.evt.altKey || e.evt.ctrlKey; editPoint(selShape.id, p.id, (pp) => ({ ...pp, featherOut: np, featherBroken: broken, featherIn: broken ? pp.featherIn : mirror(pp.feather, np) })); }}
                            onDragEnd={() => commitShape(selShape.id)} />
                          <Circle x={p.feather.x} y={p.feather.y} radius={hpx(5)} fill="#f59e0b" stroke="#000" strokeWidth={hpx(0.5)} draggable
                            onMouseDown={(e) => { e.cancelBubble = true; setSelectedPoint(p.id); }}
                            onDblClick={(e) => { e.cancelBubble = true; toggleFeatherSmooth(selShape.id, p.id, e.evt.altKey); }}
                            onDragMove={(e) => { const nf = { x: e.target.x(), y: e.target.y() }; editPoint(selShape.id, p.id, (pp) => { const dx = nf.x - pp.feather.x, dy = nf.y - pp.feather.y; return { ...pp, feather: nf, featherIn: { x: pp.featherIn.x + dx, y: pp.featherIn.y + dy }, featherOut: { x: pp.featherOut.x + dx, y: pp.featherOut.y + dy } }; }); }}
                            onDragEnd={() => commitShape(selShape.id)} />
                        </Fragment>
                      );
                    }
                    const isSel = p.id === selectedPointId;
                    return (
                      <Fragment key={p.id}>
                        <Line points={[p.anchor.x, p.anchor.y, p.inHandle.x, p.inHandle.y]} stroke="#64748b" strokeWidth={hpx(0.75)} listening={false} />
                        <Line points={[p.anchor.x, p.anchor.y, p.outHandle.x, p.outHandle.y]} stroke="#64748b" strokeWidth={hpx(0.75)} listening={false} />
                        <Rect x={p.inHandle.x - hpx(3)} y={p.inHandle.y - hpx(3)} width={hpx(6)} height={hpx(6)} fill="#94a3b8" draggable
                          onMouseDown={(e) => { e.cancelBubble = true; setSelectedPoint(p.id); }}
                          onDragMove={(e) => { const np = { x: e.target.x() + hpx(3), y: e.target.y() + hpx(3) }; const broken = p.broken || e.evt.altKey || e.evt.ctrlKey; editPoint(selShape.id, p.id, (pp) => ({ ...pp, inHandle: np, broken, outHandle: broken ? pp.outHandle : mirror(pp.anchor, np) })); }}
                          onDragEnd={() => commitShape(selShape.id)} />
                        <Rect x={p.outHandle.x - hpx(3)} y={p.outHandle.y - hpx(3)} width={hpx(6)} height={hpx(6)} fill="#94a3b8" draggable
                          onMouseDown={(e) => { e.cancelBubble = true; setSelectedPoint(p.id); }}
                          onDragMove={(e) => { const np = { x: e.target.x() + hpx(3), y: e.target.y() + hpx(3) }; const broken = p.broken || e.evt.altKey || e.evt.ctrlKey; editPoint(selShape.id, p.id, (pp) => ({ ...pp, outHandle: np, broken, inHandle: broken ? pp.inHandle : mirror(pp.anchor, np) })); }}
                          onDragEnd={() => commitShape(selShape.id)} />
                        <Circle x={p.anchor.x} y={p.anchor.y} radius={hpx(5)} fill={isSel ? "#0ea5e9" : "#ffffff"} stroke="#0369a1" strokeWidth={hpx(1)} draggable
                          onMouseDown={(e) => { e.cancelBubble = true; setSelectedPoint(p.id); }}
                          onDblClick={(e) => { e.cancelBubble = true; toggleSmooth(selShape.id, p.id, e.evt.altKey); }}
                          onDragMove={(e) => { const na = { x: e.target.x(), y: e.target.y() }; editPoint(selShape.id, p.id, (pp) => { const dx = na.x - pp.anchor.x, dy = na.y - pp.anchor.y; const tr = (q: Pt) => ({ x: q.x + dx, y: q.y + dy }); return { ...pp, anchor: na, inHandle: tr(pp.inHandle), outHandle: tr(pp.outHandle), feather: tr(pp.feather), featherIn: tr(pp.featherIn), featherOut: tr(pp.featherOut) }; }); }}
                          onDragEnd={() => commitShape(selShape.id)} />
                      </Fragment>
                    );
                  })}
                </>
              )}
              {draft?.points.map((p, i) => (
                <Circle key={p.id} x={p.anchor.x} y={p.anchor.y} radius={hpx(4)} fill={i === 0 ? "#22c55e" : "#ffffff"} stroke="#000" strokeWidth={hpx(0.5)} listening={false} />
              ))}
            </Layer>
          </Stage>
        </div>

        {/* Layer panel */}
        <div className="w-60 shrink-0 bg-neutral-900 border-l border-neutral-800 flex flex-col">
          <div className="h-10 px-3 flex items-center justify-between border-b border-neutral-800">
            <span className="text-[11px] text-neutral-400 uppercase tracking-wide">Layers</span>
            <button onClick={() => { setTool("pen"); setDraft(null); }} className="text-[11px] px-2 py-0.5 rounded bg-neutral-800 text-sky-400 hover:bg-neutral-700" title="Draw a new shape">＋ New</button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {work.length === 0 && <div className="text-[11px] text-neutral-600 px-1 py-2">No shapes. Pick Pen and draw, or ＋ New.</div>}
            {work.map((s, i) => {
              const sel = s.id === selectedShapeId;
              return (
                <div key={s.id} className={`rounded border p-1.5 ${sel ? "border-sky-600 bg-sky-950/40" : "border-neutral-800 bg-neutral-800/40 hover:bg-neutral-800/70"}`}>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setSelectedShape(s.id)} className="flex-1 text-left text-[11px] text-neutral-200 truncate">Shape {i + 1}</button>
                    <button onClick={() => moveShape(s.id, -1)} disabled={i === 0} className="w-5 h-5 text-[10px] text-neutral-400 hover:text-white disabled:opacity-30">▲</button>
                    <button onClick={() => moveShape(s.id, 1)} disabled={i === work.length - 1} className="w-5 h-5 text-[10px] text-neutral-400 hover:text-white disabled:opacity-30">▼</button>
                    <button onClick={() => deleteShape(s.id)} className="w-5 h-5 text-[10px] text-neutral-500 hover:text-red-400">✕</button>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    {(["union", "subtract"] as const).map((op) => (
                      <button key={op} onClick={() => updateShape(s.id, { op })} className={`px-1.5 py-0.5 text-[10px] rounded ${s.op === op ? (op === "subtract" ? "bg-red-600 text-white" : "bg-sky-600 text-white") : "bg-neutral-800 text-neutral-400 hover:text-white"}`}>
                        {op === "union" ? "Union" : "Subtract"}
                      </button>
                    ))}
                    <input type="range" min={0} max={1} step={0.01} value={s.opacity} onChange={(e) => updateShape(s.id, { opacity: parseFloat(e.target.value) })} className="flex-1 accent-white" title="Opacity" />
                  </div>
                </div>
              );
            })}
          </div>
          {currentTool === "pen" && (
            <div className="px-3 py-2 border-t border-neutral-800 text-[10px] text-sky-400/80 leading-snug">
              Pen: click to add points · drag for curves · click the green start point to close · keep drawing for more shapes.
            </div>
          )}
          {currentTool === "select" && selShape && (
            <div className="px-3 py-2 border-t border-neutral-800 text-[10px] text-neutral-500 leading-snug">
              Drag points/handles. Double-click a point to add/smooth tangents (Alt+double-click = corner). {editMode === "feather" ? "Drag the amber feather points + handles." : "Switch to Feather to edit softness."} Del removes a point.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
