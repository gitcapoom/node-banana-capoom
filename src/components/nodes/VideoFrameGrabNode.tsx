"use client";

import React from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { useCanRun } from "@/hooks/useCanRun";
import { useIncomingEdgeKey } from "@/hooks/useUpstreamHydration";
import { VideoFrameGrabNodeData } from "@/types";

type VideoFrameGrabNodeType = Node<VideoFrameGrabNodeData, "videoFrameGrab">;

export function VideoFrameGrabNode({ id, data, selected }: NodeProps<VideoFrameGrabNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const { canRun, isExecuting } = useCanRun(id);

  // Is a video WIRED here? Deliberately not "has the video resolved": both
  // `generateVideo.outputVideo` and `videoInput.videoFile` are nulled on open
  // with only a ref left behind, so the resolved value is null on every
  // reopened workflow. Gating the Extract button on the value left it
  // permanently disabled on a graph that is visibly connected — and unlike the
  // image nodes, no amount of Running repaired it, because no run pre-pass ever
  // hydrated video. The executor now pulls the clip back itself
  // (`ensureVideoInputs`), so the button only has to know an edge exists.
  const hasSourceVideo = Boolean(useIncomingEdgeKey(id));

  const canExtract = hasSourceVideo && nodeData.status !== "loading" && canRun;

  const handleExtract = () => {
    regenerateNode(id);
  };

  return (
    <BaseNode
      id={id}
      selected={selected}
      isExecuting={isExecuting}
      hasError={nodeData.status === "error"}
      minWidth={320}
      minHeight={320}
      aspectFitMedia={nodeData.outputImage}
    >
      {/* Video In (target, left, 50%) */}
      <Handle
        type="target"
        position={Position.Left}
        id="video"
        data-handletype="video"
        isConnectable={true}
        style={{ top: "50%" }}
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
        style={{ right: "calc(100% + 8px)", top: "calc(50% - 7px)", color: "rgb(168, 85, 247)" }}
      >
        Video In
      </div>

      {/* Image Out (source, right, 50%) */}
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        data-handletype="image"
        isConnectable={true}
        style={{ top: "50%" }}
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{ left: "calc(100% + 8px)", top: "calc(50% - 7px)", color: "rgb(59, 130, 246)" }}
      >
        Image Out
      </div>

      <div className="flex-1 flex flex-col min-h-0 gap-2">
        {/* Image preview area */}
        <div className="flex-1 min-h-0 relative">
          {nodeData.outputImage ? (
            <>
              <img data-node-media="outputImage"
                src={nodeData.outputImage}
                className="absolute inset-0 w-full h-full object-contain rounded"
                alt="Extracted frame"
              />
              {/* Clear output button */}
              <button
                onClick={() => updateNodeData(id, { outputImage: null, status: "idle" })}
                className="absolute top-1 right-1 w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Clear extracted frame"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center border border-dashed border-neutral-600 rounded">
              <span className="text-[10px] text-neutral-500 text-center px-4">
                Connect a video and extract a frame
              </span>
            </div>
          )}
        </div>

        {/* Frame position toggle (only when source video connected) */}
        {hasSourceVideo && (
          <div className="nodrag nowheel shrink-0 flex gap-1 px-1">
            <button
              onClick={() => updateNodeData(id, { framePosition: "first", outputImage: null })}
              className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                nodeData.framePosition === "first"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
              }`}
            >
              First
            </button>
            <button
              onClick={() => updateNodeData(id, { framePosition: "last", outputImage: null })}
              className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                nodeData.framePosition === "last"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
              }`}
            >
              Last
            </button>
          </div>
        )}

        {/* Extract Frame button */}
        <div className="shrink-0 flex justify-end px-1">
          <button
            onClick={handleExtract}
            disabled={!canExtract}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 disabled:cursor-not-allowed rounded text-white text-xs font-medium transition-colors"
          >
            {nodeData.status === "loading" ? "Extracting..." : "Extract Frame"}
          </button>
        </div>

        {/* Processing overlay */}
        {nodeData.status === "loading" && (
          <div className="absolute inset-0 bg-neutral-900/70 rounded flex flex-col items-center justify-center gap-2">
            <svg className="w-6 h-6 animate-spin text-white" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-white text-xs">Extracting frame...</span>
          </div>
        )}

        {/* Error display */}
        {nodeData.status === "error" && nodeData.error && (
          <div className="shrink-0 px-2 py-1.5 bg-red-900/30 border border-red-700/50 rounded">
            <p className="text-[10px] text-red-400 break-words">{nodeData.error}</p>
          </div>
        )}
      </div>
    </BaseNode>
  );
}
