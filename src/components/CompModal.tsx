"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Stage, Layer, Image as KonvaImage, Line, Circle, Rect } from "react-konva";
import Konva from "konva";
import { useCompStore, type CompActiveInput } from "@/store/compStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { renderCompPreviewToCanvas, floatNodeToDataUrl, renderComp, releaseColorNode, type CompRoi } from "@/utils/colorChain";
import { buildCompInputs, buildCompParams, compositeCompForExecutor, resolveFgAlign } from "@/utils/compComposite";
import {
  computePieces, computeAlignedPieces, deriveAlignBase, alignRectInOutput, reformatScale,
  forwardPoint, forwardCorners, type CompPieces, type CompAlignBase, type CompAlignFit,
} from "@/utils/compTransform";
import { normalizeAlignMeta } from "@/utils/compSignature";
import {
  COMP_OP_LABELS, defaultCompTransform, defaultCompFilter, defaultCompResample,
  COMP_RESAMPLE_FILTERS, COMP_RESAMPLE_LABELS,
  defaultCompLayerColor, normalizeCompLayerColor, normalizeCompGrade,
  type CompInputFilter, type BlurFilterType, type CompResampleFilter, type CompLayerColor,
} from "@/types/comp";
import { GradeRow, GRADE_SLIDERS, GRADE_WHEEL_POP_ID } from "@/components/controls/GradeRow";
import { isMaster, type GradeChannelValue, type GradeParams } from "@/utils/colorGrade";
import type { CompNodeData, CompMergeOp, CompReformat, CompTransform } from "@/types";
import { zoomStageAtPointer } from "@/utils/konvaStageZoom";
import { cheapUrlKey } from "@/utils/renderSignature";
import { DockedViewer } from "@/components/ViewerFeed";

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
/** How a generated FG whose aspect no longer matches the crop rect fills it. */
const ALIGN_FITS: Array<{ v: CompAlignFit; label: string }> = [
  { v: "fit", label: "Fit (inside, BG shows)" },
  { v: "stretch", label: "Stretch (distorts)" },
  { v: "fill", label: "Fill (overhangs)" },
];
/** Aspect mismatch beyond this is visible, so it is said out loud. */
const ALIGN_ASPECT_WARN = 0.005;
const FILTERS: Array<{ v: CompInputFilter["filter"]; label: string }> = [
  { v: "none", label: "None" },
  { v: "gaussian", label: "Gaussian" },
  { v: "box", label: "Box" },
  { v: "motion", label: "Motion" },
  { v: "zoom", label: "Zoom" },
  { v: "spin", label: "Spin" },
];

// ── In-comp colour correction rows ────────────────────────────────────────
//
// The GRADE rows are not defined here: they render the SHARED GradeRow control
// against the SHARED GRADE_SLIDERS table (components/controls/GradeRow.tsx), so
// the comp's grade is the same control as the standalone Color Grade node —
// per-channel tracks, colour swatch and wheel included. A local copy of the
// ranges would be a second, silently different wheel, because the wheel derives
// its strength from them.
//
// HSV keeps the local rows below: hue/saturation/value are genuinely scalars,
// not per-channel values, so there is nothing to share. Ranges match
// HsvCorrectNode.
type GradeKey = keyof GradeParams;
interface ColorRowDef { label: string; min: number; max: number; step: number }
type HsvKey = "hueShift" | "saturation" | "value";
const HSV_ROWS: Array<ColorRowDef & { key: HsvKey }> = [
  { key: "hueShift", label: "Hue", min: -180, max: 180, step: 1 },
  { key: "saturation", label: "Saturation", min: 0, max: 2, step: 0.01 },
  { key: "value", label: "Value", min: 0, max: 2, step: 0.01 },
];

/**
 * Slider + numeric, the row shape the rest of this panel already uses.
 *
 * The slider is clamped to [min,max] by the browser; the numeric field is NOT
 * (only floored/ceiled to the same range on commit) — same bargain the transform
 * fields strike, where the useful values run past where a 200px slider can go.
 * Module scope so it is one component identity, not a new one per render.
 */
function ColorRow({ def, value, onChange }: { def: ColorRowDef; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">{def.label}</label>
      <input
        type="range" min={def.min} max={def.max} step={def.step}
        value={Math.max(def.min, Math.min(def.max, value))}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="nodrag flex-1 min-w-0 accent-teal-500"
      />
      <input
        type="number" step={def.step} value={Number(value.toFixed(4))}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="nodrag w-14 shrink-0 text-[10px] py-1 px-1.5 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700"
      />
    </div>
  );
}

/** Signed whole px, so the readout reads as an offset rather than a coordinate. */
function fmtSigned(n: number): string {
  const r = Math.round(n);
  return r >= 0 ? `+${r}` : `${r}`;
}

