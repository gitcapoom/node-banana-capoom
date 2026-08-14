"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Shape as KonvaShape, Circle, Rect, Line } from "react-konva";
import Konva from "konva";
import { useRotoStore } from "@/store/rotoStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { rasterizeRoto } from "@/utils/rasterizeRoto";
import type { RotoShape, RotoPoint, RotoFeatherFalloff } from "@/types";
import { zoomStageAtPointer } from "@/utils/konvaStageZoom";
import { DockedViewer } from "@/components/ViewerFeed";

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
/** Fill in fields missing from shapes saved before feather tangents existed
 *  (featherIn/featherOut/featherBroken) so the editor never reads undefined. */
function normalizePoint(p: RotoPoint): RotoPoint {
  const anchor = p.anchor;
  const inH = p.inHandle ?? anchor;
  const outH = p.outHandle ?? anchor;
  const feather = p.feather ?? anchor;
  const offx = feather.x - anchor.x;
  const offy = feather.y - anchor.y;
  return {
    ...p,
    anchor, inHandle: inH, outHandle: outH, feather,
    featherIn: p.featherIn ?? { x: inH.x + offx, y: inH.y + offy },
    featherOut: p.featherOut ?? { x: outH.x + offx, y: outH.y + offy },
    broken: p.broken ?? false,
    featherBroken: p.featherBroken ?? false,
  };
}
function normalizeShape(s: RotoShape): RotoShape {
  return { ...s, points: s.points.map(normalizePoint) };
}

/** Multiply every coordinate (and pixel-valued size) of every shape by s — for
 *  the downscaled matte preview. */
