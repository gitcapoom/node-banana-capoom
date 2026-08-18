"use client";

import { useCallback, useEffect, type CSSProperties } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { useCompStore } from "@/store/compStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { releaseColorNode, renderComp, floatNodeToDataUrl, floatNodeToThumbDataUrl, hasFloat } from "@/utils/colorChain";
import { createImageThumbnailWithMeta, thumbMaxDim } from "@/utils/createImageThumbnail";
import { buildCompInputs, buildCompParams, compositeCompForExecutor } from "@/utils/compComposite";
import { cheapUrlKey, RenderSignatureCache } from "@/utils/renderSignature";
import { compPinToken, compCommitSignature } from "@/utils/compSignature";
import type { CompNodeData } from "@/types";

type CompNodeType = Node<CompNodeData, "comp">;

/** Last committed composite per node — survives viewport-culling remounts. */
const committedComps = new RenderSignatureCache();

const CHECKER_STYLE: CSSProperties = {
  backgroundColor: "#454545",
  backgroundImage:
    "linear-gradient(45deg, #5e5e5e 25%, transparent 25%, transparent 75%, #5e5e5e 75%, #5e5e5e), linear-gradient(45deg, #5e5e5e 25%, transparent 25%, transparent 75%, #5e5e5e 75%, #5e5e5e)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
};

const INPUT_HANDLES: Array<{ id: string; label: string; top: string; color: string }> = [
  { id: "image-comp_bg", label: "BG", top: "16%", color: "#2dd4bf" },
  { id: "image-comp_bg_alpha", label: "BG α", top: "32%", color: "#a3a3a3" },
  { id: "image-comp_fg", label: "FG", top: "50%", color: "#38bdf8" },
  { id: "image-comp_fg_alpha", label: "FG α", top: "68%", color: "#a3a3a3" },
  { id: "image-comp_matte", label: "Matte", top: "84%", color: "#a3a3a3" },
];

