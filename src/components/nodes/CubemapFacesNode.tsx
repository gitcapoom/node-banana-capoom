"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node, useUpdateNodeInternals } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { combineCubemap, splitCubemap, CUBE_FACES, type CubeFace } from "@/utils/cubemapEquirect";
import type { CubemapFacesMode, CubemapFacesNodeData } from "@/types";

type CubemapFacesNodeType = Node<CubemapFacesNodeData, "cubemapFaces">;

const SIZE_OPTIONS = [256, 512, 1024, 2048, 4096] as const;

// Vertical handle positions match the cube layout intuition: top is up,
// middle row is front/back/left/right (kept top-to-bottom), bottom is down.
const HANDLE_ORDER: readonly CubeFace[] = [
  "up",
  "front",
  "back",
  "left",
  "right",
  "down",
] as const;

const FACE_LABEL: Record<CubeFace, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  front: "Front",
  back: "Back",
};

/** Pixel offset (top) for each face-handle in node coords. */
function handleTop(index: number, total: number, baseTop = 56, spacing = 24): number {
  // Centred grouping near the middle of the node body.
  const totalHeight = (total - 1) * spacing;
  const middle = baseTop + totalHeight / 2;
  return middle - totalHeight / 2 + index * spacing;
}

export function CubemapFacesNode({ id, data, selected }: NodeProps<CubemapFacesNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const updateNodeInternals = useUpdateNodeInternals();

  // ─── Mode toggle ─────────────────────────────────────
  const setMode = useCallback(
    (mode: CubemapFacesMode) => {
      if (mode !== nodeData.mode) updateNodeData(id, { mode });
    },
    [id, nodeData.mode, updateNodeData]
  );
  const setSize = useCallback(
    (size: number) => {
      if (size !== nodeData.outputSize) updateNodeData(id, { outputSize: size });
    },
    [id, nodeData.outputSize, updateNodeData]
  );

  // Tell React Flow handle positions changed when the layout flips.
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, nodeData.mode, updateNodeInternals]);

  // Subscribe to edges + nodes; derive the actual values via useMemo so the
  // selectors return primitive references (or stable arrays Zustand can
  // compare with Object.is) instead of fresh objects every call. Returning a
  // fresh object directly from useWorkflowStore would loop forever.
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);

  // ─── SPLIT mode: pull upstream cross ─────────────────────────────────
  const incomingCross = useMemo<string | null>(() => {
    if (nodeData.mode !== "split") return null;
    for (const edge of edges) {
      if (edge.target !== id) continue;
      if (edge.targetHandle !== "image" && edge.targetHandle != null) continue;
      const src = nodes.find((n) => n.id === edge.source);
      if (!src) continue;
      const out = getSourceOutput(
        src,
        edge.sourceHandle,
        edge.data as Record<string, unknown> | undefined
      );
      if (out.type === "image" && out.value) return out.value;
    }
    return null;
  }, [edges, nodes, id, nodeData.mode]);

  // ─── COMBINE mode: pull six face inputs by targetHandle ─────────────
  const incomingFaces = useMemo<Record<CubeFace, string | null> | null>(() => {
    if (nodeData.mode !== "combine") return null;
    const result: Record<CubeFace, string | null> = {
      up: null, down: null, left: null, right: null, front: null, back: null,
    };
    for (const edge of edges) {
      if (edge.target !== id) continue;
      const handle = edge.targetHandle as CubeFace | null;
      if (!handle || !CUBE_FACES.includes(handle as CubeFace)) continue;
      const src = nodes.find((n) => n.id === edge.source);
      if (!src) continue;
      const out = getSourceOutput(
        src,
        edge.sourceHandle,
        edge.data as Record<string, unknown> | undefined
      );
      if (out.type === "image" && out.value) result[handle as CubeFace] = out.value;
    }
    return result;
  }, [edges, nodes, id, nodeData.mode]);

  // ─── SPLIT effect: re-derive 6 face outputs whenever input/size changes ─
  const lastSplitFp = useRef<string>("");
  const [splitBusy, setSplitBusy] = useState(false);

  useEffect(() => {
    if (nodeData.mode !== "split") {
      lastSplitFp.current = "";
      return;
    }
    // Mirror upstream into sourceImage so save/load round-trips properly.
    if (incomingCross !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: incomingCross });
    }
    if (!incomingCross) {
      // Clear all face outputs.
      const cleared: Partial<CubemapFacesNodeData> = {
        outputUp: null, outputDown: null, outputLeft: null,
        outputRight: null, outputFront: null, outputBack: null,
      };
      let needsClear = false;
      (Object.keys(cleared) as Array<keyof CubemapFacesNodeData>).forEach((k) => {
        if (nodeData[k] != null) needsClear = true;
      });
      if (needsClear) updateNodeData(id, cleared);
      lastSplitFp.current = "";
      return;
    }
    const fp = `${incomingCross.length}|${nodeData.outputSize}`;
    if (lastSplitFp.current === fp) return;
    lastSplitFp.current = fp;

    setSplitBusy(true);
    splitCubemap(incomingCross, nodeData.outputSize)
      .then((faces) => {
        if (lastSplitFp.current !== fp) return;
        updateNodeData(id, {
          outputUp: faces.up,         outputUpRef: undefined,
          outputDown: faces.down,     outputDownRef: undefined,
          outputLeft: faces.left,     outputLeftRef: undefined,
          outputRight: faces.right,   outputRightRef: undefined,
          outputFront: faces.front,   outputFrontRef: undefined,
          outputBack: faces.back,     outputBackRef: undefined,
        });
        setSplitBusy(false);
      })
      .catch((err) => {
        if (lastSplitFp.current !== fp) return;
        console.error("CubemapFacesNode: split failed", err);
        setSplitBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nodeData.mode, incomingCross, nodeData.outputSize, updateNodeData]);

  // ─── COMBINE effect: re-assemble cross whenever inputs/size change ──
  const lastCombineFp = useRef<string>("");
  const [combineBusy, setCombineBusy] = useState(false);

  const combineFingerprint = useMemo(() => {
    if (!incomingFaces) return "";
    return CUBE_FACES.map((f) => incomingFaces[f]?.length ?? 0).join("|") +
      `|${nodeData.outputSize}`;
  }, [incomingFaces, nodeData.outputSize]);

  useEffect(() => {
    if (nodeData.mode !== "combine") {
      lastCombineFp.current = "";
      return;
    }
    if (!incomingFaces) return;
    if (lastCombineFp.current === combineFingerprint) return;
    lastCombineFp.current = combineFingerprint;

    const anyFace = CUBE_FACES.some((f) => !!incomingFaces[f]);
    if (!anyFace) {
      if (nodeData.outputCross) updateNodeData(id, { outputCross: null });
      return;
    }

    setCombineBusy(true);
    combineCubemap(incomingFaces, nodeData.outputSize)
      .then((cross) => {
        if (lastCombineFp.current !== combineFingerprint) return;
        updateNodeData(id, { outputCross: cross, outputCrossRef: undefined });
        setCombineBusy(false);
      })
      .catch((err) => {
        if (lastCombineFp.current !== combineFingerprint) return;
        console.error("CubemapFacesNode: combine failed", err);
        setCombineBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nodeData.mode, combineFingerprint, updateNodeData]);

  // ─── Body preview ───────────────────────────────────
  const previewImage =
    nodeData.mode === "split"
      ? nodeData.sourceImage || incomingCross
      : nodeData.outputCross;
  const busy = nodeData.mode === "split" ? splitBusy : combineBusy;

  return (
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip flex flex-col"
      aspectFitMedia={previewImage}
    >
      {/* Mode toggle */}
      <div className="flex gap-1 mb-1 px-1 nodrag">
        <button
          onClick={() => setMode("split")}
          className={`flex-1 text-[10px] font-medium py-1 rounded transition-colors ${
            nodeData.mode === "split"
              ? "bg-blue-600 text-white"
              : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
          }`}
          title="Cubemap cross → 6 separate face images"
        >
          Split (1 → 6)
        </button>
        <button
          onClick={() => setMode("combine")}
          className={`flex-1 text-[10px] font-medium py-1 rounded transition-colors ${
            nodeData.mode === "combine"
              ? "bg-blue-600 text-white"
              : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
          }`}
          title="6 face images → assembled cubemap cross"
        >
          Combine (6 → 1)
        </button>
      </div>

      {/* Output size selector */}
      <div className="flex items-center gap-1 mb-1 px-1 nodrag">
        <label className="text-[10px] text-neutral-400 shrink-0">Face size</label>
        <select
          value={nodeData.outputSize}
          onChange={(e) => setSize(Number(e.target.value))}
          className="nodrag nopan flex-1 min-w-0 text-[10px] py-0.5 px-1 rounded bg-[#1a1a1a] focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white"
        >
          {SIZE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {/* HANDLES (dynamic per mode) */}
      {nodeData.mode === "split" ? (
        <>
          <Handle
            type="target"
            position={Position.Left}
            id="image"
            data-handletype="image"
            style={{ top: 38 }}
          />
          {HANDLE_ORDER.map((face, i) => (
            <Handle
              key={face}
              type="source"
              position={Position.Right}
              id={face}
              data-handletype="image"
              style={{ top: handleTop(i, HANDLE_ORDER.length) }}
            />
          ))}
        </>
      ) : (
        <>
          {HANDLE_ORDER.map((face, i) => (
            <Handle
              key={face}
              type="target"
              position={Position.Left}
              id={face}
              data-handletype="image"
              style={{ top: handleTop(i, HANDLE_ORDER.length) }}
            />
          ))}
          <Handle
            type="source"
            position={Position.Right}
            id="image"
            data-handletype="image"
            style={{ top: 38 }}
          />
        </>
      )}

      {/* Face labels next to each handle */}
      <div
        className={`absolute ${nodeData.mode === "split" ? "right-1" : "left-1"} top-0 h-full text-[8px] text-neutral-500 pointer-events-none`}
        style={{ width: 24 }}
      >
        {HANDLE_ORDER.map((face, i) => (
          <div
            key={face}
            className="absolute"
            style={{
              top: handleTop(i, HANDLE_ORDER.length) - 5,
              [nodeData.mode === "split" ? "right" : "left"]: 4,
            }}
          >
            {FACE_LABEL[face]}
          </div>
        ))}
      </div>

      {/* Preview thumbnail */}
      {previewImage ? (
        <div className="relative w-full flex-1 min-h-0">
          <img
            data-node-media={nodeData.mode === "split" ? "sourceImage" : "outputCross"}
            src={previewImage}
            alt={nodeData.mode === "split" ? "Source cross" : "Combined cross"}
            className="w-full h-full object-contain"
          />
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <span className="text-[10px] text-white/80 bg-black/60 px-2 py-1 rounded">
                {nodeData.mode === "split" ? "splitting…" : "combining…"}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="w-full flex-1 min-h-0 bg-neutral-900/40 flex flex-col items-center justify-center">
          <svg className="w-6 h-6 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.5a.75.75 0 01.75-.75h4.5a.75.75 0 01.75.75V9a.75.75 0 01-.75.75h-4.5A.75.75 0 013.75 9V4.5zm0 9.75a.75.75 0 01.75-.75h4.5a.75.75 0 01.75.75V18.75a.75.75 0 01-.75.75h-4.5a.75.75 0 01-.75-.75V14.25zm10.5-9.75a.75.75 0 01.75-.75h4.5a.75.75 0 01.75.75V9a.75.75 0 01-.75.75h-4.5a.75.75 0 01-.75-.75V4.5zm0 9.75a.75.75 0 01.75-.75h4.5a.75.75 0 01.75.75v4.5a.75.75 0 01-.75.75h-4.5a.75.75 0 01-.75-.75v-4.5z" />
          </svg>
          <span className="text-[10px] text-neutral-500 mt-1 px-2 text-center">
            {nodeData.mode === "split"
              ? "Connect a cubemap cross"
              : "Connect 6 face images"}
          </span>
        </div>
      )}
    </BaseNode>
  );
}