function scaleShapes(shapes: RotoShape[], s: number): RotoShape[] {
  const sp = (p: Pt) => ({ x: p.x * s, y: p.y * s });
  return shapes.map((sh) => ({
    ...sh,
    globalFeather: (sh.globalFeather ?? 0) * s,
    strokeWidth: (sh.strokeWidth ?? 8) * s,
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
    currentTool, closeModal, addShape, replaceShape, replaceShapes, updateShape, deleteShape, moveShape,
    setTool, setSelectedShape, setSelectedPoint, undo, redo,
  } = useRotoStore();
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const propagateFromNode = useWorkflowStore((s) => s.propagateFromNode);
  const nodes = useWorkflowStore((s) => s.nodes);
  const incrementModalCount = useWorkflowStore((s) => s.incrementModalCount);
  const decrementModalCount = useWorkflowStore((s) => s.decrementModalCount);

  // Register with the workflow modal count while open so the canvas underneath
  // goes inert — critically, React Flow's Delete/Backspace handler is disabled,
  // so deleting a roto point never also deletes the selected node on the canvas.
  useEffect(() => {
    if (!isModalOpen) return;
    incrementModalCount();
    return () => decrementModalCount();
  }, [isModalOpen, incrementModalCount, decrementModalCount]);

  const stageRef = useRef<Konva.Stage>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [editMode, setEditMode] = useState<"points" | "feather">("points");
  const [mattePreview, setMattePreview] = useState(false);
  const [matteImg, setMatteImg] = useState<HTMLImageElement | null>(null);

  const [work, setWork] = useState<RotoShape[]>(() => shapes.map(normalizeShape));
  useEffect(() => { setWork(shapes.map(normalizeShape)); }, [shapes]);
  const workRef = useRef(work);
  useEffect(() => { workRef.current = work; }, [work]);

  const [draft, setDraft] = useState<RotoShape | null>(null);
  const penDownRef = useRef(false);

  // Multi-point selection (anchor ids) for moving several points + their
  // feathers together. selectedPointId (store) stays the single "active" point.
  const [selectedPointIds, setSelectedPointIds] = useState<string[]>([]);
  const selectedIdsRef = useRef<string[]>([]);
  useEffect(() => { selectedIdsRef.current = selectedPointIds; }, [selectedPointIds]);
  // Rubber-band box select on empty canvas (select mode). `crossLayer` (Alt)
  // gathers points from every layer; `additive` (Shift) adds to the selection.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const selectDragRef = useRef<{ start: Pt; cur: Pt; moved: boolean; crossLayer: boolean; additive: boolean } | null>(null);
  // Dragging the selection's bounding box (move all selected points together).
  const bboxDragRef = useRef<{ last: Pt } | null>(null);
  // View panning (middle-mouse drag, or Space + left-drag on the canvas). Stores
  // the last SCREEN position so we can pan independent of zoom.
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const spaceHeldRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  // Switching shapes drops the multi-selection.
  useEffect(() => { setSelectedPointIds([]); }, [selectedShapeId]);

  // Discard an in-progress (uncommitted) draft when leaving the Pen tool, so
  // half-drawn shapes don't linger as orphan points with no layer to delete.
  useEffect(() => {
    if (currentTool !== "pen") { setDraft(null); penDownRef.current = false; }
    else setSelectedPointIds([]);
  }, [currentTool]);

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
    const stage = stageRef.current;
    if (!stage) return;
    const next = zoomStageAtPointer(stage, e.evt.deltaY, { min: 0.1, max: 8 });
    if (!next) return;
    setScale(next.scale);
    setPosition(next.position);
  }, []);

  // Publish the matte WHILE editing, so anything downstream — a composite, a
  // Viewer node, an open full-screen view — reflects the edit without waiting
  // for Done. Debounced: rasterizing a full-res matte on every handle drag
  // would stall the editor. `shapes` is deliberately NOT written here; it is
  // the input this modal derives `work` from, and writing it back would feed
  // straight into that effect and re-trigger this one.
  useEffect(() => {
    if (!isModalOpen || !sourceNodeId || !image) return;
    const t = setTimeout(() => {
      try {
        const outputMask = rasterizeRoto(work, image.width, image.height, { invert });
        updateNodeData(sourceNodeId, {
          outputMask,
          outputMaskRef: undefined,
          imageWidth: image.width,
          imageHeight: image.height,
        });
        // Push the change through the chain ourselves. Downstream node
        // components may be unmounted (viewport culling), so relying on them to
        // notice would leave a Viewer showing a stale frame.
        void propagateFromNode(sourceNodeId);
      } catch (e) {
        console.error("RotoModal: live matte commit failed", e);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [isModalOpen, sourceNodeId, image, work, invert, updateNodeData, propagateFromNode]);

  const selShape = work.find((s) => s.id === selectedShapeId) || null;

  const editPoint = useCallback((shapeId: string, pointId: string, fn: (p: RotoPoint) => RotoPoint) => {
    setWork((ws) => ws.map((s) => (s.id !== shapeId ? s : { ...s, points: s.points.map((p) => (p.id === pointId ? fn(p) : p)) })));
  }, []);
  const commitShape = useCallback((shapeId: string) => {
    const s = workRef.current.find((x) => x.id === shapeId);
    if (s) replaceShape(shapeId, s);
  }, [replaceShape]);

  /** Translate every selected point (across ALL layers) by (dx,dy), moving each
   *  point's whole bundle: anchor + tangents + feather. */
  const translateSelection = useCallback((dx: number, dy: number, extraId?: string) => {
    const ids = new Set(selectedIdsRef.current);
    if (extraId) ids.add(extraId);
    if (ids.size === 0) return;
    const tr = (q: Pt): Pt => ({ x: q.x + dx, y: q.y + dy });
    setWork((ws) => ws.map((s) => (s.points.some((p) => ids.has(p.id))
      ? { ...s, points: s.points.map((pp) => (ids.has(pp.id)
          ? { ...pp, anchor: tr(pp.anchor), inHandle: tr(pp.inHandle), outHandle: tr(pp.outHandle), feather: tr(pp.feather), featherIn: tr(pp.featherIn), featherOut: tr(pp.featherOut) }
          : pp)) }
      : s)));
  }, []);

  /** Drag one anchor to `na`, carrying the whole selection by the same delta.
   *  The dragged point is always included even if selection state lags. */
  const dragAnchor = useCallback((pointId: string, na: Pt) => {
    setWork((ws) => {
      let dragged: RotoPoint | undefined;
      for (const s of ws) { const p = s.points.find((q) => q.id === pointId); if (p) { dragged = p; break; } }
      if (!dragged) return ws;
      const dx = na.x - dragged.anchor.x, dy = na.y - dragged.anchor.y;
      const ids = new Set(selectedIdsRef.current); ids.add(pointId);
      const tr = (q: Pt): Pt => ({ x: q.x + dx, y: q.y + dy });
      return ws.map((s) => (s.points.some((p) => ids.has(p.id))
        ? { ...s, points: s.points.map((pp) => (ids.has(pp.id)
            ? { ...pp, anchor: tr(pp.anchor), inHandle: tr(pp.inHandle), outHandle: tr(pp.outHandle), feather: tr(pp.feather), featherIn: tr(pp.featherIn), featherOut: tr(pp.featherOut) }
            : pp)) }
        : s));
    });
  }, []);

  /** Commit every layer that holds a selected point as ONE history entry. */
  const commitSelection = useCallback((extraId?: string) => {
    const ids = new Set(selectedIdsRef.current);
    if (extraId) ids.add(extraId);
    const affected = workRef.current.filter((s) => s.points.some((p) => ids.has(p.id)));
    replaceShapes(affected);
  }, [replaceShapes]);

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

  // Insert a point on the selected shape's nearest segment (within threshold).
  // Returns true if a point was inserted. Defined before the stage handlers so
  // onStageMouseUp can depend on it without a TDZ in its dependency array.
  const tryInsertPoint = useCallback((click: Pt): boolean => {
    if (!selShape) return false;
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
    if (best.seg < 0 || best.d * scale > 8) return false;
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
    setSelectedPointIds([inserted.id]);
    return true;
  }, [selShape, scale, replaceShape, setSelectedPoint]);

  // ─── Pen draw / Select interaction ───────────────────────────────
  const onStageMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const onEmpty = e.target === e.target.getStage() || e.target.name() === "imagebg";
    const onFill = e.target.name() === "fill";
    // Pan the view: middle-mouse anywhere, or Space + left-drag. Restricted to the
    // image / empty canvas / fills so it never steals a control-point drag.
    if ((e.evt.button === 1 || (spaceHeldRef.current && e.evt.button === 0)) && (onEmpty || onFill)) {
      e.evt.preventDefault();
      e.cancelBubble = true;
      panRef.current = { x: e.evt.clientX, y: e.evt.clientY };
      setIsPanning(true);
      return;
    }
    if (!onEmpty && !onFill) return; // a handle was clicked — it manages itself
    const pos = getPos();

    if (currentTool === "pen") {
      if (!draft) { setDraft({ id: uid(), points: [newCorner(pos)], closed: false, op: "union", opacity: 1 }); penDownRef.current = true; return; }
      if (draft.points.length >= 2 && dist(pos, draft.points[0].anchor) * scale < 10) {
        // Close the shape and return to Select — one shape per Pen session, so
        // clicking empty canvas never spawns a stray new layer. Use ＋ New for more.
        addShape({ ...draft, closed: true }); setDraft(null); setTool("select"); return;
      }
      setDraft({ ...draft, points: [...draft.points, newCorner(pos)] }); penDownRef.current = true; return;
    }

    // ── select mode ──
    if (onFill && !e.evt.altKey) { setSelectedShape(e.target.attrs.shapeId as string); setSelectedPointIds([]); return; }
    // empty canvas (or Alt over a fill): start a marquee / plain click, resolved
    // on mouse-up. Alt → select across all layers; Shift → add to selection.
    selectDragRef.current = { start: pos, cur: pos, moved: false, crossLayer: e.evt.altKey, additive: e.evt.shiftKey };
    setMarquee(null);
  }, [currentTool, draft, getPos, scale, addShape, setTool, setSelectedShape]);

  const onStageMouseMove = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (panRef.current) {
      // End if neither left (1) nor middle (4) is still held (released off-canvas).
      if ((e.evt.buttons & 5) === 0) { panRef.current = null; setIsPanning(false); return; }
      const dx = e.evt.clientX - panRef.current.x;
      const dy = e.evt.clientY - panRef.current.y;
      panRef.current = { x: e.evt.clientX, y: e.evt.clientY };
      setPosition((p) => ({ x: p.x + dx, y: p.y + dy }));
      return;
    }
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
      return;
    }
    if (currentTool === "select" && bboxDragRef.current) {
      // Mouse released off-canvas (button no longer down) → end + commit.
      if ((e.evt.buttons & 1) === 0) { bboxDragRef.current = null; commitSelection(); return; }
      const pos = getPos();
      const { last } = bboxDragRef.current;
      translateSelection(pos.x - last.x, pos.y - last.y);
      bboxDragRef.current.last = pos;
      return;
    }
    if (currentTool === "select" && selectDragRef.current) {
      const pos = getPos();
      const d = selectDragRef.current;
      d.cur = pos;
      if (!d.moved && dist(pos, d.start) * scale > 4) d.moved = true;
      if (d.moved) setMarquee({ x0: d.start.x, y0: d.start.y, x1: pos.x, y1: pos.y });
    }
  }, [currentTool, draft, getPos, scale, translateSelection, commitSelection]);

  const onStageMouseUp = useCallback(() => {
    if (panRef.current) { panRef.current = null; setIsPanning(false); return; }
    penDownRef.current = false;
    if (currentTool !== "select") return;
    if (bboxDragRef.current) { bboxDragRef.current = null; commitSelection(); return; }
    const d = selectDragRef.current;
    selectDragRef.current = null;
    setMarquee(null);
    if (!d) return;
    if (d.moved) {
      // Box select. Alt → anchors from every layer; otherwise only the selected
      // shape. Shift → add to the existing selection.
      const xmin = Math.min(d.start.x, d.cur.x), xmax = Math.max(d.start.x, d.cur.x);
      const ymin = Math.min(d.start.y, d.cur.y), ymax = Math.max(d.start.y, d.cur.y);
      const pool = d.crossLayer ? work.flatMap((s) => s.points) : (selShape ? selShape.points : []);
      const hit = pool.filter((p) => p.anchor.x >= xmin && p.anchor.x <= xmax && p.anchor.y >= ymin && p.anchor.y <= ymax).map((p) => p.id);
      const next = d.additive ? Array.from(new Set([...selectedIdsRef.current, ...hit])) : hit;
      setSelectedPointIds(next);
      setSelectedPoint(next.length === 1 ? next[0] : null);
      return;
    }
    // Plain click on empty canvas: insert a point if near a segment, else clear.
    if (selShape && editMode === "points" && tryInsertPoint(d.start)) return;
    setSelectedPointIds([]);
    setSelectedPoint(null);
  }, [currentTool, selShape, work, editMode, tryInsertPoint, setSelectedPoint, commitSelection]);

  // ─── Keyboard ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModalOpen) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") { if (draft) setDraft(null); else closeModal(); }
      // Enter finishes the spline OPEN as an edge stroke (closing via the start
      // point makes a filled shape instead).
      if (e.key === "Enter" && draft && draft.points.length >= 2) { addShape({ ...draft, closed: false, renderMode: "edge", strokeWidth: 8 }); setDraft(null); setTool("select"); }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if (e.key === "p" || e.key === "P") setTool("pen");
      if (e.key === "v" || e.key === "V") setTool("select");
      if ((e.key === "Delete" || e.key === "Backspace") && currentTool === "select" && selShape) {
        // Delete every selected point (single or multi); if too few would
        // remain to form a shape (<2), drop the whole layer instead.
        const del = selectedPointIds.length ? selectedPointIds : (selectedPointId ? [selectedPointId] : []);
        if (del.length && selShape.points.length - del.length >= 2) {
          replaceShape(selShape.id, { ...selShape, points: selShape.points.filter((p) => !del.includes(p.id)) });
          setSelectedPoint(null); setSelectedPointIds([]);
        } else { deleteShape(selShape.id); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isModalOpen, draft, currentTool, selShape, selectedPointId, selectedPointIds, closeModal, addShape, setTool, undo, redo, replaceShape, deleteShape, setSelectedPoint]);

  // Space = hold-to-pan modifier. Tracked separately so it can fall through the
  // canvas without scrolling and updates the grab cursor.
  useEffect(() => {
    if (!isModalOpen) return;
    const editable = (t: EventTarget | null) => {
      const tag = (t as HTMLElement | null)?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA";
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !editable(e.target)) { e.preventDefault(); spaceHeldRef.current = true; setSpaceHeld(true); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") { spaceHeldRef.current = false; setSpaceHeld(false); }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [isModalOpen]);

  const handleDone = useCallback(() => {
    if (!sourceNodeId || !image) return;
    const outputMask = rasterizeRoto(work, image.width, image.height, { invert });
    updateNodeData(sourceNodeId, { shapes: work, outputMask, imageWidth: image.width, imageHeight: image.height });
    closeModal();
  }, [sourceNodeId, image, work, invert, updateNodeData, closeModal]);

  if (!isModalOpen) return null;
  const hpx = (v: number) => v / scale;

  // Bounding box of the current multi-selection (across all layers). Shown when
  // 2+ points are selected; its interior is a drag handle for the whole group.
  const selSet = new Set(selectedPointIds);
  const selAnchors: Pt[] = [];
  for (const s of work) for (const p of s.points) if (selSet.has(p.id)) selAnchors.push(p.anchor);
  const bbox = selAnchors.length >= 2
    ? {
        minX: Math.min(...selAnchors.map((a) => a.x)), minY: Math.min(...selAnchors.map((a) => a.y)),
        maxX: Math.max(...selAnchors.map((a) => a.x)), maxY: Math.max(...selAnchors.map((a) => a.y)),
      }
    : null;

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
              {editMode === "feather" && selShape && (
                <label className="flex items-center gap-1.5 text-[11px] text-neutral-400 ml-1" title="Feather edge falloff for this shape">
                  Falloff
                  <select
                    value={selShape.featherFalloff ?? "linear"}
                    onChange={(e) => updateShape(selShape.id, { featherFalloff: e.target.value as RotoFeatherFalloff })}
                    className="bg-neutral-800 text-white text-[11px] rounded px-1.5 py-1 outline-none border border-neutral-700"
                  >
                    <option value="linear">Linear</option>
                    <option value="smooth">Smooth</option>
                    <option value="smoother">Smoother</option>
                    <option value="easeIn">Ease In</option>
                    <option value="easeOut">Ease Out</option>
                  </select>
                </label>
              )}
              {selShape && (
                <>
                  <div className="w-px h-6 bg-neutral-700 mx-1.5" />
                  <label className="flex items-center gap-1 text-[11px] text-neutral-400" title="Uniform feather for this layer — adds to the per-point feather">
                    Feather
                    <input type="range" min={0} max={200} step={1} value={selShape.globalFeather ?? 0}
                      onChange={(e) => updateShape(selShape.id, { globalFeather: parseFloat(e.target.value) })}
                      className="w-20 accent-white" />
                    <span className="w-6 tabular-nums text-right text-neutral-300">{Math.round(selShape.globalFeather ?? 0)}</span>
                  </label>
                  <div className="w-px h-6 bg-neutral-700 mx-1.5" />
                  <button
                    onClick={() => updateShape(selShape.id, { renderMode: (selShape.renderMode ?? "fill") === "edge" ? "fill" : "edge" })}
                    className={`px-3 py-1.5 text-xs rounded ${(selShape.renderMode ?? "fill") === "edge" ? "bg-amber-600 text-white" : "text-neutral-400 hover:text-white"}`}
                    title="Stroke the spline edge (open splines allowed) instead of filling the area"
                  >
                    Edge
                  </button>
                  {(selShape.renderMode ?? "fill") === "edge" && (
                    <label className="flex items-center gap-1 text-[11px] text-neutral-400" title="Edge stroke thickness (px)">
                      Width
                      <input type="range" min={0} max={300} step={1} value={selShape.strokeWidth ?? 8}
                        onChange={(e) => updateShape(selShape.id, { strokeWidth: parseFloat(e.target.value) })}
                        className="w-20 accent-white" />
                      <span className="w-7 tabular-nums text-right text-neutral-300">{Math.round(selShape.strokeWidth ?? 8)}</span>
                    </label>
                  )}
                </>
              )}
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
        <div ref={containerRef} className="relative flex-1 overflow-hidden bg-neutral-900">
          <DockedViewer />
          <Stage
            ref={stageRef}
            width={containerRef.current?.clientWidth || 800}
            height={containerRef.current?.clientHeight || 600}
            scaleX={scale} scaleY={scale} x={position.x} y={position.y}
            onMouseDown={onStageMouseDown} onMouseMove={onStageMouseMove} onMouseUp={onStageMouseUp} onWheel={handleWheel}
            style={{ cursor: isPanning ? "grabbing" : spaceHeld ? "grab" : currentTool === "pen" ? "crosshair" : "default" }}
          >
            <Layer listening>
              {mattePreview && matteImg
                ? <KonvaImage name="imagebg" image={matteImg} width={stageSize.width} height={stageSize.height} />
                : image && <KonvaImage name="imagebg" image={image} width={stageSize.width} height={stageSize.height} />}
            </Layer>

            {/* translucent fills (hidden in matte preview) */}
            {!mattePreview && (
              <Layer listening={currentTool === "select"}>
                {work.map((shape) => {
                  const edge = (shape.renderMode ?? "fill") === "edge";
                  const color = shape.op === "subtract" ? "rgba(239,68,68,0.5)" : "rgba(56,189,248,0.45)";
                  return (
                    <KonvaShape
                      key={shape.id} name="fill" shapeId={shape.id}
                      sceneFunc={(ctx, s) => { drawShapePath(ctx, shape); ctx.fillStrokeShape(s); }}
                      fill={edge ? undefined : (shape.op === "subtract" ? "rgba(239,68,68,0.22)" : "rgba(56,189,248,0.18)")}
                      stroke={edge ? color : undefined}
                      strokeWidth={edge ? (shape.strokeWidth ?? 8) : undefined}
                      lineCap="round" lineJoin="round"
                      hitStrokeWidth={edge ? Math.max(shape.strokeWidth ?? 8, hpx(12)) : undefined}
                      listening={currentTool === "select"}
                    />
                  );
                })}
                {currentTool === "pen" && draft && <KonvaShape listening={false} sceneFunc={(ctx, s) => { drawShapePath(ctx, draft); ctx.fillStrokeShape(s); }} fill="rgba(56,189,248,0.15)" />}
              </Layer>
            )}

            {/* selected shape outline + handles */}
            <Layer>
              {/* Selection bounding box — drawn UNDER the point handles so anchors
                  inside it stay grabbable; its interior drags the whole group.
                  Alt+press starts a cross-layer marquee instead of a move. */}
              {currentTool === "select" && bbox && (
                <Rect
                  x={bbox.minX - hpx(7)} y={bbox.minY - hpx(7)}
                  width={(bbox.maxX - bbox.minX) + hpx(14)} height={(bbox.maxY - bbox.minY) + hpx(14)}
                  stroke="#0ea5e9" strokeWidth={hpx(1)} dash={[hpx(5), hpx(3)]} fill="rgba(14,165,233,0.07)"
                  onMouseEnter={(e) => { const st = e.target.getStage(); if (st) st.container().style.cursor = "move"; }}
                  onMouseLeave={(e) => { const st = e.target.getStage(); if (st) st.container().style.cursor = "default"; }}
                  onMouseDown={(e) => {
                    if (e.evt.altKey) { e.cancelBubble = true; const pos = getPos(); selectDragRef.current = { start: pos, cur: pos, moved: false, crossLayer: true, additive: e.evt.shiftKey }; setMarquee(null); return; }
                    e.cancelBubble = true; bboxDragRef.current = { last: getPos() };
                  }}
                />
              )}
              {/* Cross-layer selected points that aren't on the active shape —
                  shown as dots so a multi-layer selection is visible. */}
              {currentTool === "select" && work.flatMap((s) => (s.id === selectedShapeId ? [] : s.points.filter((p) => selSet.has(p.id)).map((p) => (
                <Circle key={`xl-${p.id}`} x={p.anchor.x} y={p.anchor.y} radius={hpx(4)} fill="#0ea5e9" stroke="#0369a1" strokeWidth={hpx(1)} listening={false} />
              ))))}
              {selShape && (
                <>
                  <KonvaShape listening={false} sceneFunc={(ctx, s) => { drawShapePath(ctx, selShape); ctx.strokeShape(s); }} stroke="#0ea5e9" strokeWidth={hpx(1.5)} />
                  {editMode === "feather" && currentTool === "select" && (
                    <KonvaShape listening={false} sceneFunc={(ctx, s) => { drawFeatherPath(ctx, selShape); ctx.strokeShape(s); }} stroke="#f59e0b" strokeWidth={hpx(1)} dash={[hpx(4), hpx(4)]} />
                  )}

                  {/* Edit handles only in Select mode — keep Pen clean. */}
                  {currentTool === "select" && selShape.points.map((p) => {
                    const isSel = p.id === selectedPointId || selectedPointIds.includes(p.id);
                    if (editMode === "feather") {
                      return (
                        <Fragment key={p.id}>
                          {isSel && (
                            <>
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
                            </>
                          )}
                          <Circle x={p.feather.x} y={p.feather.y} radius={hpx(5)} fill={isSel ? "#f59e0b" : "#fcd34d"} stroke="#000" strokeWidth={hpx(0.5)} draggable
                            onMouseDown={(e) => { e.cancelBubble = true; setSelectedPoint(p.id); selectedIdsRef.current = [p.id]; setSelectedPointIds([p.id]); }}
                            onDblClick={(e) => { e.cancelBubble = true; toggleFeatherSmooth(selShape.id, p.id, e.evt.altKey); }}
                            onDragMove={(e) => { const nf = { x: e.target.x(), y: e.target.y() }; editPoint(selShape.id, p.id, (pp) => { const dx = nf.x - pp.feather.x, dy = nf.y - pp.feather.y; return { ...pp, feather: nf, featherIn: { x: pp.featherIn.x + dx, y: pp.featherIn.y + dy }, featherOut: { x: pp.featherOut.x + dx, y: pp.featherOut.y + dy } }; }); }}
                            onDragEnd={() => commitShape(selShape.id)} />
                        </Fragment>
                      );
                    }
                    return (
                      <Fragment key={p.id}>
                        {/* Tangents only on the selected point(s) — unselected points
                            stay clean dots so anchors are always clearly visible. */}
                        {isSel && (
                          <>
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
                          </>
                        )}
                        <Circle x={p.anchor.x} y={p.anchor.y} radius={hpx(5)} fill={isSel ? "#0ea5e9" : "#ffffff"} stroke="#0369a1" strokeWidth={hpx(1)} draggable
                          onMouseDown={(e) => {
                            e.cancelBubble = true;
                            const cur = selectedIdsRef.current;
                            // Shift toggles; plain click keeps an existing multi-selection
                            // (to drag it) or resets to just this point.
                            const next = e.evt.shiftKey
                              ? (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id])
                              : (cur.includes(p.id) ? cur : [p.id]);
                            selectedIdsRef.current = next; // sync so dragAnchor reads it immediately
                            setSelectedPointIds(next);
                            setSelectedPoint(p.id);
                          }}
                          onDblClick={(e) => { e.cancelBubble = true; toggleSmooth(selShape.id, p.id, e.evt.altKey); }}
                          onDragMove={(e) => { const na = { x: e.target.x(), y: e.target.y() }; dragAnchor(p.id, na); }}
                          onDragEnd={() => commitSelection(p.id)} />
                      </Fragment>
                    );
                  })}
                </>
              )}
              {currentTool === "pen" && draft?.points.map((p, i) => (
                <Circle key={p.id} x={p.anchor.x} y={p.anchor.y} radius={hpx(4)} fill={i === 0 ? "#22c55e" : "#ffffff"} stroke="#000" strokeWidth={hpx(0.5)} listening={false} />
              ))}
              {marquee && (
                <Rect
                  x={Math.min(marquee.x0, marquee.x1)} y={Math.min(marquee.y0, marquee.y1)}
                  width={Math.abs(marquee.x1 - marquee.x0)} height={Math.abs(marquee.y1 - marquee.y0)}
                  fill="rgba(14,165,233,0.10)" stroke="#0ea5e9" strokeWidth={hpx(1)} dash={[hpx(4), hpx(4)]} listening={false}
                />
              )}
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
              Pen: click to add points · drag for curves · click the green start point to close (filled), or press Enter to finish open (edge stroke). Returns to Select — use ＋ New for another.
            </div>
          )}
          {currentTool === "select" && selShape && (
            <div className="px-3 py-2 border-t border-neutral-800 text-[10px] text-neutral-500 leading-snug">
              Click a point to select (Shift+click or drag a box for several). Drag a point or the selection box to move them — feathers move too. Alt+drag a box selects across all layers. Double-click = add/smooth tangents (Alt = corner). Click a segment to insert a point. Del removes. {editMode === "feather" ? "Drag the amber feather points + handles." : "Switch to Feather to edit softness."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
