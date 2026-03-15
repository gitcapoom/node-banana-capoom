"use client";

import { useMemo, useCallback, useRef, useEffect, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { VideoCompareNodeData } from "@/types";

type VideoCompareNodeType = Node<VideoCompareNodeData, "videoCompare">;

const MODE_OPTIONS = [
  { value: "slide" as const, label: "Slide" },
  { value: "blend" as const, label: "Blend" },
  { value: "difference" as const, label: "Diff" },
];

export function VideoCompareNode({
  id,
  data,
  selected,
}: NodeProps<VideoCompareNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);

  const compareMode = nodeData.compareMode || "slide";
  const blendOpacity = nodeData.blendOpacity ?? 0.5;

  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [sliderPosition, setSliderPosition] = useState(50);
  const [isDragging, setIsDragging] = useState(false);

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

  // Collect videos from connected nodes
  const displayVideos = useMemo(() => {
    const connectedVideos: string[] = [];

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

      let video: string | null = null;

      if (sourceNode.type === "videoInput") {
        video = (sourceNode.data as any).videoFile;
      } else if (sourceNode.type === "generateVideo") {
        video = (sourceNode.data as any).outputVideo;
      } else if (sourceNode.type === "videoStitch") {
        video = (sourceNode.data as any).outputVideo;
      } else if (sourceNode.type === "easeCurve") {
        video = (sourceNode.data as any).outputVideo;
      } else if (sourceNode.type === "videoTrim") {
        video = (sourceNode.data as any).outputVideo;
      }

      if (video) {
        connectedVideos.push(video);
      }
    });

    return connectedVideos;
  }, [edges, nodes, id]);

  const videoA = displayVideos[0] || nodeData.videoA || null;
  const videoB = displayVideos[1] || nodeData.videoB || null;

  // Synchronized playback: both videos play together, restart together when both finish
  useEffect(() => {
    const vA = videoARef.current;
    const vB = videoBRef.current;
    if (!vA || !vB) return;

    // Don't use native loop — we manage restarts ourselves
    vA.loop = false;
    vB.loop = false;

    let aEnded = false;
    let bEnded = false;

    const restartBoth = () => {
      aEnded = false;
      bEnded = false;
      vA.currentTime = 0;
      vB.currentTime = 0;
      vA.play().catch(() => {});
      vB.play().catch(() => {});
    };

    const onEndedA = () => {
      aEnded = true;
      if (bEnded) restartBoth();
    };
    const onEndedB = () => {
      bEnded = true;
      if (aEnded) restartBoth();
    };

    // When user plays A (e.g. via controls), also play B
    const onPlayA = () => {
      if (vB.paused && !bEnded) {
        vB.currentTime = vA.currentTime;
        vB.play().catch(() => {});
      }
    };
    const onPauseA = () => {
      if (!vB.paused) {
        vB.pause();
        vB.currentTime = vA.currentTime;
      }
    };
    const onSeekedA = () => {
      if (Math.abs(vA.currentTime - vB.currentTime) > 0.1) {
        vB.currentTime = vA.currentTime;
        // Reset ended flags on seek
        aEnded = false;
        bEnded = false;
      }
    };

    vA.addEventListener("ended", onEndedA);
    vB.addEventListener("ended", onEndedB);
    vA.addEventListener("play", onPlayA);
    vA.addEventListener("pause", onPauseA);
    vA.addEventListener("seeked", onSeekedA);

    // Auto-play both on mount
    vA.play().catch(() => {});
    vB.play().catch(() => {});

    return () => {
      vA.removeEventListener("ended", onEndedA);
      vB.removeEventListener("ended", onEndedB);
      vA.removeEventListener("play", onPlayA);
      vA.removeEventListener("pause", onPauseA);
      vA.removeEventListener("seeked", onSeekedA);
    };
  }, [videoA, videoB, compareMode]);

  // Slider drag handling
  const handleSliderMove = useCallback(
    (clientX: number) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = clientX - rect.left;
      const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
      setSliderPosition(pct);
    },
    []
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => handleSliderMove(e.clientX);
    const handleMouseUp = () => setIsDragging(false);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, handleSliderMove]);

  return (
    <BaseNode id={id} selected={selected} className="min-w-[200px]">
      {/* Two labeled video input handles */}
      <Handle
        type="target"
        position={Position.Left}
        id="video"
        data-handletype="video"
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
        id="video-1"
        data-handletype="video"
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
      {compareMode !== "slide" && videoA && videoB && (
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
      {videoA && videoB ? (
        <div className="flex-1 relative nodrag nopan nowheel">
          {compareMode === "slide" && (
            <div
              ref={containerRef}
              className="relative w-full overflow-hidden cursor-col-resize"
              style={{ minHeight: 200 }}
              onMouseDown={(e) => {
                setIsDragging(true);
                handleSliderMove(e.clientX);
              }}
            >
              {/* Video B (full width, underneath) */}
              <video
                ref={videoBRef}
                src={videoB}
                className="w-full h-full object-contain"
                muted
                playsInline
                controls={false}
                draggable={false}
              />
              {/* Video A (full width, clip-path wipes it) */}
              <video
                ref={videoARef}
                src={videoA}
                className="absolute inset-0 w-full h-full object-contain"
                style={{
                  clipPath: `inset(0 ${100 - sliderPosition}% 0 0)`,
                }}
                muted
                playsInline
                controls={false}
                draggable={false}
              />
              {/* Slider line */}
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-white/80 pointer-events-none"
                style={{ left: `${sliderPosition}%`, transform: "translateX(-50%)" }}
              >
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6 bg-white/90 rounded-full flex items-center justify-center shadow-md pointer-events-none">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    className="text-neutral-700"
                  >
                    <path
                      d="M4 2L1 6L4 10M8 2L11 6L8 10"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              </div>
              {/* Corner labels */}
              <div className="absolute top-2 left-2 bg-black/50 text-white text-[10px] font-medium px-2 py-1 rounded pointer-events-none">
                A
              </div>
              <div className="absolute top-2 right-2 bg-black/50 text-white text-[10px] font-medium px-2 py-1 rounded pointer-events-none">
                B
              </div>
            </div>
          )}

          {compareMode === "blend" && (
            <div className="relative w-full h-full" style={{ minHeight: 200 }}>
              <video
                ref={videoARef}
                src={videoA}
                className="w-full h-full object-contain"
                muted
                playsInline
                controls
                draggable={false}
              />
              <video
                ref={videoBRef}
                src={videoB}
                className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                style={{ opacity: blendOpacity }}
                muted
                playsInline
                controls={false}
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
              <video
                ref={videoARef}
                src={videoA}
                className="w-full h-full object-contain"
                muted
                playsInline
                controls
                draggable={false}
              />
              <video
                ref={videoBRef}
                src={videoB}
                className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                style={{
                  opacity: blendOpacity,
                  mixBlendMode: "difference",
                }}
                muted
                playsInline
                controls={false}
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
            {!videoA && !videoB
              ? "Connect 2 videos to compare"
              : "Connect another video to compare"}
          </span>
          {videoA && !videoB && (
            <div className="text-[9px] text-neutral-600">
              Video A connected
            </div>
          )}
          {!videoA && videoB && (
            <div className="text-[9px] text-neutral-600">
              Video B connected
            </div>
          )}
        </div>
      )}
    </BaseNode>
  );
}
