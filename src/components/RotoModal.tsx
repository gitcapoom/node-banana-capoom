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
function newCorner(p: Pt): RotoPoint {
  return { id: uid(), anchor: { ...p }, inHandle: { ...p }, outHandle: { ...p }, feather: { ...p }, broken: false };
}

/** Draw a shape's main Bezier into a Konva scene context. */
function drawShapePath(ctx: Konva.Context, shape: RotoShape) {
  const pts = shape.points;
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].anchor.x, pts[0].anchor.y);
  const segCount = shape.closed ? pts.length : pts.length - 1;
  for (let s = 0; s < segCount; s++) {
    const a = pts[s];
    const b = pts[(s + 1) % pts.length];
    ctx.bezierCurveTo(a.outHandle.x, a.outHandle.y, b.inHandle.x, b.inHandle.y, b.anchor.x, b.anchor.y);
  }
  if (shape.closed) ctx.closePath();
}

export function RotoModal() {
  const {
    isModalOpen, sourceNodeId, sourceImage, shapes, selectedShapeId, selectedPointId,
    currentTool, closeModal, addShape, replaceShape, updateShape, deleteShape, clear,
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

  // Local working copy (live edits), synced from store on open/undo/commit.
  const [work, setWork] = useState<RotoShape[]>(shapes);
  useEffect(() => { setWork(shapes); }, [shapes]);
  const workRef = useRef(work);
  useEffect(() => { workRef.current = work; }, [work]);

  // Pen draft (in-progress shape) + drag tracking.
  const [draft, setDraft] = useState<RotoShape | null>(null);
  const penDownRef = useRef(false);

  const invert = sourceNodeId
    ? ((nodes.find((n) => n.id === sourceNodeId)?.data as { invert?: boolean })?.invert ?? false)
    : false;

  // Load source image + zoom-to-fit (reused from MaskPainterModal).
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

  const getPos = useCallback((): Pt => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const transform = stage.getAbsoluteTransform().copy().invert();
    const pos = stage.getPointerPosition();
    if (!pos) return { x: 0, y: 0 };
    return transform.point(pos);
  }, []);

  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const by = 1.1;
    setScale((s) => Math.min(Math.max(e.evt.deltaY > 0 ? s / by : s * by, 0.1), 8));
  }, []);

  const selShape = work.find((s) => s.id === selectedShapeId) || null;

  // ─── Live point editing (mutate `work`, commit on drag-end) ──────
  const editPoint = useCallback((shapeId: string, pointId: string, fn: (p: RotoPoint) => RotoPoint) => {
    setWork((ws) => ws.map((s) => (s.id !== shapeId ? s : { ...s, points: s.points.map((p) => (p.id === pointId ? fn(p) : p)) })));
  }, []);
  const commitShape = useCallback((shapeId: string) => {
    const s = workRef.current.find((x) => x.id === shapeId);
    if (s) replaceShape(shapeId, s);
  }, [replaceShape]);

  // ─── Pen tool ────────────────────────────────────────────────────
  const onStageMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    // Ignore clicks that hit a draggable handle (they set cancelBubble).
    if (e.target !== e.target.getStage() && e.target.name() !== "imagebg" && e.target.name() !== "fill") return;
    const pos = getPos();

    if (currentTool === "pen") {
      if (!draft) {
        setDraft({ id: uid(), points: [newCorner(pos)], closed: false, op: "union", opacity: 1 });
        penDownRef.current = true;
        return;
      }
      // Close if near the first anchor. Stay in Pen mode so the next click
      // starts another shape (draw multiple shapes back-to-back).
      if (draft.points.length >= 2 && dist(pos, draft.points[0].anchor) * scale < 10) {
        addShape({ ...draft, closed: true });
        setDraft(null);
        return;
      }
      setDraft({ ...draft, points: [...draft.points, newCorner(pos)] });
      penDownRef.current = true;
      return;
    }

    // Select tool: insert a point on the selected shape's outline, else select a shape under the click.
    if (currentTool === "select") {
      if (e.target.name() === "fill") {
        setSelectedShape(e.target.attrs.shapeId);
        return;
      }
      if (selShape) tryInsertPoint(pos);
    }
  }, [currentTool, draft, getPos, scale, addShape, setTool, selShape, setSelectedShape]);

  const onStageMouseMove = useCallback(() => {
    if (currentTool === "pen" && draft && penDownRef.current) {
      const pos = getPos();
      setDraft((d) => {
        if (!d) return d;
        const pts = [...d.points];
        const i = pts.length - 1;
        const a = pts[i].anchor;
        pts[i] = { ...pts[i], outHandle: { ...pos }, inHandle: mirror(a, pos), feather: { ...a } };
        return { ...d, points: pts };
      });
    }
  }, [currentTool, draft, getPos]);

  const onStageMouseUp = useCallback(() => { penDownRef.current = false; }, []);

  // De Casteljau insert on nearest segment of the selected shape.
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
    const P0 = a.anchor, P1 = a.outHandle, P2 = b.inHandle, P3 = b.anchor;
    const P01 = lerp(P0, P1, t), P12 = lerp(P1, P2, t), P23 = lerp(P2, P3, t);
    const P012 = lerp(P01, P12, t), P123 = lerp(P12, P23, t);
    const Pnew = lerp(P012, P123, t);
    const newPts = [...pts];
    newPts[best.seg] = { ...a, outHandle: P01 };
    newPts[(best.seg + 1) % pts.length] = { ...b, inHandle: P23 };
    const inserted: RotoPoint = { id: uid(), anchor: Pnew, inHandle: P012, outHandle: P123, feather: { ...Pnew }, broken: false };
    newPts.splice(best.seg + 1, 0, inserted);
    replaceShape(selShape.id, { ...selShape, points: newPts });
    setSelectedPoint(inserted.id);
  }, [selShape, scale, replaceShape, setSelectedPoint]);

  // ─── Keyboard ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModalOpen) return;
      if (e.key === "Escape") { if (draft) setDraft(null); else closeModal(); }
      if (e.key === "Enter" && draft && draft.points.length >= 2) { addShape({ ...draft, closed: true }); setDraft(null); }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if (e.key === "p" || e.key === "P") setTool("pen");
      if (e.key === "v" || e.key === "V") setTool("select");
      if ((e.key === "Delete" || e.key === "Backspace") && currentTool === "select" && selShape) {
        if (selectedPointId && selShape.points.length > 2) {
          const newPts = selShape.points.filter((p) => p.id !== selectedPointId);
          replaceShape(selShape.id, { ...selShape, points: newPts });
          setSelectedPoint(null);
        } else {
          deleteShape(selShape.id);
        }
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

  const hpx = (v: number) => v / scale; // constant-screen-size helper

  return (
    <div className="fixed inset-0 z-[100] bg-neutral-950 flex flex-col">
      {/* Top bar */}
      <div className="h-14 bg-neutral-900 flex items-center justify-between px-4 border-b border-neutral-800">
        <div className="flex items-center gap-1.5">
          {(["pen", "select"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTool(t)}
              className={`px-3.5 py-1.5 text-xs font-medium rounded ${currentTool === t ? "bg-white text-neutral-900" : "text-neutral-400 hover:text-white"}`}
            >
              {t === "pen" ? "Pen" : "Select"}
            </button>
          ))}
          {currentTool === "select" && (
            <>
              <div className="w-px h-6 bg-neutral-700 mx-2" />
              {(["points", "feather"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setEditMode(m)}
                  className={`px-3 py-1.5 text-xs rounded ${editMode === m ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`}
                >
                  {m === "points" ? "Points" : "Feather"}
                </button>
              ))}
            </>
          )}
          <div className="w-px h-6 bg-neutral-700 mx-2" />
          <button onClick={undo} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white">Undo</button>
          <button onClick={redo} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white">Redo</button>
          <button onClick={clear} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-red-400">Clear</button>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={closeModal} className="px-4 py-1.5 text-xs font-medium text-neutral-400 hover:text-white">Cancel</button>
          <button onClick={handleDone} className="px-4 py-1.5 text-xs font-medium bg-white text-neutral-900 rounded hover:bg-neutral-200">Done</button>
        </div>
      </div>

      {/* Canvas */}
      <div ref={containerRef} className="flex-1 overflow-hidden bg-neutral-900">
        <Stage
          ref={stageRef}
          width={containerRef.current?.clientWidth || 800}
          height={containerRef.current?.clientHeight || 600}
          scaleX={scale}
          scaleY={scale}
          x={position.x}
          y={position.y}
          onMouseDown={onStageMouseDown}
          onMouseMove={onStageMouseMove}
          onMouseUp={onStageMouseUp}
          onWheel={handleWheel}
          style={{ cursor: currentTool === "pen" ? "crosshair" : "default" }}
        >
          {/* Image */}
          <Layer listening>
            {image && <KonvaImage name="imagebg" image={image} width={stageSize.width} height={stageSize.height} />}
          </Layer>

          {/* Shape fills */}
          <Layer listening={currentTool === "select"}>
            {work.map((shape) => (
              <KonvaShape
                key={shape.id}
                name="fill"
                shapeId={shape.id}
                sceneFunc={(ctx, s) => { drawShapePath(ctx, shape); ctx.fillStrokeShape(s); }}
                fill={shape.op === "subtract" ? "rgba(239,68,68,0.25)" : "rgba(56,189,248,0.22)"}
                listening={currentTool === "select"}
              />
            ))}
            {draft && (
              <KonvaShape
                listening={false}
                sceneFunc={(ctx, s) => { drawShapePath(ctx, draft); ctx.fillStrokeShape(s); }}
                fill="rgba(56,189,248,0.15)"
              />
            )}
          </Layer>

          {/* Selected shape outline + handles, and draft anchors */}
          <Layer>
            {selShape && (
              <>
                <KonvaShape
                  listening={false}
                  sceneFunc={(ctx, s) => { drawShapePath(ctx, selShape); ctx.strokeShape(s); }}
                  stroke="#0ea5e9"
                  strokeWidth={hpx(1.5)}
                />
                {/* Feather outline (dashed) when any point has feather */}
                {editMode === "feather" && (
                  <KonvaShape
                    listening={false}
                    sceneFunc={(ctx, s) => {
                      const pts = selShape.points;
                      if (pts.length < 2) return;
                      const off = (p: RotoPoint): Pt => ({ x: p.feather.x - p.anchor.x, y: p.feather.y - p.anchor.y });
                      ctx.beginPath();
                      ctx.moveTo(pts[0].feather.x, pts[0].feather.y);
                      const segCount = selShape.closed ? pts.length : pts.length - 1;
                      for (let i = 0; i < segCount; i++) {
                        const a = pts[i], b = pts[(i + 1) % pts.length];
                        const oa = off(a), ob = off(b);
                        ctx.bezierCurveTo(a.outHandle.x + oa.x, a.outHandle.y + oa.y, b.inHandle.x + ob.x, b.inHandle.y + ob.y, b.feather.x, b.feather.y);
                      }
                      if (selShape.closed) ctx.closePath();
                      ctx.strokeShape(s);
                    }}
                    stroke="#f59e0b"
                    strokeWidth={hpx(1)}
                    dash={[hpx(4), hpx(4)]}
                  />
                )}

                {selShape.points.map((p) => {
                  const isSel = p.id === selectedPointId;
                  if (editMode === "feather") {
                    return (
                      <Circle
                        key={p.id}
                        x={p.feather.x}
                        y={p.feather.y}
                        radius={hpx(5)}
                        fill="#f59e0b"
                        stroke="#000"
                        strokeWidth={hpx(0.5)}
                        draggable
                        onMouseDown={(e) => { e.cancelBubble = true; setSelectedPoint(p.id); }}
                        onDragMove={(e) => editPoint(selShape.id, p.id, (pp) => ({ ...pp, feather: { x: e.target.x(), y: e.target.y() } }))}
                        onDragEnd={() => commitShape(selShape.id)}
                      />
                    );
                  }
                  return (
                    <Fragment key={p.id}>
                      {/* tangent connectors + handles */}
                      <Line key={`${p.id}-li`} points={[p.anchor.x, p.anchor.y, p.inHandle.x, p.inHandle.y]} stroke="#64748b" strokeWidth={hpx(0.75)} listening={false} />
                      <Line key={`${p.id}-lo`} points={[p.anchor.x, p.anchor.y, p.outHandle.x, p.outHandle.y]} stroke="#64748b" strokeWidth={hpx(0.75)} listening={false} />
                      <Rect
                        key={`${p.id}-hi`}
                        x={p.inHandle.x - hpx(3)} y={p.inHandle.y - hpx(3)} width={hpx(6)} height={hpx(6)}
                        fill="#94a3b8" draggable
                        onMouseDown={(e) => { e.cancelBubble = true; setSelectedPoint(p.id); }}
                        onDragMove={(e) => {
                          const np = { x: e.target.x() + hpx(3), y: e.target.y() + hpx(3) };
                          const broken = p.broken || e.evt.altKey || e.evt.ctrlKey;
                          editPoint(selShape.id, p.id, (pp) => ({ ...pp, inHandle: np, broken, outHandle: broken ? pp.outHandle : mirror(pp.anchor, np) }));
                        }}
                        onDragEnd={() => commitShape(selShape.id)}
                      />
                      <Rect
                        key={`${p.id}-ho`}
                        x={p.outHandle.x - hpx(3)} y={p.outHandle.y - hpx(3)} width={hpx(6)} height={hpx(6)}
                        fill="#94a3b8" draggable
                        onMouseDown={(e) => { e.cancelBubble = true; setSelectedPoint(p.id); }}
                        onDragMove={(e) => {
                          const np = { x: e.target.x() + hpx(3), y: e.target.y() + hpx(3) };
                          const broken = p.broken || e.evt.altKey || e.evt.ctrlKey;
                          editPoint(selShape.id, p.id, (pp) => ({ ...pp, outHandle: np, broken, inHandle: broken ? pp.inHandle : mirror(pp.anchor, np) }));
                        }}
                        onDragEnd={() => commitShape(selShape.id)}
                      />
                      <Circle
                        key={`${p.id}-a`}
                        x={p.anchor.x} y={p.anchor.y} radius={hpx(5)}
                        fill={isSel ? "#0ea5e9" : "#ffffff"} stroke="#0369a1" strokeWidth={hpx(1)}
                        draggable
                        onMouseDown={(e) => { e.cancelBubble = true; setSelectedPoint(p.id); }}
                        onDragMove={(e) => {
                          const na = { x: e.target.x(), y: e.target.y() };
                          editPoint(selShape.id, p.id, (pp) => {
                            const dx = na.x - pp.anchor.x, dy = na.y - pp.anchor.y;
                            return {
                              ...pp, anchor: na,
                              inHandle: { x: pp.inHandle.x + dx, y: pp.inHandle.y + dy },
                              outHandle: { x: pp.outHandle.x + dx, y: pp.outHandle.y + dy },
                              feather: { x: pp.feather.x + dx, y: pp.feather.y + dy },
                            };
                          });
                        }}
                        onDragEnd={() => commitShape(selShape.id)}
                      />
                    </Fragment>
                  );
                })}
              </>
            )}

            {/* Draft anchors while drawing */}
            {draft?.points.map((p, i) => (
              <Circle key={p.id} x={p.anchor.x} y={p.anchor.y} radius={hpx(4)} fill={i === 0 ? "#22c55e" : "#ffffff"} stroke="#000" strokeWidth={hpx(0.5)} listening={false} />
            ))}
          </Layer>
        </Stage>
      </div>

      {/* Bottom options */}
      <div className="h-14 bg-neutral-900 flex items-center gap-5 px-4 border-t border-neutral-800">
        {/* Shapes list */}
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <span className="text-[10px] text-neutral-500 uppercase tracking-wide shrink-0">Shapes</span>
          {work.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setSelectedShape(s.id)}
              className={`px-2 py-1 text-[11px] rounded shrink-0 ${s.id === selectedShapeId ? "bg-sky-600 text-white" : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"}`}
            >
              {s.op === "subtract" ? "−" : "+"}{i + 1}
            </button>
          ))}
          {work.length === 0 && <span className="text-[11px] text-neutral-600">— use Pen to draw</span>}
          {currentTool === "pen" && (
            <span className="text-[11px] text-sky-400/80 shrink-0 ml-2">
              Pen: click to add points · drag for curves · click the green start point to close · keep drawing for more shapes
            </span>
          )}
        </div>

        {selShape && (
          <>
            <div className="w-px h-6 bg-neutral-700" />
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-neutral-500 uppercase">Op</span>
              {(["union", "subtract"] as const).map((op) => (
                <button
                  key={op}
                  onClick={() => updateShape(selShape.id, { op })}
                  className={`px-2 py-1 text-[11px] rounded ${selShape.op === op ? "bg-white text-neutral-900" : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"}`}
                >
                  {op === "union" ? "Union" : "Subtract"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-neutral-500 uppercase">Opacity</span>
              <input
                type="range" min={0} max={1} step={0.01} value={selShape.opacity}
                onChange={(e) => updateShape(selShape.id, { opacity: parseFloat(e.target.value) })}
                className="w-28 accent-white"
              />
              <span className="text-xs text-neutral-400 w-8 text-right">{selShape.opacity.toFixed(2)}</span>
            </div>
            <button onClick={() => deleteShape(selShape.id)} className="px-2 py-1 text-[11px] text-neutral-400 hover:text-red-400">Delete shape</button>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer">
            <input
              type="checkbox"
              checked={invert}
              onChange={(e) => sourceNodeId && updateNodeData(sourceNodeId, { invert: e.target.checked })}
              className="accent-white"
            />
            Invert
          </label>
        </div>
      </div>
    </div>
  );
}
