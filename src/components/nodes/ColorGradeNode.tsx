"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { GpuEditorOverlay } from "./GpuEditorOverlay";
import { GradeRow, GRADE_SLIDERS } from "@/components/controls/GradeRow";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import {
  coerceChannel,
  IDENTITY_GRADE,
  isIdentityGrade,
  isMaster,
  type GradeChannelValue,
  type GradeParams,
} from "@/utils/colorGrade";
import { useColorNode } from "@/hooks/useGpuPreview";
import { useHydrateUnresolvedInputs, useIncomingEdgeKey } from "@/hooks/useUpstreamHydration";
import { GRADE_SHADER } from "@/utils/imageShaders";
import type { UniformValue } from "@/utils/webglProcess";
import { ClampToggles, COLOR_NODE_TYPES } from "./colorNodeShared";
import type { ColorGradeNodeData } from "@/types";

type ColorGradeNodeType = Node<ColorGradeNodeData, "colorGrade">;

export function ColorGradeNode({ id, data, selected }: NodeProps<ColorGradeNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const loadNodeFullResInputs = useWorkflowStore((state) => state.loadNodeFullResInputs);
  // Scoped selector that returns just the incoming image string. Zustand
  // bails out when the result is === across renders, so this node only
  // re-renders when its upstream image actually changes — NOT on every
  // unrelated store update (which subscribing to the whole `nodes` array
  // would cause, and which was a chunk of the Color Grade drag lag).
  const incomingImage = useWorkflowStore((state): string | null => {
    for (const edge of state.edges) {
      if (edge.target !== id) continue;
      if (edge.targetHandle !== "image" && edge.targetHandle != null) continue;
      const src = state.nodes.find((n) => n.id === edge.source);
      if (!src) continue;
      const out = getSourceOutput(
        src,
        edge.sourceHandle,
        edge.data as Record<string, unknown> | undefined
      );
      if (out.type === "image" && out.value) return out.value;
    }
    return null;
  });
  // Upstream node id IF it's another color node (read its float texture).
  const upstreamColorNodeId = useWorkflowStore((state): string | null => {
    for (const edge of state.edges) {
      if (edge.target !== id) continue;
      if (edge.targetHandle !== "image" && edge.targetHandle != null) continue;
      const src = state.nodes.find((n) => n.id === edge.source);
      if (src && COLOR_NODE_TYPES.has(src.type as string)) return src.id;
    }
    return null;
  });

  // Wired vs resolved — see useUpstreamHydration. This node keeps its bespoke
  // selectors above (it needs `upstreamColorNodeId` for the float chain, which
  // no shared hook provides); only the connected/unresolved question is shared.
  const incomingEdgeKey = useIncomingEdgeKey(id);
  useHydrateUnresolvedInputs(id, incomingEdgeKey, !!incomingImage);
  const connected = !!incomingEdgeKey;

  useEffect(() => {
    if (incomingImage) {
      if (incomingImage !== nodeData.sourceImage) updateNodeData(id, { sourceImage: incomingImage });
    } else if (!connected && nodeData.sourceImage) {
      // Only a REAL disconnect clears; a lazily-unloaded upstream is not one.
      updateNodeData(id, { sourceImage: null });
    }
  }, [id, incomingImage, connected, nodeData.sourceImage, updateNodeData]);

  // Coerce stored params (handles legacy single-number values from before
  // per-channel was added) into a stable GradeParams object.
  const params: GradeParams = useMemo(
    () => ({
      blackpoint: coerceChannel(nodeData.blackpoint, 0),
      whitepoint: coerceChannel(nodeData.whitepoint, 1),
      lift:       coerceChannel(nodeData.lift, 0),
      gain:       coerceChannel(nodeData.gain, 1),
      multiply:   coerceChannel(nodeData.multiply, 1),
      offset:     coerceChannel(nodeData.offset, 0),
      gamma:      coerceChannel(nodeData.gamma, 1),
    }),
    [
      nodeData.blackpoint, nodeData.whitepoint, nodeData.lift,
      nodeData.gain, nodeData.multiply, nodeData.offset, nodeData.gamma,
    ]
  );

  // Which rows are currently in split-mode UI? We DON'T persist this — if a
  // row is master-equal (r===g===b) it shows as a single slider, otherwise
  // as three. The toggle button forces split-mode even when values match
  // (so the user can split, edit one channel, etc.).
  const [forceSplit, setForceSplit] = useState<Record<keyof GradeParams, boolean>>({
    blackpoint: false, whitepoint: false, lift: false,
    gain: false, multiply: false, offset: false, gamma: false,
  });

  const toggleExpanded = useCallback((key: keyof GradeParams) => {
    setForceSplit((s) => ({ ...s, [key]: !s[key] }));
  }, []);

  const setParamValue = useCallback(
    (key: keyof GradeParams, next: GradeChannelValue) => {
      updateNodeData(id, { [key]: next });
      // If user entered a non-master value, auto-stick the row in split mode.
      if (!isMaster(next)) setForceSplit((s) => ({ ...s, [key]: true }));
    },
    [id, updateNodeData]
  );

  const resetAll = useCallback(() => {
    updateNodeData(id, { ...IDENTITY_GRADE });
    setForceSplit({
      blackpoint: false, whitepoint: false, lift: false,
      gain: false, multiply: false, offset: false, gamma: false,
    });
  }, [id, updateNodeData]);

  // GPU uniforms — each grade parameter is a vec3 (per-channel R/G/B).
  const uniforms: Record<string, UniformValue> = useMemo(
    () => ({
      u_blackpoint: [params.blackpoint.r, params.blackpoint.g, params.blackpoint.b],
      u_whitepoint: [params.whitepoint.r, params.whitepoint.g, params.whitepoint.b],
      u_lift:       [params.lift.r,       params.lift.g,       params.lift.b],
      u_gain:       [params.gain.r,       params.gain.g,       params.gain.b],
      u_multiply:   [params.multiply.r,   params.multiply.g,   params.multiply.b],
      u_offset:     [params.offset.r,     params.offset.g,     params.offset.b],
      u_gamma:      [params.gamma.r,      params.gamma.g,      params.gamma.b],
    }),
    [params],
  );
  const identity = isIdentityGrade(params);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const nodeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Float-chain pipeline: live canvas preview + debounced commit (float
  // texture for the next color node, 8-bit display URL for the thumbnail).
  const { liveActive } = useColorNode({
    id,
    sourceImage: nodeData.sourceImage,
    sourceConnected: connected,
    upstreamColorNodeId,
    shaderSource: GRADE_SHADER,
    uniforms,
    clampBlacks: nodeData.clampBlacks ?? false,
    clampWhites: nodeData.clampWhites ?? false,
    isIdentity: identity,
    nodeCanvasRef,
    overlayCanvasRef,
    overlayOpen,
  });

  const setClamp = useCallback(
    (which: "clampBlacks" | "clampWhites", v: boolean) => updateNodeData(id, { [which]: v }),
    [id, updateNodeData],
  );

  // Live GPU preview needs the full-res source. On open it's lazily null, so we
  // show the saved thumbnail (no WebGL work) until the editor is opened or a run
  // loads the source. Double-click loads full-res inputs, then shows the editor.
  const hasFullRes = !!nodeData.sourceImage;
  const thumb = nodeData.outputImageThumb;
  // The node body shows the committed thumbnail, never a live canvas —
  // see useColorNode for why.
  const preview = thumb ?? nodeData.outputImage;
  const handleOpenEditor = useCallback(() => {
    setOverlayOpen(true);
    void loadNodeFullResInputs(id);
  }, [id, loadNodeFullResInputs]);

  return (
    <>
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip flex flex-col"
      aspectFitMedia={nodeData.outputImage ?? thumb}
    >
      <Handle type="target" position={Position.Left} id="image" data-handletype="image" />
      <Handle type="source" position={Position.Right} id="image" data-handletype="image" />

      {/* Sliders, Reset and the clamp toggles live in the full-screen editor
          (double-click) — the overlay already renders the same controls, so the
          node itself stays just the picture. */}
      {liveActive || preview ? (
        <div
          className="relative w-full flex-1 min-h-0 cursor-pointer"
          onDoubleClick={handleOpenEditor}
          title="Double-click for full-screen editor"
        >
          {/* Live GPU canvas while adjusting; committed image otherwise. */}
          {liveActive ? (
            <canvas ref={nodeCanvasRef} className="w-full h-full object-contain" />
          ) : (
            <img src={preview!} alt="Color grade" className="w-full h-full object-contain" />
          )}
        </div>
      ) : (
        <div className="w-full flex-1 min-h-0 bg-neutral-900/40 flex flex-col items-center justify-center">
          <svg className="w-6 h-6 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z" />
          </svg>
          <span className="text-[10px] text-neutral-500 mt-1">
            Connect an image
          </span>
        </div>
      )}
    </BaseNode>

    {overlayOpen && hasFullRes && (
      <GpuEditorOverlay
        title="Color Grade"
        canvasRef={overlayCanvasRef}
        onClose={() => setOverlayOpen(false)}
      >
        {/* Sliders write through to nodeData; the live GPU preview hook
            re-renders the overlay canvas immediately on each change. */}
        <div className="nodrag nowheel max-h-[60vh] overflow-y-auto">
          {GRADE_SLIDERS.map((s) => {
            const value = params[s.key];
            const expanded = forceSplit[s.key] || !isMaster(value);
            return (
              <GradeRow
                key={s.key}
                def={s}
                value={value}
                expanded={expanded}
                onChange={(next) => setParamValue(s.key, next)}
                onToggleExpanded={() => toggleExpanded(s.key)}
              />
            );
          })}
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={resetAll}
            disabled={identity}
            className={`text-[11px] py-1 px-3 rounded transition-colors ${
              identity
                ? "bg-neutral-800 text-neutral-600"
                : "bg-neutral-700 text-neutral-200 hover:bg-neutral-600"
            }`}
          >
            Reset all
          </button>
          <ClampToggles
            clampBlacks={nodeData.clampBlacks ?? false}
            clampWhites={nodeData.clampWhites ?? false}
            onChange={setClamp}
          />
        </div>
      </GpuEditorOverlay>
    )}
    </>
  );
}