export function CompNode({ id, data, selected }: NodeProps<CompNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const loadNodeFullResInputs = useWorkflowStore((s) => s.loadNodeFullResInputs);
  const openModal = useCompStore((s) => s.openModal);
  const modalOpenForThis = useCompStore((s) => s.isModalOpen && s.sourceNodeId === id);

  // Resolve the 4 inputs (url + producing node id) by targetHandle.
  const incoming = useWorkflowStore(
    useShallow((state) => {
      const r = {
        bg: null as string | null, bgAlpha: null as string | null, fg: null as string | null, fgAlpha: null as string | null, matte: null as string | null,
        bgSrc: null as string | null, baSrc: null as string | null, fgSrc: null as string | null, faSrc: null as string | null, mtSrc: null as string | null,
        // Load-boundary-stable token per pin (ref when saved, url key otherwise).
        // Computed HERE so the shallow compare stays on strings — returning the
        // source node objects would re-render on any upstream data change.
        bgTok: "-", baTok: "-", fgTok: "-", faTok: "-", mtTok: "-",
        // Whether each pin has an incoming EDGE (independent of whether the
        // upstream value is loaded yet — lazy inputs are null until loaded).
        bgConn: false, baConn: false, fgConn: false, faConn: false, mtConn: false,
      };
      for (const e of state.edges) {
        if (e.target !== id) continue;
        if (e.targetHandle === "image-comp_bg") r.bgConn = true;
        else if (e.targetHandle === "image-comp_bg_alpha") r.baConn = true;
        else if (e.targetHandle === "image-comp_fg") r.fgConn = true;
        else if (e.targetHandle === "image-comp_fg_alpha") r.faConn = true;
        else if (e.targetHandle === "image-comp_matte") r.mtConn = true;
        const src = state.nodes.find((n) => n.id === e.source);
        if (!src) continue;
        const out = getSourceOutput(src, e.sourceHandle, e.data as Record<string, unknown> | undefined);
        if (out.type !== "image") continue;
        // The token must be recorded even when the VALUE is lazily null — that is
        // the whole point: on open the ref is present and the pixels are not, and
        // the signature has to be the same either way.
        const tok = compPinToken(src, out.value);
        if (!out.value) {
          if (e.targetHandle === "image-comp_bg") { r.bgSrc = src.id; r.bgTok = tok; }
          else if (e.targetHandle === "image-comp_bg_alpha") { r.baSrc = src.id; r.baTok = tok; }
          else if (e.targetHandle === "image-comp_fg") { r.fgSrc = src.id; r.fgTok = tok; }
          else if (e.targetHandle === "image-comp_fg_alpha") { r.faSrc = src.id; r.faTok = tok; }
          else if (e.targetHandle === "image-comp_matte") { r.mtSrc = src.id; r.mtTok = tok; }
          continue;
        }
        if (e.targetHandle === "image-comp_bg") { r.bg = out.value; r.bgSrc = src.id; r.bgTok = tok; }
        else if (e.targetHandle === "image-comp_bg_alpha") { r.bgAlpha = out.value; r.baSrc = src.id; r.baTok = tok; }
        else if (e.targetHandle === "image-comp_fg") { r.fg = out.value; r.fgSrc = src.id; r.fgTok = tok; }
        else if (e.targetHandle === "image-comp_fg_alpha") { r.fgAlpha = out.value; r.faSrc = src.id; r.faTok = tok; }
        else if (e.targetHandle === "image-comp_matte") { r.matte = out.value; r.mtSrc = src.id; r.mtTok = tok; }
      }
      return r;
    }),
  );

  // Every CONNECTED pin must have a loaded value before we render/commit. Else a
  // lazily-unloaded matte / alpha pin (e.g. a roto matte) would be silently
  // dropped and the composite would come out opaque.
  const allInputsResolved =
    (!incoming.bgConn || !!incoming.bg) &&
    (!incoming.baConn || !!incoming.bgAlpha) &&
    (!incoming.fgConn || !!incoming.fg) &&
    (!incoming.faConn || !!incoming.fgAlpha) &&
    (!incoming.mtConn || !!incoming.matte);

  // Mirror resolved inputs into node data (guarded against loops).
  useEffect(() => {
    const patch: Partial<CompNodeData> = {};
    if (incoming.bg !== nodeData.bgImage) { patch.bgImage = incoming.bg; patch.bgImageRef = undefined; }
    if (incoming.bgAlpha !== nodeData.bgAlphaImage) { patch.bgAlphaImage = incoming.bgAlpha; patch.bgAlphaImageRef = undefined; }
    if (incoming.fg !== nodeData.fgImage) { patch.fgImage = incoming.fg; patch.fgImageRef = undefined; }
    if (incoming.fgAlpha !== nodeData.fgAlphaImage) { patch.fgAlphaImage = incoming.fgAlpha; patch.fgAlphaImageRef = undefined; }
    if (incoming.matte !== nodeData.matteImage) { patch.matteImage = incoming.matte; patch.matteImageRef = undefined; }
    if (Object.keys(patch).length) updateNodeData(id, patch);
  }, [incoming, nodeData.bgImage, nodeData.bgAlphaImage, nodeData.fgImage, nodeData.fgAlphaImage, nodeData.matteImage, id, updateNodeData]);

  // Live preview + commit whenever inputs/params change. The input URLs are
  // full-res data URLs (tens of MB each), so they go in by CHEAP KEY — a raw
  // JSON.stringify of five of them would copy every image on every render.
  // MUST come from compCommitSignature — the same function the executor and the
  // save-time restamp use. Building a bespoke object here is exactly the bug that
  // made `nodeData.compCommitSig === sig` unmatchable: two different
  // serialisations of the same facts, so the persisted signature never hit and
  // every comp re-composited on every open.
  const sig = compCommitSignature(nodeData as unknown as Record<string, unknown>, {
    bg: { srcId: incoming.bgSrc, token: incoming.bgTok },
    bgAlpha: { srcId: incoming.baSrc, token: incoming.baTok },
    fg: { srcId: incoming.fgSrc, token: incoming.fgTok },
    fgAlpha: { srcId: incoming.faSrc, token: incoming.faTok },
    matte: { srcId: incoming.mtSrc, token: incoming.mtTok },
  });

  useEffect(() => {
    if (modalOpenForThis) return; // editor owns rendering while open
    let cancelled = false;
    // Scrolled back into view with nothing changed: republish the float texture
    // for downstream chaining, but skip the PNG encode and the store write —
    // they would reproduce byte-identical output.
    // First sight of this node in this page session: it already carries an
    // output from the save, produced from these same inputs (a load restores
    // both sides together), so adopt the current signature instead of
    // recomputing it. Without this the guard below could never fire on a fresh
    // load — `outputImage` is lazily null until something hydrates it — and
    // every comp that mounted, or re-mounted as viewport culling moved over it,
    // took the full path and flattened its float texture to a full-res PNG.
    // Measured on the real graph: 6554x3686 encodes at 1.0-1.8s each, three of
    // them for one node drag, 11.3s of blocked main thread.
    // The old adoption block adopted whatever signature happened to be current at
    // first mount — which on open is the all-null form, since every input is
    // lazily unloaded. That describes the one state guaranteed not to persist, so
    // the guard missed the instant anything hydrated. It is gone; the persisted
    // signature below does the job properly.
    //
    // Accept EITHER source of truth: `compCommitSig` is what the save recorded
    // (pin tokens in their `r:<ref>` form), while the session cache may hold the
    // `u:<url>` form from a commit that has not been saved yet. Requiring only the
    // persisted one would re-composite everything right after each autosave.
    const republishOnly =
      (committedComps.matches(id, sig) || nodeData.compCommitSig === sig) &&
      !!(nodeData.outputImage || nodeData.outputImageThumb);
    const urls = { bg: incoming.bg, bgAlpha: incoming.bgAlpha, fg: incoming.fg, fgAlpha: incoming.fgAlpha, matte: incoming.matte };
    const srcs = { bgSrc: incoming.bgSrc, baSrc: incoming.baSrc, fgSrc: incoming.fgSrc, faSrc: incoming.faSrc, mtSrc: incoming.mtSrc };
    const run = async () => {
      // NO BG EDGE vs BG EDGE NOT YET LOADED are different situations and were
      // being conflated. With lazy loading `urls.bg` is null on open for a pin
      // that IS connected, so clearing here destroyed a perfectly good saved
      // output. Only an actually-disconnected pin should clear it; the
      // unloaded case falls through to the hydrate branch below.
      if (!incoming.bgConn) {
        if (nodeData.outputImage !== null) updateNodeData(id, { outputImage: null, outputImageRef: undefined });
        return;
      }
      if (!urls.bg || !allInputsResolved) {
        // A connected pin is lazily unloaded — load the inputs and wait.
        // Rendering now would drop it and flatten the output to opaque.
        void loadNodeFullResInputs(id);
        return;
      }
      // GUARD BEFORE THE WORK. This used to sit after renderComp, so every
      // viewport-culling remount paid a full 5-input decode + 5x96.6MB upload +
      // 24MP composite to produce something it then threw away; only the PNG
      // encode was skipped. The fallback branch below already had the check in
      // the right place — this makes the float branch agree with it.
      //
      // Consequence worth knowing: skipping renderComp also skips republishing
      // this node's float texture, so a downstream comp chains through the 8-bit
      // outputImage until something genuinely re-renders. The COMMITTED output is
      // unaffected — only a full-res float render ever writes it.
      if (republishOnly && hasFloat(id)) return;

      // Render OFFSCREEN into this node's float texture — the node body shows
      // the committed thumbnail, not a live canvas, so nothing has to be
      // blitted per mount as the node scrolls in and out of view.
      const res = await renderComp(buildCompInputs(urls, srcs), buildCompParams(nodeData), id);
      if (cancelled) return;
      if (res) {
        // Float texture republished — that's all a re-entry needs.
        if (republishOnly) return;
        const url = await floatNodeToDataUrl(id);
        if (!cancelled && url && url !== nodeData.outputImage) {
          committedComps.set(id, sig);
          updateNodeData(id, {
            outputImage: url,
            outputImageRef: undefined,
            compCommitSig: sig,
            outputWidth: res.w,
            outputHeight: res.h,
            outputImageDims: { width: res.w, height: res.h },
          });
        }
      } else {
        // Check BEFORE compositing, not after. compositeCompForExecutor does the
        // whole composite and flattens it to a full-res PNG itself, so testing
        // the guard on its result meant every remount paid for an image it was
        // about to throw away — 6554x3686 encodes at ~0.8-1.0s each. This is the
        // non-float fallback path, so it ran whenever EXT_color_buffer_float was
        // unavailable, which is exactly when the machine can least afford it.
        if (republishOnly) return;
        const { dataUrl, outW, outH } = await compositeCompForExecutor(urls, srcs, nodeData, id);
        if (cancelled || !dataUrl) return;
        if (dataUrl !== nodeData.outputImage) {
          committedComps.set(id, sig);
          updateNodeData(id, {
            outputImage: dataUrl,
            outputImageRef: undefined,
            compCommitSig: sig,
            outputWidth: outW,
            outputHeight: outH,
            outputImageDims: { width: outW, height: outH },
          });
        }
      }
    };
    const t = setTimeout(run, 80);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, modalOpenForThis]);

  // Display thumbnail once the node has been quiet. Kept off the render path
  // because the Comp modal drives that path continuously while editing, and a
  // full-res PNG re-encode per settle stacked up behind every change.
  useEffect(() => {
    const full = nodeData.outputImage;
    if (!full || modalOpenForThis) return;
    // Already have a thumb made from THESE pixels? Then don't remake it. Without
    // this the effect fired on any non-null outputImage — including one that had
    // just been hydrated from disk with its thumb already beside it — and spent
    // a GPU readback and an encode reproducing what it already had. Same
    // key-beside-the-thumb contract commitProcessorOutput uses.
    if (nodeData.outputImageThumb && nodeData.outputImageThumbKey === cheapUrlKey(full)) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        // Read the thumb straight off the float texture when we still have it.
        // The old path decoded the full-res PNG we had just encoded and
        // re-encoded it small — ~300ms per node on a 24MP comp, for a preview
        // a few dozen px wide. Falls back to the PNG when the texture is gone
        // (float unsupported, context lost, or a non-float fallback commit).
        const meta = hasFloat(id)
          ? await floatNodeToThumbDataUrl(id, thumbMaxDim(), "png")
          : await createImageThumbnailWithMeta(full, undefined, 0.8, "png");
        if (!cancelled && meta) {
          updateNodeData(id, { outputImageThumb: meta.thumb, outputImageThumbKey: cheapUrlKey(full) });
        }
      } catch { /* preview falls back to the full-res image */ }
    }, 900);
    return () => { cancelled = true; clearTimeout(t); };
  }, [id, nodeData.outputImage, nodeData.outputImageThumb, nodeData.outputImageThumbKey, modalOpenForThis, updateNodeData]);

  // Free the float texture when the node is removed.
  useEffect(() => () => releaseColorNode(id), [id]);

  // Open the editor, then load full-res inputs from disk (lazy on open). The
  // modal reads node data reactively, so inputs stream in as they arrive.
  const handleEdit = useCallback(() => {
    openModal(id);
    void loadNodeFullResInputs(id);
  }, [id, openModal, loadNodeFullResInputs]);

  // Live composite needs the BG input (lazily null on open) → show the saved
  // thumbnail until the editor opens / a run loads the inputs.
  const hasBg = !!nodeData.bgImage;
  const thumb = nodeData.outputImageThumb;
  const preview = thumb ?? nodeData.outputImage;

  // Whole node = the GPU-rendered composite (full-bleed), sized to the output.
  // No controls live on the node — double-click opens the editor for everything.
  return (
    <BaseNode id={id} selected={selected} fullBleed aspectFitMedia={nodeData.outputImage ?? thumb}>
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
        className="group absolute inset-0 overflow-hidden rounded-lg cursor-pointer"
        style={nodeData.checkerboard ? CHECKER_STYLE : { backgroundColor: "#000" }}
        onDoubleClick={handleEdit}
        title={hasBg || thumb ? "Double-click to open the comp editor" : "Connect a BG image"}
      >
        {preview ? (
          <>
            <img src={preview} alt="Comp" className="w-full h-full object-contain" draggable={false} />
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