function loadSize(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export function CompModal() {
  const { isModalOpen, sourceNodeId, activeInput, closeModal, setActiveInput, draft, patchDraft, baseline, setBaseline } = useCompStore();
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const propagateFromNode = useWorkflowStore((s) => s.propagateFromNode);
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === sourceNodeId));
  const incrementModalCount = useWorkflowStore((s) => s.incrementModalCount);
  const decrementModalCount = useWorkflowStore((s) => s.decrementModalCount);

  // Register with the workflow modal count while open so the canvas underneath
  // goes inert (esp. React Flow's Delete/Backspace node deletion).
  useEffect(() => {
    if (!isModalOpen) return;
    incrementModalCount();
    return () => decrementModalCount();
  }, [isModalOpen, incrementModalCount, decrementModalCount]);

  const stageRef = useRef<Konva.Stage>(null);
  const imageNodeRef = useRef<Konva.Image>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const translateRef = useRef<{ startPL: { x: number; y: number }; startH: number; startV: number } | null>(null);
  // View-pan drag (independent of layer-transform edits) + arrow-key nudge.
  const panRef = useRef<{ start: { x: number; y: number }; startPos: { x: number; y: number } } | null>(null);
  const nudgeRef = useRef<(dx: number, dy: number) => void>(() => {});
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

  // Five source ids + the align pin, shallow-compared.
  //
  // This was a useMemo over [edges, nodes], and both arrays get a new identity
  // on EVERY store write — so `srcs` was a fresh object every time, and it is a
  // dependency of the preview effect below. A full 24MP composite therefore
  // re-fired for every unrelated write anywhere in the graph, including the
  // modal's own 350ms publish and every node propagateFromNode touched. With a
  // shallow compare the object is stable until a connection genuinely changes.
  //
  // Declared above `data` because `data` folds `alignMeta` in — see there.
  const srcs = useWorkflowStore(
    useShallow((state) => {
      const r = { bgSrc: null as string | null, baSrc: null as string | null, fgSrc: null as string | null, faSrc: null as string | null, mtSrc: null as string | null, alignMeta: null as string | null };
      if (!sourceNodeId) return r;
      for (const e of state.edges) {
        if (e.target !== sourceNodeId) continue;
        const src = state.nodes.find((n) => n.id === e.source);
        if (!src) continue;
        const out = getSourceOutput(src, e.sourceHandle, e.data as Record<string, unknown> | undefined);
        // The FG align pin carries TEXT (serialized CropMetadata), so it must be
        // read before the image guard below, which drops every non-image output.
        if (e.targetHandle === "text-comp_fg_align") {
          if (out.type === "text") r.alignMeta = out.value ?? null;
          continue;
        }
        if (out.type !== "image" || !out.value) continue;
        if (e.targetHandle === "image-comp_bg") r.bgSrc = src.id;
        else if (e.targetHandle === "image-comp_bg_alpha") r.baSrc = src.id;
        else if (e.targetHandle === "image-comp_fg") r.fgSrc = src.id;
        else if (e.targetHandle === "image-comp_fg_alpha") r.faSrc = src.id;
        else if (e.targetHandle === "image-comp_matte") r.mtSrc = src.id;
      }
      return r;
    }),
  );

  // Node data with the editor's UNAPPLIED changes layered on top.
  //
  // The draft carries parameters only. The five image mirrors stay live from
  // node data, because CompNode keeps writing them from its edges while this
  // editor is open — drafting them too would freeze the editor on whatever
  // happened to be upstream at the moment it opened.
  //
  // The align pin is read STRAIGHT off the edges for the same reason it is in
  // CompNode's signature: the mirror in node data lands a render late, so the
  // derived-placement readout and the on-canvas handles would trail the render
  // by a frame every time the crop moved. normalizeAlignMeta keeps "absent" from
  // becoming "null" in the object handed to buildCompParams.
  const nodeData = node?.data as CompNodeData | undefined;
  const data = useMemo<CompNodeData | undefined>(
    () => (nodeData ? { ...nodeData, ...draft, fgAlignMeta: normalizeAlignMeta(nodeData.fgAlignMeta, srcs.alignMeta) } : undefined),
    [nodeData, draft, srcs.alignMeta],
  );

  /** Every parameter edit goes to the draft — never straight to node data. */
  const patch = useCallback((p: Partial<CompNodeData>) => patchDraft(p), [patchDraft]);

  // Snapshot the output fields on the rising edge. The settle-commit below
  // publishes a real composite while you work so a Viewer keeps moving, and
  // that write lands in node data outside the draft — so Cancel has to put
  // these back explicitly. Guarded on `baseline` so it captures once.
  useEffect(() => {
    if (!isModalOpen || !nodeData || baseline) return;
    setBaseline({
      outputImage: nodeData.outputImage,
      outputImageRef: nodeData.outputImageRef,
      outputWidth: nodeData.outputWidth,
      outputHeight: nodeData.outputHeight,
      outputImageDims: nodeData.outputImageDims,
      compCommitSig: nodeData.compCommitSig,
    });
  }, [isModalOpen, nodeData, baseline, setBaseline]);

  const resSrc = data?.outputResolution === "fg" && sizes.fg ? sizes.fg : sizes.bg;
  const outW = resSrc?.w ?? 0;
  const outH = resSrc?.h ?? 0;

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
  //
  // The five image fields go in by CHEAP KEY, never raw. They are base64 data
  // URLs — a 34-55MB PNG on disk is a 45-73MB JS string here — and this
  // expression sits in the RENDER BODY, so stringifying them raw copied and
  // escape-scanned 100-300MB on every render, twice per pointer-move while
  // dragging a handle. That, not the GPU, was what made this editor crawl.
  // CompNode already learned this (see renderSignature.ts and CompNode's own
  // sig); the modal never did. useMemo keeps it off renders that changed
  // nothing at all.
  //
  // `fgAm` (the align metadata) goes in RAW on purpose — it is a ~200-byte JSON
  // string, not an image, and the align fields must be here or the new controls
  // would appear to do nothing until the editor was closed and reopened. Same
  // for `bgC`/`fgC`: ~15 numbers each, and the colour sliders are dead in this
  // editor until they are listed here.
  const previewSig = useMemo(
    () =>
      data
        ? JSON.stringify({ op: data.mergeOp, pm: data.premultiplyFg, pmb: data.premultiplyBg, sw: data.swapBgFg, res: data.outputResolution, bo: [data.bgBlackOutside, data.fgBlackOutside], bgo: data.bgOpacity, fgo: data.fgOpacity, bgT: data.bgTransform, baT: data.bgAlphaTransform, fg: data.fgTransform, fa: data.fgAlphaTransform, mt: data.matteTransform, bar: data.bgAlphaReformat, far: data.fgAlphaReformat, mtr: data.matteReformat, bgF: data.bgFilter, baF: data.bgAlphaFilter, fgF: data.fgFilter, faF: data.fgAlphaFilter, mtF: data.matteFilter, bgR: data.bgResample, baR: data.bgAlphaResample, fgR: data.fgResample, faR: data.fgAlphaResample, mtR: data.matteResample, fgS: data.fgSoftness, bgC: data.bgColor, fgC: data.fgColor, fgAl: data.fgAlign, fgAf: data.fgAlignFit, fgAm: data.fgAlignMeta, bg: cheapUrlKey(data.bgImage), baU: cheapUrlKey(data.bgAlphaImage), fgU: cheapUrlKey(data.fgImage), faU: cheapUrlKey(data.fgAlphaImage), mtU: cheapUrlKey(data.matteImage) })
        : "",
    [data],
  );
  // Preview resolution, quantised to octaves and debounced, so a wheel-zoom
  // doesn't recomposite on every notch — only when it crosses a power of two.
  const [renderScale, setRenderScale] = useState(1);
  useEffect(() => {
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const target = Math.min(1, Math.max(0.02, scale * dpr));
    const octave = Math.min(1, Math.pow(2, Math.ceil(Math.log2(target))));
    const t = setTimeout(() => setRenderScale(octave), 140);
    return () => clearTimeout(t);
  }, [scale]);

  // Visible region of the output, in output px, debounced with the same cadence
  // as the zoom. Zoomed OUT this covers the whole frame and clamps to it, so
  // nothing changes; zoomed IN it shrinks, which is what keeps the cost of
  // going closer flat instead of growing with the magnification. The margin
  // means a small pan doesn't immediately expose an unrendered edge.
  const [viewRoi, setViewRoi] = useState<CompRoi | null>(null);
  useEffect(() => {
    if (!outW || !outH) return;
    const t = setTimeout(() => {
      const vw = stageSize.width / scale;
      const vh = stageSize.height / scale;
      const mx = vw * 0.15, my = vh * 0.15;
      setViewRoi({
        x: Math.max(0, Math.floor(-position.x / scale - mx)),
        y: Math.max(0, Math.floor(-position.y / scale - my)),
        w: Math.ceil(vw + mx * 2),
        h: Math.ceil(vh + my * 2),
      });
    }, 140);
    return () => clearTimeout(t);
  }, [scale, position.x, position.y, stageSize.width, stageSize.height, outW, outH]);

  /** The ROI the last preview actually rendered — the image is laid out here. */
  const [renderedRoi, setRenderedRoi] = useState<CompRoi | null>(null);

  useEffect(() => {
    if (!isModalOpen || !data || !sourceNodeId || !offscreen) return;
    let cancelled = false;
    const urls = { bg: data.bgImage, bgAlpha: data.bgAlphaImage, fg: data.fgImage, fgAlpha: data.fgAlphaImage, matte: data.matteImage };
    const run = async () => {
      if (!urls.bg) return;
      // PROXY preview: composite only the VISIBLE REGION, at the editor's zoom
      // level, rather than the whole frame at source resolution. Cost is then
      // bounded by the viewport — roughly the same whether you are at fit, 1:1
      // or 8:1 — instead of scaling with either the source size or the zoom.
      //
      // This deliberately does NOT publish the float texture: see the commit
      // effect below.
      const roiOut = await renderCompPreviewToCanvas(
        buildCompInputs(urls, srcs), buildCompParams(data), sourceNodeId, offscreen, renderScale,
        viewRoi ?? undefined,
      );
      if (!cancelled && roiOut) setRenderedRoi(roiOut);
      if (!cancelled && !roiOut) {
        setRenderedRoi(null); // Canvas2D fallback paints the whole frame
        const { dataUrl, outW: w, outH: h } = await compositeCompForExecutor(urls, srcs, data, sourceNodeId);
        if (cancelled || !dataUrl || !w) return;
        await new Promise<void>((res) => { const img = new Image(); img.onload = () => { offscreen.width = w; offscreen.height = h; offscreen.getContext("2d")?.drawImage(img, 0, 0); res(); }; img.onerror = () => res(); img.src = dataUrl; });
      }
      if (!cancelled) { imageNodeRef.current?.getLayer()?.batchDraw(); setPreviewTick((t) => t + 1); }
    };
    const raf = requestAnimationFrame(run);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [previewSig, isModalOpen, srcs, sourceNodeId, offscreen, renderScale, viewRoi]);

  // COMMIT, on settle. CompNode's own render is suspended for the node being
  // edited (the modal owns the canvas), so without this nothing downstream —
  // including a Viewer — would move until Done.
  //
  // This now does its own FULL-RES render: the preview above is a proxy that
  // deliberately never touches the float registry, so the texture the chain
  // reads and the PNG written to `outputImage` must both come from a real
  // full-res composite. That is the expensive operation in this editor (a 24MP
  // toDataURL alone measures 1.0-1.8s here), which is exactly why it belongs
  // behind a settle rather than in the drag loop — hence the longer debounce.
  useEffect(() => {
    if (!isModalOpen || !sourceNodeId || !data?.bgImage) return;
    let cancelled = false;
    const urls = { bg: data.bgImage, bgAlpha: data.bgAlphaImage, fg: data.fgImage, fgAlpha: data.fgAlphaImage, matte: data.matteImage };
    const t = setTimeout(async () => {
      const res = await renderComp(buildCompInputs(urls, srcs), buildCompParams(data), sourceNodeId);
      if (cancelled || !res) return;
      const url = await floatNodeToDataUrl(sourceNodeId);
      if (!cancelled && url) {
        updateNodeData(sourceNodeId, { outputImage: url, outputImageRef: undefined });
        void propagateFromNode(sourceNodeId);
      }
    }, 700);
    return () => { cancelled = true; clearTimeout(t); };
    // previewSig covers every input + parameter the composite depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSig, isModalOpen, sourceNodeId]);

  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const next = zoomStageAtPointer(stage, e.evt.deltaY, { min: 0.05, max: 8 });
    if (!next) return;
    setScale(next.scale);
    setPosition(next.position);
  }, []);

  const TKEY = { bg: "bgTransform", bgAlpha: "bgAlphaTransform", fg: "fgTransform", fgAlpha: "fgAlphaTransform", matte: "matteTransform" } as const;
  const FKEY = { bg: "bgFilter", bgAlpha: "bgAlphaFilter", fg: "fgFilter", fgAlpha: "fgAlphaFilter", matte: "matteFilter" } as const;
  const activeKey = TKEY[activeInput];
  const RKEY = { bg: "bgResample", bgAlpha: "bgAlphaResample", fg: "fgResample", fgAlpha: "fgAlphaResample", matte: "matteResample" } as const;
  const activeFilterKey = FKEY[activeInput];
  const activeResampleKey = RKEY[activeInput];
  const activeResample: CompResampleFilter =
    (data?.[activeResampleKey] as CompResampleFilter | undefined) ?? defaultCompResample();
  const activeFilter: CompInputFilter = {
    ...defaultCompFilter(),
    ...((data?.[activeFilterKey] as Partial<CompInputFilter> | undefined) ?? {}),
  };
  // Merge against defaults so legacy/partial transforms always have every field.
  const activeTransform: CompTransform | undefined = data
    ? { ...defaultCompTransform(), ...((data[activeKey] as Partial<CompTransform> | undefined) ?? {}) }
    : undefined;
  const activeSize = activeInput === "bg" ? sizes.bg : activeInput === "bgAlpha" ? sizes.bgAlpha : activeInput === "fg" ? sizes.fg : activeInput === "fgAlpha" ? sizes.fgAlpha : sizes.matte;
  // Which input does this one follow when its checkbox is off? (alpha pins)
  const followsLabel = activeInput === "bgAlpha" ? "BG" : activeInput === "fgAlpha" ? "FG" : null;

  const patchTransform = useCallback(
    (p: Partial<CompTransform>) => {
      if (!sourceNodeId || !data) return;
      const cur = { ...defaultCompTransform(), ...((data[activeKey] as Partial<CompTransform> | undefined) ?? {}) };
      const next = { ...cur, ...p };
      // Scale lock: Scale Y follows Scale X (a Y-only edit drives X, then Y mirrors X).
      if (next.scaleLock) {
        if ("scaleY" in p && !("scaleX" in p)) next.scaleX = next.scaleY;
        next.scaleY = next.scaleX;
      }
      patch({ [activeKey]: next } as Partial<CompNodeData>);
    },
    [sourceNodeId, data, activeKey, patch],
  );

  const patchResample = useCallback(
    (v: CompResampleFilter) => {
      if (!sourceNodeId || !data) return;
      patch({ [activeResampleKey]: v } as Partial<CompNodeData>);
    },
    [sourceNodeId, data, activeResampleKey, patch],
  );

  const patchFilter = useCallback(
    (p: Partial<CompInputFilter>) => {
      if (!sourceNodeId || !data) return;
      const cur = { ...defaultCompFilter(), ...((data[activeFilterKey] as Partial<CompInputFilter> | undefined) ?? {}) };
      patch({ [activeFilterKey]: { ...cur, ...p } } as Partial<CompNodeData>);
    },
    [sourceNodeId, data, activeFilterKey, patch],
  );

  // ── In-comp colour, BG / FG only ──────────────────────────────────────────
  //
  // Same shape as FKEY/patchFilter above: the panel is already scoped to one
  // activeInput, so the colour block is just another per-input key. The alpha
  // and matte tabs have no colour key at all — they are masks.
  const CKEY = { bg: "bgColor", fg: "fgColor" } as const;
  const activeColorKey: "bgColor" | "fgColor" | null =
    activeInput === "bg" || activeInput === "fg" ? CKEY[activeInput] : null;
  // Falls back to the default block for DISPLAY only — reading a default never
  // writes one, so a comp that has no colour block still has none until the user
  // moves something (see normalizeCompLayerColor).
  const activeColor: CompLayerColor = useMemo(
    () => (activeColorKey && data ? normalizeCompLayerColor(data[activeColorKey]) : undefined) ?? defaultCompLayerColor(),
    [activeColorKey, data],
  );

  const patchColor = useCallback(
    (p: Partial<CompLayerColor>) => {
      if (!activeColorKey || !data) return;
      const cur = normalizeCompLayerColor(data[activeColorKey]) ?? defaultCompLayerColor();
      patch({ [activeColorKey]: { ...cur, ...p } } as Partial<CompNodeData>);
    },
    [activeColorKey, data, patch],
  );

  /**
   * Which grade rows are showing their three R/G/B tracks.
   *
   * UI state, so it stays here: it describes how the panel is drawn, not what
   * the comp renders, and putting it in CompNodeData would change every comp's
   * commit signature for a disclosure triangle. Keyed by LAYER because this one
   * panel serves both tabs — BG's split rows must not follow you over to FG.
   *
   * A row also splits on its own whenever its stored value is genuinely
   * per-channel (see the render below), which is what makes arriving at a tab
   * show that layer's real state rather than this map's.
   */
  const [gradeSplit, setGradeSplit] = useState<Record<"bg" | "fg", Partial<Record<GradeKey, boolean>>>>({ bg: {}, fg: {} });
  // ...and it must not outlive the comp it describes. This component is mounted
  // for the app's lifetime (page.tsx) and merely returns null while closed, so
  // without this the flags survive every close: split a row on comp A, open
  // comp B, and B shows three identity tracks nobody asked for. Resetting on
  // `sourceNodeId` covers reopening the same node too (close nulls it), which is
  // what makes a reopened panel show the stored value's real state rather than
  // the state of the last session.
  useEffect(() => { setGradeSplit({ bg: {}, fg: {} }); }, [sourceNodeId]);
  const colorLayer: "bg" | "fg" | null = activeInput === "bg" || activeInput === "fg" ? activeInput : null;

  const toggleGradeSplit = useCallback(
    (key: GradeKey) => {
      if (!colorLayer) return;
      setGradeSplit((s) => ({ ...s, [colorLayer]: { ...s[colorLayer], [key]: !s[colorLayer][key] } }));
    },
    [colorLayer],
  );

  /** One grade row, per channel — the shared control writes a whole
   *  GradeChannelValue, which is the shape that was always stored. */
  const patchGrade = useCallback(
    (key: GradeKey, next: GradeChannelValue) => {
      if (!activeColorKey || !colorLayer || !data) return;
      const cur = normalizeCompLayerColor(data[activeColorKey]) ?? defaultCompLayerColor();
      patch({ [activeColorKey]: { ...cur, grade: { ...cur.grade, [key]: next } } } as Partial<CompNodeData>);
      // Unlinking a row keeps it unlinked even if the three values are dragged
      // back level — otherwise the tracks would vanish mid-edit.
      if (!isMaster(next)) setGradeSplit((s) => ({ ...s, [colorLayer]: { ...s[colorLayer], [key]: true } }));
    },
    [activeColorKey, colorLayer, data, patch],
  );

  // Latest nudge closure (arrow keys move the active transform by whole pixels).
  nudgeRef.current = (dx: number, dy: number) => {
    if (!activeTransform?.enabled) return;
    patchTransform({ hPos: activeTransform.hPos + dx, vPos: activeTransform.vPos + dy });
  };

  // ── FG auto-align, resolved exactly as the renderer resolves it ───────────
  //
  // Same functions, same inputs: the on-canvas handles must describe where the
  // FG actually lands, and the only way to guarantee that is to not compute it
  // a second way. `base` is null when align is off/blocked OR when the BG turns
  // out not to be this crop's source — the un-aligned path, in both cases.
  const fgAlign = useMemo(() => (data ? resolveFgAlign(data) : null), [data]);
  const fgAlignBase: CompAlignBase | null = useMemo(() => {
    if (!fgAlign?.spec || !sizes.fg || !outW || !outH) return null;
    return deriveAlignBase({ ...fgAlign.spec, fgW: sizes.fg.w, fgH: sizes.fg.h, outW, outH });
  }, [fgAlign, sizes.fg, outW, outH]);

  // Aspect mismatch between what came back and the hole it goes into. Silent
  // distortion is the trap panoEditor fell into; this feature says it out loud.
  // Measured against the RECT the renderer uses, not a recomputed one.
  const fgAlignAspect = useMemo(() => {
    if (!fgAlign?.spec || !sizes.fg || !outW || !outH || !sizes.fg.h) return null;
    const rect = alignRectInOutput(fgAlign.spec, outW, outH);
    if (!rect || rect.h <= 0) return null;
    const rectA = rect.w / rect.h, fgA = sizes.fg.w / sizes.fg.h;
    if (Math.abs(fgA / rectA - 1) <= ALIGN_ASPECT_WARN) return null;
    return { fgA, rectA };
  }, [fgAlign, sizes.fg, outW, outH]);

  // Active input placement pieces (for handles). Hidden unless enabled.
  const showHandles = !!(activeTransform?.enabled && activeSize && outW && outH);
  const pieces: CompPieces | null = useMemo(() => {
    if (!showHandles || !data || !activeTransform || !activeSize) return null;
    // The FG's box sits on the aligned placement when align is running, so
    // dragging it moves the patch from where it really is.
    if (activeInput === "fg" && fgAlignBase) return computeAlignedPieces(activeTransform, fgAlignBase, activeSize.w, activeSize.h);
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
  }, [showHandles, data, activeTransform, activeSize, activeInput, sizes.fg, sizes.bg, outW, outH, fgAlignBase]);

  // The scale the user's scaleX/scaleY multiply. A corner drag solves for the
  // TOTAL scale and divides by this to recover the user's delta — so with align
  // running it has to be the align base, or the field would jump on every drag.
  const sx0sy0 = useMemo<[number, number]>(() => {
    if (!data || !activeSize) return [1, 1];
    if (activeInput === "fg") return fgAlignBase ? [fgAlignBase.sX, fgAlignBase.sY] : [1, 1];
    if (activeInput === "bg") return [1, 1];
    if (activeInput === "fgAlpha") return reformatScale(data.fgAlphaReformat, sizes.fg?.w ?? activeSize.w, sizes.fg?.h ?? activeSize.h, activeSize.w, activeSize.h);
    if (activeInput === "bgAlpha") return reformatScale(data.bgAlphaReformat, sizes.bg?.w ?? activeSize.w, sizes.bg?.h ?? activeSize.h, activeSize.w, activeSize.h);
    return reformatScale(data.matteReformat, sizes.bg?.w ?? outW, sizes.bg?.h ?? outH, activeSize.w, activeSize.h);
  }, [data, activeSize, activeInput, sizes.fg, sizes.bg, outW, outH, fgAlignBase]);

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
  // Press on empty canvas (not the box / a handle) starts a view pan.
  const onStageDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.target !== stageRef.current) return;
    const p = stageRef.current?.getPointerPosition();
    if (!p) return;
    panRef.current = { start: { x: p.x, y: p.y }, startPos: { x: position.x, y: position.y } };
  };
  const onStageMove = () => {
    // View pan takes precedence over a layer-transform drag.
    if (panRef.current) {
      const p = stageRef.current?.getPointerPosition();
      if (!p) return;
      setPosition({
        x: panRef.current.startPos.x + (p.x - panRef.current.start.x),
        y: panRef.current.startPos.y + (p.y - panRef.current.start.y),
      });
      return;
    }
    const d = translateRef.current;
    if (!d) return;
    const p = stagePosBL();
    patchTransform({ hPos: d.startH + (p.x - d.startPL.x), vPos: d.startV + (p.y - d.startPL.y) });
  };
  const endTranslate = () => { translateRef.current = null; panRef.current = null; };
  // Inverse rotation Rᵀ applied to a vector
  const invRot = (p: Pt, c: Pt): Pt => {
    if (!pieces) return p;
    const [cos, sin] = pieces.rot;
    const dx = p.x - c.x, dy = p.y - c.y;
    return { x: cos * dx + sin * dy, y: -sin * dx + cos * dy };
  };

  const hpx = (v: number) => v / scale;

  /**
   * Apply: the draft's parameters and the freshly rendered output land in ONE
   * write, so an editing session costs a single undo step rather than one per
   * slider.
   */
  const handleDone = useCallback(async () => {
    if (!sourceNodeId || !data || !data.bgImage) { closeModal(); return; }
    setBusy(true);
    try {
      const urls = { bg: data.bgImage, bgAlpha: data.bgAlphaImage, fg: data.fgImage, fgAlpha: data.fgAlphaImage, matte: data.matteImage };
      const res = await renderComp(buildCompInputs(urls, srcs), buildCompParams(data), sourceNodeId);
      if (res) {
        const url = (await floatNodeToDataUrl(sourceNodeId)) ?? data.bgImage;
        updateNodeData(sourceNodeId, { ...draft, outputImage: url, outputImageRef: undefined, outputWidth: res.w, outputHeight: res.h });
      } else {
        const { dataUrl, outW: w, outH: h } = await compositeCompForExecutor(urls, srcs, data, sourceNodeId);
        if (dataUrl) updateNodeData(sourceNodeId, { ...draft, outputImage: dataUrl, outputImageRef: undefined, outputWidth: w, outputHeight: h });
        else updateNodeData(sourceNodeId, draft);
      }
    } finally { setBusy(false); closeModal(); }
  }, [sourceNodeId, data, draft, srcs, updateNodeData, closeModal]);

  /**
   * Cancel: drop the draft, and undo what the settle-commit published.
   *
   * Discarding the draft is not enough on its own. While you edit, the commit
   * effect above writes a real composite into `outputImage` and propagates it,
   * so the edited picture is already downstream. Restoring the baseline puts the
   * committed output and its signature back; `releaseColorNode` drops the edited
   * float texture, without which CompNode's republish-only guard
   * (`republishOnly && hasFloat(id)`) would go on serving the edited composite
   * from GPU memory. With the texture gone that guard falls through to a real
   * render from the restored parameters, and still skips the full-res PNG encode
   * because the restored signature matches.
   */
  const handleCancel = useCallback(() => {
    const dirty = Object.keys(draft).length > 0;
    if (sourceNodeId && baseline && dirty) {
      updateNodeData(sourceNodeId, { ...baseline } as Partial<CompNodeData>);
      releaseColorNode(sourceNodeId);
      void propagateFromNode(sourceNodeId);
    }
    closeModal();
  }, [sourceNodeId, draft, baseline, updateNodeData, propagateFromNode, closeModal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModalOpen) return;
      if (e.key === "Escape") {
        // The grade wheel popover is portaled to document.body — outside this
        // modal's React tree — and binds Escape on `window` to close itself.
        // Both listeners are on window and neither can reliably silence the
        // other, so without this guard one Escape would close the wheel AND
        // cancel the editor, discarding the whole draft. While the popover is
        // up, Escape is its; the element is removed on the re-render that
        // follows, so the next Escape reaches Cancel.
        if (document.getElementById(GRADE_WHEEL_POP_ID)) return;
        handleCancel();
        return;
      }
      // Arrow keys nudge the active transform — ignore while typing in a field.
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT")) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0; // vPos+ = up
        e.preventDefault();
        nudgeRef.current(dx, dy);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isModalOpen, handleCancel]);

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

  // Solve the TOTAL scale that puts source pixel `s` under the cursor, given
  // that the image scales about the pivot: R^-1 (P - c) = (s - k) .* S.
  // Divided by sx0sy0 to recover the user's delta over the reformat/align base.
  //
  // The lever arm is measured from the PIVOT, not from the image origin. With a
  // centred pivot dragging the top-right corner now moves it half as far per
  // unit of scale as it used to, because the opposite corner travels outward
  // too — which is the visible half of scaling about the centre.
  const solveScale = (P: Pt, sx: number, sy: number, axis?: "x" | "y") => {
    if (!pieces) return;
    const rel = invRot(P, { x: pieces.c[0], y: pieces.c[1] });
    const dx = sx - pieces.k[0];
    const dy = sy - pieces.k[1];
    // A pivot sitting exactly on the handle gives no lever arm; leave that axis
    // alone rather than dividing by zero and blowing the transform away.
    const next: { scaleX?: number; scaleY?: number } = {};
    if (axis !== "y" && dx !== 0 && sx0sy0[0]) next.scaleX = rel.x / dx / sx0sy0[0];
    if (axis !== "x" && dy !== 0 && sx0sy0[1]) next.scaleY = rel.y / dy / sx0sy0[1];
    if (next.scaleX !== undefined || next.scaleY !== undefined) patchTransform(next);
  };
  const applyScaleFromCorner = (P: Pt) => solveScale(P, iw, ih);
  const applyScaleAxis = (P: Pt, axis: "x" | "y") =>
    axis === "x" ? solveScale(P, iw, ih / 2, "x") : solveScale(P, iw / 2, ih, "y");
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
            <select value={data.mergeOp} onChange={(e) => patch({ mergeOp: e.target.value as CompMergeOp })} className="bg-neutral-800 text-white text-[11px] rounded px-1.5 py-1 outline-none border border-neutral-700">
              {COMP_OP_LABELS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </select>
          </label>
          <div className="w-px h-6 bg-neutral-700 mx-2" />
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer" title="Multiply the FG's RGB by its alpha before compositing">
            <input type="checkbox" checked={data.premultiplyFg ?? false} onChange={(e) => patch({ premultiplyFg: e.target.checked })} className="accent-teal-500" />
            Premultiply FG
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer ml-2" title="Multiply the BG's RGB by its alpha before compositing">
            <input type="checkbox" checked={data.premultiplyBg ?? false} onChange={(e) => patch({ premultiplyBg: e.target.checked })} className="accent-teal-500" />
            Premultiply BG
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer ml-2" title="Swap the BG and FG layers (and their alphas) in the merge">
            <input type="checkbox" checked={data.swapBgFg ?? false} onChange={(e) => patch({ swapBgFg: e.target.checked })} className="accent-teal-500" />
            Swap BG/FG
          </label>
          <div className="w-px h-6 bg-neutral-700 mx-2" />
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-400" title="Which input's resolution defines the output">
            Output res
            <select value={data.outputResolution ?? "bg"} onChange={(e) => patch({ outputResolution: e.target.value as "bg" | "fg" })} className="bg-neutral-800 text-white text-[11px] rounded px-1.5 py-1 outline-none border border-neutral-700">
              <option value="bg">BG</option>
              <option value="fg">FG</option>
            </select>
          </label>
          <div className="w-px h-6 bg-neutral-700 mx-2" />
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer" title="Show transparent pixels as a checkerboard instead of black">
            <input type="checkbox" checked={data.checkerboard ?? false} onChange={(e) => patch({ checkerboard: e.target.checked })} className="accent-teal-500" />
            Checkerboard
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={handleCancel} className="px-4 py-1.5 text-xs font-medium text-neutral-400 hover:text-white">Cancel</button>
          <button onClick={handleDone} disabled={busy} className="px-4 py-1.5 text-xs font-medium bg-white text-neutral-900 rounded hover:bg-neutral-200 disabled:opacity-60">{busy ? "…" : "Done"}</button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div ref={containerRef} className="relative flex-1 overflow-hidden bg-neutral-900">
          <DockedViewer />
          {data.bgImage && offscreen ? (
            <Stage ref={stageRef} width={stageSize.width} height={stageSize.height} scaleX={scale} scaleY={scale} x={position.x} y={position.y} onWheel={handleWheel} onMouseDown={onStageDown} onMouseMove={onStageMove} onMouseUp={endTranslate} onMouseLeave={endTranslate}>
              <Layer listening={false}>
                {/* transparency backdrop: solid black, or checkerboard if enabled */}
                {data.checkerboard && checkerTile
                  ? <Rect x={0} y={0} width={outW} height={outH} fillPatternImage={checkerTile as unknown as HTMLImageElement} fillPatternRepeat="repeat" />
                  : <Rect x={0} y={0} width={outW} height={outH} fill="#000" />}
                {/* Laid out at the ROI the preview actually rendered, so the
                    sub-rect lands in the right place on the full-size frame.
                    Falls back to the whole frame (Canvas2D fallback path). */}
                <KonvaImage
                  ref={imageNodeRef}
                  image={offscreen}
                  x={renderedRoi?.x ?? 0}
                  y={renderedRoi?.y ?? 0}
                  width={renderedRoi?.w ?? outW}
                  height={renderedRoi?.h ?? outH}
                />
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
                      onDragMove={(e) => {
                        if (!pieces || !pieces.sX || !pieces.sY) return;
                        const P = targetBL(e);
                        // Put the pivot under the cursor. The pivot's output
                        // position is k * base + translate, so the source pixel
                        // that lands on P is k + (P - c) / base.
                        //
                        // Base scale, NOT the total: the pivot is the point the
                        // user scale turns about, so it must not itself move
                        // with that scale — that coupling is what stopped the
                        // centre affecting scale at all.
                        if (!sx0sy0[0] || !sx0sy0[1]) return;
                        patchTransform({
                          centerAuto: false,
                          centerX: pieces.k[0] + (P.x - pieces.c[0]) / sx0sy0[0],
                          centerY: pieces.k[1] + (P.y - pieces.c[1]) / sx0sy0[1],
                        });
                      }}
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
                  onChange={(e) => patch(activeInput === "bg" ? { bgBlackOutside: e.target.checked } : { fgBlackOutside: e.target.checked })}
                  className="accent-teal-500"
                />
                Black outside
              </label>
            )}

            {/* Per-layer opacity — BG & FG only */}
            {(activeInput === "bg" || activeInput === "fg") && (
              <div className="flex items-center gap-2" title="Fade this layer toward transparent before the merge">
                <label className="text-[11px] text-neutral-400 w-[64px] shrink-0">Opacity</label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={(activeInput === "bg" ? data.bgOpacity : data.fgOpacity) ?? 1}
                  onChange={(e) => patch(activeInput === "bg" ? { bgOpacity: parseFloat(e.target.value) } : { fgOpacity: parseFloat(e.target.value) })}
                  className="nodrag flex-1 accent-teal-500"
                />
                <span className="text-[10px] text-neutral-400 w-9 text-right tabular-nums">
                  {Math.round(((activeInput === "bg" ? data.bgOpacity : data.fgOpacity) ?? 1) * 100)}%
                </span>
              </div>
            )}

            {/* FG edge softness — feathers the FG's COVERAGE (the footprint
                rectangle), which is the seam a composited-back patch shows.
                Nothing to do with the Blur below: that one blurs the FG's
                CONTENT in source space and leaves the edge exactly as hard. */}
            {activeInput === "fg" && (() => {
              // Both gates the shader/compUniforms apply, mirrored so a knob that
              // cannot do anything says why instead of just sitting there.
              const noEdge = !(data.fgBlackOutside ?? true);
              const alphaPinned = !!srcs.faSrc || !!data.fgAlphaImage;
              const inert = noEdge || alphaPinned;
              const soft = data.fgSoftness ?? 0;
              return (
                <div className="flex flex-col gap-1.5">
                  <div
                    className={`flex items-center gap-2 ${inert ? "opacity-50" : ""}`}
                    title="Feather the FG's coverage inward from its footprint edge, in OUTPUT pixels — the fix for a composited-back patch landing as a hard rectangle. A Matte does NOT disable this: the matte limits the finished merge, it is not the FG's coverage."
                  >
                    <label className="text-[11px] text-neutral-400 w-[64px] shrink-0">Softness</label>
                    <input
                      type="range" min={0} max={200} step={1} disabled={inert}
                      value={Math.min(200, soft)}
                      onChange={(e) => patch({ fgSoftness: parseFloat(e.target.value) })}
                      className="nodrag flex-1 min-w-0 accent-teal-500"
                    />
                    <input
                      type="number" min={0} step={1} disabled={inert}
                      value={Number(soft.toFixed(2))}
                      onChange={(e) => patch({ fgSoftness: Math.max(0, parseFloat(e.target.value) || 0) })}
                      className="nodrag w-14 shrink-0 text-[10px] py-1 px-1.5 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700"
                    />
                  </div>
                  {inert && (
                    <div className="text-[10px] text-neutral-500 leading-snug">
                      {noEdge
                        ? "Needs Black outside — with it off the FG covers the whole frame, so there is no footprint edge to feather."
                        : "An FG α input is connected, and it replaces the FG's coverage entirely — feather that matte instead."}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* FG auto-align — crop → generate → composite back. Sits above the
                transform block because it composes UNDERNEATH it: the fields
                below stay the user's own offsets on top of this placement. */}
            {activeInput === "fg" && (
              <div className="flex flex-col gap-1.5 pb-2 border-b border-neutral-800">
                <label
                  className={`flex items-center gap-2 text-[11px] ${fgAlign?.blocked ? "text-neutral-500 cursor-not-allowed" : "text-neutral-300 cursor-pointer"}`}
                  title="Drop the FG back onto the region its crop metadata came from, at whatever resolution the generator returned. Composes under the transform below — your H/V/Scale stay a delta on top of it."
                >
                  <input
                    type="checkbox"
                    disabled={!!fgAlign?.blocked}
                    checked={(data.fgAlign ?? "auto") === "auto"}
                    onChange={(e) => patch({ fgAlign: e.target.checked ? "auto" : "off" })}
                    className="accent-teal-500"
                  />
                  Auto-align from crop
                </label>
                {/* A disabled control with no stated reason is the thing this
                    feature is not allowed to ship — but "nothing on the pin" is
                    the resting state of EVERY comp that has nothing to do with
                    cropping, and the FG tab is the one the editor opens on. Amber
                    there would put a warning in front of every comp on the canvas
                    forever, which is how people learn to stop reading warnings.
                    Neutral for the resting state, amber only for a setting of the
                    user's that is actively fighting the feature. */}
                {fgAlign?.blocked && (
                  <div className={`text-[10px] leading-snug ${fgAlign.meta ? "text-amber-500/90" : "text-neutral-500"}`}>
                    {fgAlign.blocked}
                  </div>
                )}
                {!fgAlign?.blocked && (data.fgAlign ?? "auto") === "auto" && (
                  <>
                    <div className="flex items-center gap-1.5" title="How a generated FG whose aspect no longer matches the crop rect fills it">
                      <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">Fit</label>
                      <select
                        value={data.fgAlignFit ?? "fit"}
                        onChange={(e) => patch({ fgAlignFit: e.target.value as CompAlignFit })}
                        className="nodrag flex-1 min-w-0 text-[10px] py-1 px-1.5 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700"
                      >
                        {ALIGN_FITS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
                      </select>
                    </div>
                    {sizes.fg && !fgAlignBase && (
                      <div className="text-[10px] text-amber-500/90 leading-snug">
                        The BG is not this crop&apos;s source (its aspect differs) — the FG is placed un-aligned.
                      </div>
                    )}
                    {fgAlignAspect && (
                      <div className="text-[10px] text-amber-400 leading-snug">
                        FG aspect {fgAlignAspect.fgA.toFixed(3)} ≠ crop aspect {fgAlignAspect.rectA.toFixed(3)}.{" "}
                        {(data.fgAlignFit ?? "fit") === "stretch"
                          ? "Stretch distorts the patch."
                          : (data.fgAlignFit ?? "fit") === "fill"
                            ? "Fill overhangs the crop rect."
                            : "Fit leaves the BG showing in the slack."}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            <label className="flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer">
              <input type="checkbox" checked={activeTransform?.enabled ?? false} onChange={(e) => patchTransform({ enabled: e.target.checked })} className="accent-teal-500" />
              {followsLabel ? (activeTransform?.enabled ? "Transform independently" : `Follow ${followsLabel}`) : "Enable transform"}
            </label>
            {followsLabel && !activeTransform?.enabled && (
              <div className="text-[10px] text-neutral-500 leading-snug">Following the {followsLabel} transform. Enable to move it independently.</div>
            )}

            {/* The placement auto-align derived, read-only. Align composes
                underneath rather than writing into fgTransform, so the fields
                below are the user's DELTA — the base has to be visible
                somewhere or those numbers describe nothing they can see.
                OUTSIDE the block below on purpose: that block dims on
                `fgTransform.enabled`, which defaults to FALSE and only gates the
                editor's own fields and handles — the shader applies fgTransform
                (and this base) either way. Dimmed, it would read as "align is
                off" at exactly the moment align is doing all the work. */}
            {activeInput === "fg" && fgAlignBase && (
              <div className="text-[10px] text-teal-400/90 tabular-nums leading-snug" title="Derived from the crop metadata. The transform fields below are your offsets on top of it.">
                Auto: {fmtSigned(fgAlignBase.hPos)}, {fmtSigned(fgAlignBase.vPos)} · {fgAlignBase.sX.toFixed(3)}×{fgAlignBase.sY.toFixed(3)}
              </div>
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
                  <input type="checkbox" checked={activeTransform?.centerAuto ?? true} onChange={(e) => {
              if (e.target.checked) patchTransform({ centerAuto: true });
              // Seed the manual pivot at the image centre (source px) so toggling
              // off doesn't jump it to a stale/corner value.
              else patchTransform({ centerAuto: false, centerX: (activeSize?.w ?? 0) / 2, centerY: (activeSize?.h ?? 0) / 2 });
            }} className="accent-teal-500" />
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
                    patch(activeInput === "bgAlpha" ? { bgAlphaReformat: v } : activeInput === "fgAlpha" ? { fgAlphaReformat: v } : { matteReformat: v });
                  }}
                  className="nodrag flex-1 min-w-0 text-[10px] py-1 px-1.5 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700"
                >
                  {REFORMATS.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
                </select>
              </div>
            )}
            {/* Reconstruction filter: which kernel rebuilds this input when the
                transform resamples it. Only bites under scale/rotation/sub-pixel
                translation — at identity every option is a passthrough. */}
            <div className="flex flex-col gap-1.5 mt-1 pt-2 border-t border-neutral-800">
              <div
                className="flex items-center gap-1.5"
                title="Reconstruction filter used while TRANSFORMING this input (scale/rotate/sub-pixel move). Impulse is nearest; Bilinear is the old behaviour; Mitchell is a balanced default; Lanczos is sharpest but rings."
              >
                <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">Filter</label>
                <select
                  value={activeResample}
                  onChange={(e) => patchResample(e.target.value as CompResampleFilter)}
                  className="nodrag flex-1 min-w-0 text-[10px] py-1 px-1.5 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700"
                >
                  {COMP_RESAMPLE_FILTERS.map((f) => (
                    <option key={f} value={f}>{COMP_RESAMPLE_LABELS[f]}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Blur/defocus applied AFTER sampling — a different thing from the
                Filter above, which is why it is no longer called "Filter". */}
            <div className="flex flex-col gap-1.5 mt-1 pt-2 border-t border-neutral-800">
              <div className="flex items-center gap-1.5" title="Blur/defocus this input before the merge (float-preserving GPU pre-pass)">
                <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">Blur</label>
                <select
                  value={activeFilter.filter}
                  onChange={(e) => patchFilter({ filter: e.target.value as BlurFilterType | "none" })}
                  className="nodrag flex-1 min-w-0 text-[10px] py-1 px-1.5 bg-[#1a1a1a] rounded text-white outline-none border border-neutral-700"
                >
                  {FILTERS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
                </select>
              </div>
              {activeFilter.filter !== "none" && (
                <>
                  <div className="flex items-center gap-1.5">
                    <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">Amount</label>
                    <input
                      type="range" min={0} max={100} step={1} value={activeFilter.radius}
                      onChange={(e) => patchFilter({ radius: parseFloat(e.target.value) })}
                      className="nodrag flex-1 accent-teal-500"
                    />
                    <span className="text-[10px] text-neutral-400 w-9 text-right tabular-nums">{Math.round(activeFilter.radius)}px</span>
                  </div>
                  {activeFilter.filter === "motion" && (
                    <div className="flex items-center gap-1.5">
                      <label className="text-[10px] text-neutral-400 w-[64px] shrink-0">Angle</label>
                      <input
                        type="range" min={0} max={360} step={1} value={activeFilter.angle}
                        onChange={(e) => patchFilter({ angle: parseFloat(e.target.value) })}
                        className="nodrag flex-1 accent-teal-500"
                      />
                      <span className="text-[10px] text-neutral-400 w-9 text-right tabular-nums">{Math.round(activeFilter.angle)}°</span>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ── Colour correction, this layer only (BG / FG) ──────────────
                Runs on the plate's OWN pixels, before the Blur above and before
                the transform samples it — a grade contains a pow and a hue shift
                wraps, and neither commutes with a resample. Enable-checkbox
                reveals its rows; there is no accordion primitive in this app and
                this panel is not the place to invent one. */}
            {activeColorKey && (
              <>
                <div className="flex flex-col gap-1.5 mt-1 pt-2 border-t border-neutral-800">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      className="flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer"
                      title="Nuke-style Grade on this layer alone, applied to the source pixels BEFORE the Blur and the transform. Same shader as the Color Grade node, so it matches one wired upstream."
                    >
                      <input type="checkbox" checked={activeColor.gradeEnabled} onChange={(e) => patchColor({ gradeEnabled: e.target.checked })} className="accent-teal-500" />
                      Grade {activeInput === "bg" ? "BG" : "FG"}
                    </label>
                    {activeColor.gradeEnabled && (
                      <button
                        onClick={() => {
                          patchColor({ grade: normalizeCompGrade(undefined) });
                          // The rows are back at identity, so the split tracks
                          // have nothing left to show.
                          if (colorLayer) setGradeSplit((s) => ({ ...s, [colorLayer]: {} }));
                        }}
                        className="text-[10px] text-neutral-500 hover:text-white shrink-0"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  {/* The standalone Grade control, verbatim: master or split
                      R/G/B tracks, swatch and colour wheel. `labelWidth` only
                      lines its label column up with this panel's other rows, and
                      the wrapper keeps the rows flush against their own dividers
                      instead of inheriting this column's gap. */}
                  {activeColor.gradeEnabled && colorLayer && (
                    <div>
                      {GRADE_SLIDERS.map((s) => {
                        const v = activeColor.grade[s.key];
                        return (
                          <GradeRow
                            key={s.key}
                            def={s}
                            value={v}
                            expanded={!!gradeSplit[colorLayer][s.key] || !isMaster(v)}
                            onChange={(next) => patchGrade(s.key, next)}
                            onToggleExpanded={() => toggleGradeSplit(s.key)}
                            labelWidth={64}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-1.5 mt-1 pt-2 border-t border-neutral-800">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      className="flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer"
                      title="Hue / saturation / value on this layer alone, applied AFTER the Grade above and still before the Blur and the transform. Same shader as the HSV Correct node."
                    >
                      <input type="checkbox" checked={activeColor.hsvEnabled} onChange={(e) => patchColor({ hsvEnabled: e.target.checked })} className="accent-teal-500" />
                      HSV {activeInput === "bg" ? "BG" : "FG"}
                    </label>
                    {activeColor.hsvEnabled && (
                      <button
                        onClick={() => patchColor({ hueShift: 0, saturation: 1, value: 1 })}
                        className="text-[10px] text-neutral-500 hover:text-white shrink-0"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  {activeColor.hsvEnabled && HSV_ROWS.map((r) => (
                    <ColorRow key={r.key} def={r} value={activeColor[r.key]} onChange={(v) => patchColor({ [r.key]: v } as Partial<CompLayerColor>)} />
                  ))}
                </div>

                {/* Clamps ride on whichever pass runs, so they are only offered
                    once one does — with both blocks off there is no pass to
                    clamp in, and colorIntoUnlocked allocates nothing. */}
                {(activeColor.gradeEnabled || activeColor.hsvEnabled) && (
                  <div
                    className="flex items-center gap-3 flex-wrap"
                    title="Off by default: the Comp is a float node, so its output stays unclamped for the rest of the colour chain. Turn these on only to deliberately crush sub-blacks / super-whites in this layer."
                  >
                    <label className="flex items-center gap-1.5 text-[10px] text-neutral-400 cursor-pointer">
                      <input type="checkbox" checked={activeColor.clampLow} onChange={(e) => patchColor({ clampLow: e.target.checked })} className="accent-teal-500" />
                      Clamp blacks
                    </label>
                    <label className="flex items-center gap-1.5 text-[10px] text-neutral-400 cursor-pointer">
                      <input type="checkbox" checked={activeColor.clampHigh} onChange={(e) => patchColor({ clampHigh: e.target.checked })} className="accent-teal-500" />
                      Clamp whites
                    </label>
                  </div>
                )}
              </>
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
