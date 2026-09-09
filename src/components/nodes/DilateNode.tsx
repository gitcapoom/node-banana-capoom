"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { BaseNode } from "./BaseNode";
import { SliderRow } from "./SliderRow";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { releaseColorNode, renderDilateNodeToCanvas, commitDilateNode, floatNodeToThumbDataUrl, hasFloat, type DilateNodeParams } from "@/utils/colorChain";
import { createImageThumbnailWithMeta, thumbMaxDim } from "@/utils/createImageThumbnail";
import { resolveInputRef } from "@/utils/compComposite";
import { cheapUrlKey, RenderSignatureCache } from "@/utils/renderSignature";
import { useHydrateUnresolvedInputs, useIncomingEdgeKey } from "@/hooks/useUpstreamHydration";
import type { DilateNodeData } from "@/types";

type DilateNodeType = Node<DilateNodeData, "dilate">;

/** Last committed result per node — survives viewport-culling remounts. */
const committedDilates = new RenderSignatureCache();

function paramsOf(d: DilateNodeData): DilateNodeParams {
  return {
    size: d.size ?? 0,
    invertMatte: !!d.invertMatte,
    mixAmount: d.mixAmount ?? 1,
  };
}

export function DilateNode({ id, data, selected }: NodeProps<DilateNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);

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
        const isMatte = e.targetHandle === "image-dilate_matte";
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
  // unloaded matte would silently render as "no matte" (grow everywhere).
  const allInputsResolved =
    (!incoming.srcConn || !!incoming.src) && (!incoming.matteConn || !!incoming.matte);

  const incomingEdgeKey = useIncomingEdgeKey(id);

  // CONNECTED-BUT-UNHYDRATED is not DISCONNECTED — gate on `srcConn`/`matteConn`
  // ("an edge exists"), never on the value, which is exactly what is missing for
  // a lazily-unloaded upstream field on workflow open.
  useHydrateUnresolvedInputs(id, incomingEdgeKey, allInputsResolved);

  // Mirror resolved inputs into node data (guarded against loops).
  useEffect(() => {
    const patch: Partial<DilateNodeData> = {};
    if (incoming.src !== nodeData.sourceImage) { patch.sourceImage = incoming.src; patch.sourceImageRef = undefined; }
    if (incoming.matte !== nodeData.matteImage) { patch.matteImage = incoming.matte; patch.matteImageRef = undefined; }
    if (Object.keys(patch).length) updateNodeData(id, patch);
  }, [incoming.src, incoming.matte, nodeData.sourceImage, nodeData.matteImage, id, updateNodeData]);

  const params = paramsOf(nodeData);
  const sig = JSON.stringify({
    src: cheapUrlKey(incoming.src), srcId: incoming.srcId,
    mt: cheapUrlKey(incoming.matte), mtId: incoming.matteId, p: params,
  });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef({ incoming, params });
  latest.current = { incoming, params };

  // Live canvas while the node is being ADJUSTED. Not on mount: React Flow
  // remounts nodes as they scroll in and out of view, and a canvas that renders
  // on mount re-runs a full-res pass for every node you pan across.
  const [live, setLive] = useState(false);
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) { firstRunRef.current = false; return; }
    setLive(true);
    const t = setTimeout(() => setLive(false), 1500);
    return () => clearTimeout(t);
  }, [sig]);

  useEffect(() => {
    if (!live || !allInputsResolved) return;
    let cancelled = false;
    const run = async () => {
      const { incoming: inc, params: p } = latest.current;
      const canvas = canvasRef.current;
      if (!inc.src || !canvas) return;
      const ok = await renderDilateNodeToCanvas(
        resolveInputRef(inc.src, inc.srcId), resolveInputRef(inc.matte, inc.matteId), p, id, canvas,
      );
      if (!ok && !cancelled) console.warn("[dilate] GPU preview unavailable", { id });
    };
    void run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, live, allInputsResolved, id]);

  // Debounced commit: publish the float texture + 8-bit PNG to outputImage.
  useEffect(() => {
    const { incoming: inc } = latest.current;
    if (!inc.src) {
      // An edge whose source has not hydrated yet is NOT a missing input;
      // clearing here would throw away a good committed output on open.
      if (inc.srcConn) return;
      if (nodeData.outputImage !== null) updateNodeData(id, { outputImage: null, outputImageRef: undefined });
      committedDilates.forget(id);
      return;
    }
    if (!allInputsResolved) return;
    if (committedDilates.matches(id, sig) && nodeData.outputImage) return;
    const t = setTimeout(async () => {
      const { incoming: cur, params: p } = latest.current;
      if (!cur.src) return;
      const out = await commitDilateNode(
        resolveInputRef(cur.src, cur.srcId), resolveInputRef(cur.matte, cur.matteId), p, id, cur.src,
      );
      committedDilates.set(id, sig);
      updateNodeData(id, { outputImage: out, outputImageRef: undefined });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, allInputsResolved, id]);

  // Display thumbnail, generated only once the node has been quiet.
  useEffect(() => {
    const full = nodeData.outputImage;
    if (!full || live) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const meta = hasFloat(id)
          ? await floatNodeToThumbDataUrl(id, thumbMaxDim(), "png")
          : await createImageThumbnailWithMeta(full, undefined, 0.8, "png");
        if (cancelled || !meta) return;
        updateNodeData(id, {
          outputImageThumb: meta.thumb,
          outputImageDims: { width: meta.width, height: meta.height },
        });
      } catch { /* preview falls back to the full-res image */ }
    }, 900);
    return () => { cancelled = true; clearTimeout(t); };
  }, [id, nodeData.outputImage, live, updateNodeData]);

  // Free the float texture + pooled pass targets when the node is removed.
  useEffect(() => () => releaseColorNode(id), [id]);

  const setParam = useCallback(
    (patch: Partial<DilateNodeData>) => updateNodeData(id, patch),
    [id, updateNodeData],
  );

  const thumb = nodeData.outputImageThumb;
  const preview = thumb ?? nodeData.outputImage;
  const size = nodeData.size ?? 0;

  return (
    <BaseNode id={id} selected={selected} contentClassName="flex flex-col gap-1.5 p-2" aspectFitMedia={nodeData.outputImage ?? thumb}>
      <Handle type="target" position={Position.Left} id="image" data-handletype="image" style={{ top: "35%" }} />
      <Handle
        type="target" position={Position.Left} id="image-dilate_matte" data-handletype="image"
        style={{ top: "70%", background: "#a3a3a3" }}
      />
      <div
        className="absolute z-10 text-[9px] text-white/70 font-medium drop-shadow"
        style={{ left: 5, top: "70%", transform: "translateY(-50%)", pointerEvents: "none" }}
      >
        Mask
      </div>
      <Handle type="source" position={Position.Right} id="image" data-handletype="image" />

      <div
        data-node-media="outputImage"
        className="relative w-full aspect-square bg-neutral-900/60 rounded overflow-hidden cursor-pointer"
        title="Double-click to view full screen"
      >
        {live && allInputsResolved ? (
          <canvas ref={canvasRef} className="w-full h-full object-contain" />
        ) : preview ? (
          <img src={preview} alt="Dilate" className="w-full h-full object-contain" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-neutral-500">
            Connect an image
          </div>
        )}
      </div>

      {/* One signed knob: right grows, left shrinks, 0 is a pass-through. */}
      <SliderRow label="Size" min={-100} max={100} step={1} value={size}
        format={(v) => `${v > 0 ? "+" : ""}${Math.round(v)}px`}
        onChange={(v) => setParam({ size: v })} resetValue={0} />
      <div className="text-[9px] text-neutral-500 -mt-1 pl-[58px]">
        {size > 0 ? "Dilate — grow" : size < 0 ? "Erode — shrink" : "No change"}
      </div>

      <SliderRow label="Mix" min={0} max={1} step={0.01} value={nodeData.mixAmount ?? 1}
        format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setParam({ mixAmount: v })} resetValue={1} />

      <label
        className={`flex items-center gap-1.5 text-[10px] cursor-pointer ${incoming.matteConn ? "text-neutral-300" : "text-neutral-500"}`}
        title={incoming.matteConn ? "Apply where the mask is black instead of white" : "Connect a mask to gate where the effect lands"}
      >
        <input
          type="checkbox"
          checked={!!nodeData.invertMatte}
          onChange={(e) => setParam({ invertMatte: e.target.checked })}
          className="nodrag nopan accent-indigo-500"
        />
        Invert mask
      </label>
    </BaseNode>
  );
}
