"use client";

import { useMemo, useCallback, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import {
  ReactCompareSlider,
  ReactCompareSliderImage,
} from "react-compare-slider";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { ImageCompareNodeData } from "@/types";
import { ZoomPanView } from "../ZoomPanView";

type ImageCompareNodeType = Node<ImageCompareNodeData, "imageCompare">;

const MODE_OPTIONS = [
  { value: "slide" as const, label: "Slide" },
  { value: "blend" as const, label: "Blend" },
  { value: "difference" as const, label: "Diff" },
];

export function ImageCompareNode({
  id,
  data,
  selected,
}: NodeProps<ImageCompareNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);

  const compareMode = nodeData.compareMode || "slide";
  const blendOpacity = nodeData.blendOpacity ?? 0.5;

  const setMode = useCallback(
    (mode: "slide" | "blend" | "difference") => {
      updateNodeData(id, { compareMode: mode });
    },
    [id, updateNodeData]
  );

  const setOpacity = useCallback(
    (opacity: number) => {
      updateNodeData(id, { blendOpacity: opacity });
    },
    [id, updateNodeData]
  );

  // Collect images in real-time from connected nodes (same pattern as OutputGalleryNode)
  const displayImages = useMemo(() => {
    const connectedImages: string[] = [];

    // Get edges connected to this node, sorted by creation time for stable ordering
    const sortedEdges = edges
      .filter((edge) => edge.target === id)
      .sort((a, b) => {
        const aTime = (a.data?.createdAt as number) || 0;
        const bTime = (b.data?.createdAt as number) || 0;
        return aTime - bTime;
      });

    sortedEdges.forEach((edge) => {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      if (!sourceNode) return;

      let image: string | null = null;

      // Extract image from different node types
      if (sourceNode.type === "imageInput") {
        image = (sourceNode.data as any).image;
      } else if (sourceNode.type === "annotation") {
        image = (sourceNode.data as any).outputImage;
      } else if (sourceNode.type === "nanoBanana") {
        image = (sourceNode.data as any).outputImage;
      }

      if (image) {
        connectedImages.push(image);
      }
    });

    return connectedImages;
  }, [edges, nodes, id]);

  const imageA = displayImages[0] || nodeData.imageA || null;
  const imageB = displayImages[1] || nodeData.imageB || null;

  // Full-screen overlay
  const [showOverlay, setShowOverlay] = useState(false);
  useEffect(() => {
    if (!showOverlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowOverlay(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showOverlay]);

  return (
    <>
    <BaseNode
      id={id}
      selected={selected}
      className="min-w-[200px]"
    >
      {/* Two labeled image input handles */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        data-handletype="image"
        style={{ top: "35%" }}
      />
      <div
        className="absolute left-[-8px] top-[35%] -translate-y-1/2 -translate-x-full mr-1 text-[9px] text-neutral-400 font-medium"
        style={{ pointerEvents: "none" }}
      >
        A
      </div>

      <Handle
        type="target"
        position={Position.Left}
        id="image-1"
        data-handletype="image"
        style={{ top: "65%" }}
      />
      <div
        className="absolute left-[-8px] top-[65%] -translate-y-1/2 -translate-x-full mr-1 text-[9px] text-neutral-400 font-medium"
        style={{ pointerEvents: "none" }}
      >
        B
      </div>

      {/* Mode selector */}
      <div className="flex gap-1 mb-2 nodrag">
        {MODE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setMode(opt.value)}
            className={`flex-1 text-[10px] font-medium py-1 px-2 rounded transition-colors ${
              compareMode === opt.value
                ? "bg-blue-600 text-white"
                : "bg-neutral-700 text-neutral-400 hover:bg-neutral-600 hover:text-neutral-300"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Opacity slider for blend/difference modes */}
      {compareMode !== "slide" && imageA && imageB && (
        <div className="flex items-center gap-2 mb-2 nodrag px-1">
          <span className="text-[9px] text-neutral-400 whitespace-nowrap">
            Opacity
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={blendOpacity}
            onChange={(e) => setOpacity(parseFloat(e.target.value))}
            className="flex-1 h-1 accent-blue-500 cursor-pointer"
          />
          <span className="text-[9px] text-neutral-400 w-[28px] text-right tabular-nums">
            {Math.round(blendOpacity * 100)}%
          </span>
        </div>
      )}

      {/* Comparison view or placeholder */}
      {imageA && imageB ? (
        <div
          className="flex-1 relative nodrag nopan nowheel"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setShowOverlay(true);
          }}
          title="Double-click to view fullscreen"
        >
          {compareMode === "slide" && (
            <>
              <ReactCompareSlider
                itemOne={
                  <ReactCompareSliderImage
                    src={imageA}
                    alt="Image A"
                    style={{ objectFit: "contain" }}
                  />
                }
                itemTwo={
                  <ReactCompareSliderImage
                    src={imageB}
                    alt="Image B"
                    style={{ objectFit: "contain" }}
                  />
                }
                portrait={false}
                style={{ width: "100%", height: "100%" }}
              />
              {/* Corner labels */}
              <div className="absolute top-2 left-2 bg-black/50 text-white text-[10px] font-medium px-2 py-1 rounded pointer-events-none">
                A
              </div>
              <div className="absolute top-2 right-2 bg-black/50 text-white text-[10px] font-medium px-2 py-1 rounded pointer-events-none">
                B
              </div>
            </>
          )}

          {compareMode === "blend" && (
            <div className="relative w-full h-full" style={{ minHeight: 200 }}>
              <img
                src={imageA}
                alt="Image A"
                className="w-full h-full object-contain"
                draggable={false}
              />
              <img
                src={imageB}
                alt="Image B"
                className="absolute inset-0 w-full h-full object-contain"
                style={{ opacity: blendOpacity }}
                draggable={false}
              />
              {/* Corner labels */}
              <div className="absolute top-2 left-2 bg-black/50 text-white text-[10px] font-medium px-2 py-1 rounded pointer-events-none">
                A
              </div>
              <div className="absolute top-2 right-2 bg-black/50 text-white text-[10px] font-medium px-2 py-1 rounded pointer-events-none">
                B ({Math.round(blendOpacity * 100)}%)
              </div>
            </div>
          )}

          {compareMode === "difference" && (
            <div className="relative w-full h-full" style={{ minHeight: 200 }}>
              <img
                src={imageA}
                alt="Image A"
                className="w-full h-full object-contain"
                draggable={false}
              />
              <img
                src={imageB}
                alt="Image B"
                className="absolute inset-0 w-full h-full object-contain"
                style={{
                  opacity: blendOpacity,
                  mixBlendMode: "difference",
                }}
                draggable={false}
              />
              {/* Corner labels */}
              <div className="absolute top-2 left-2 bg-black/50 text-white text-[10px] font-medium px-2 py-1 rounded pointer-events-none">
                A
              </div>
              <div className="absolute top-2 right-2 bg-black/50 text-white text-[10px] font-medium px-2 py-1 rounded pointer-events-none">
                Diff ({Math.round(blendOpacity * 100)}%)
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="w-full flex-1 min-h-[200px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center gap-2">
          <span className="text-neutral-500 text-[10px] text-center px-4">
            {!imageA && !imageB
              ? "Connect 2 images to compare"
              : "Connect another image to compare"}
          </span>
          {imageA && !imageB && (
            <div className="text-[9px] text-neutral-600">Image A connected</div>
          )}
          {!imageA && imageB && (
            <div className="text-[9px] text-neutral-600">Image B connected</div>
          )}
        </div>
      )}
    </BaseNode>

    {showOverlay && imageA && imageB && typeof document !== "undefined" && createPortal(
      <div
        className="fixed inset-0 z-[200] bg-black/90 flex flex-col"
        onClick={(e) => {
          if (e.target === e.currentTarget) setShowOverlay(false);
        }}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 bg-black/40">
          <div className="flex gap-1 nodrag">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setMode(opt.value)}
                className={`text-xs font-medium py-1 px-3 rounded transition-colors ${
                  compareMode === opt.value
                    ? "bg-blue-600 text-white"
                    : "bg-white/10 text-white/70 hover:bg-white/20"
                }`}
              >
                {opt.label}
              </button>
            ))}
            {compareMode !== "slide" && (
              <div className="flex items-center gap-2 ml-4">
                <span className="text-[11px] text-white/60">Opacity</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={blendOpacity}
                  onChange={(e) => setOpacity(parseFloat(e.target.value))}
                  className="w-32 h-1 accent-blue-500 cursor-pointer"
                />
                <span className="text-[11px] text-white/60 w-8 tabular-nums">
                  {Math.round(blendOpacity * 100)}%
                </span>
              </div>
            )}
          </div>
          <button
            onClick={() => setShowOverlay(false)}
            className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
            title="Close (Esc)"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Comparison canvas with zoom/pan */}
        <ZoomPanView
          className="flex-1 w-full"
          panMode={compareMode === "slide" ? "alt-modifier" : "free"}
        >
          <div className="w-full h-full flex items-center justify-center">
            {compareMode === "slide" && (
              <ReactCompareSlider
                itemOne={
                  <ReactCompareSliderImage
                    src={imageA}
                    alt="Image A"
                    style={{ objectFit: "contain" }}
                  />
                }
                itemTwo={
                  <ReactCompareSliderImage
                    src={imageB}
                    alt="Image B"
                    style={{ objectFit: "contain" }}
                  />
                }
                portrait={false}
                style={{ width: "100%", height: "100%" }}
              />
            )}
            {compareMode === "blend" && (
              <div className="relative w-full h-full">
                <img src={imageA} alt="Image A" className="w-full h-full object-contain" draggable={false} />
                <img
                  src={imageB}
                  alt="Image B"
                  className="absolute inset-0 w-full h-full object-contain"
                  style={{ opacity: blendOpacity }}
                  draggable={false}
                />
              </div>
            )}
            {compareMode === "difference" && (
              <div className="relative w-full h-full">
                <img src={imageA} alt="Image A" className="w-full h-full object-contain" draggable={false} />
                <img
                  src={imageB}
                  alt="Image B"
                  className="absolute inset-0 w-full h-full object-contain"
                  style={{ opacity: blendOpacity, mixBlendMode: "difference" }}
                  draggable={false}
                />
              </div>
            )}
          </div>
        </ZoomPanView>
      </div>,
      document.body
    )}
    </>
  );
}
