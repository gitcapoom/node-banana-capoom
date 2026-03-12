"use client";

import React, { useCallback, useEffect, useState, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { useInlineParameters } from "@/hooks/useInlineParameters";
import { InlineParameterPanel } from "./InlineParameterPanel";
import type { AppleSharpNodeData } from "@/types";

type AppleSharpNodeType = Node<AppleSharpNodeData, "appleSharp">;

export function AppleSharpNode({
  id,
  data,
  selected,
}: NodeProps<AppleSharpNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);

  const [serverHealthy, setServerHealthy] = useState<boolean | null>(null);
  const healthCheckRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Inline parameters infrastructure
  const { inlineParametersEnabled } = useInlineParameters();
  const isParamsExpanded = nodeData.parametersExpanded ?? true;

  const handleToggleParams = useCallback(() => {
    updateNodeData(id, { parametersExpanded: !isParamsExpanded });
  }, [id, isParamsExpanded, updateNodeData]);

  // Check server health on mount and when serverUrl changes (debounced)
  useEffect(() => {
    if (healthCheckRef.current) clearTimeout(healthCheckRef.current);

    setServerHealthy(null);
    healthCheckRef.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/sharp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "health",
            serverUrl: nodeData.serverUrl,
          }),
        });
        const result = await res.json();
        setServerHealthy(result.success === true);
      } catch {
        setServerHealthy(false);
      }
    }, 500);

    return () => {
      if (healthCheckRef.current) clearTimeout(healthCheckRef.current);
    };
  }, [nodeData.serverUrl]);

  const handleRun = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const handleServerUrlChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { serverUrl: e.target.value });
    },
    [id, updateNodeData]
  );

  const handleRenderVideoToggle = useCallback(() => {
    updateNodeData(id, { renderVideo: !nodeData.renderVideo });
  }, [id, nodeData.renderVideo, updateNodeData]);

  const handleOpenFile = useCallback(() => {
    if (nodeData.savedFilePath) {
      fetch("/api/open-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: nodeData.savedFilePath }),
      }).catch(() => {});
    }
  }, [nodeData.savedFilePath]);

  // ─── Settings Controls (shared between inline and panel modes) ───

  const settingsControls = (
    <div className="space-y-3">
      {/* Server URL */}
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-neutral-500 font-medium">
            Server
          </label>
          {/* Health indicator */}
          {serverHealthy === null ? (
            <span className="w-1.5 h-1.5 rounded-full bg-neutral-600" />
          ) : serverHealthy ? (
            <span
              className="w-1.5 h-1.5 rounded-full bg-green-500"
              title="Server online"
            />
          ) : (
            <span
              className="w-1.5 h-1.5 rounded-full bg-red-500"
              title="Server unreachable"
            />
          )}
        </div>
        <input
          type="text"
          value={nodeData.serverUrl}
          onChange={handleServerUrlChange}
          className="nodrag nopan w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-300 focus:outline-none focus:border-orange-500 transition-colors"
          placeholder="http://capoompc21:8080"
        />
      </div>

      {/* Render Video Toggle */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={nodeData.renderVideo}
          onChange={handleRenderVideoToggle}
          className="nodrag nopan w-3.5 h-3.5 rounded bg-neutral-800 border-neutral-600 text-orange-500 focus:ring-orange-500 focus:ring-offset-0 cursor-pointer"
        />
        <span className="text-[11px] text-neutral-400">Render video</span>
      </label>
    </div>
  );

  return (
    <BaseNode
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      settingsExpanded={inlineParametersEnabled && isParamsExpanded}
      settingsPanel={inlineParametersEnabled ? (
        <InlineParameterPanel
          expanded={isParamsExpanded}
          onToggle={handleToggleParams}
          nodeId={id}
        >
          {settingsControls}
        </InlineParameterPanel>
      ) : undefined}
    >
      {/* Input Handle - Image */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        style={{ top: "50%" }}
        className="!w-3 !h-3 !bg-blue-500 !border-blue-700"
      />

      {/* Output Handle - 3D */}
      <Handle
        type="source"
        position={Position.Right}
        id="3d"
        style={{ top: "50%" }}
        className="!w-3 !h-3 !bg-emerald-500 !border-emerald-700"
      />

      <div className="p-3 space-y-3">
        {/* Status Area */}
        <div className="min-h-[60px]">
          {nodeData.status === "idle" && (
            <div className="rounded-lg border-2 border-dashed border-neutral-700 bg-neutral-900 flex items-center justify-center min-h-[60px]">
              <p className="text-[10px] text-neutral-600 text-center px-2">
                Connect an image and run
              </p>
            </div>
          )}

          {nodeData.status === "loading" && (
            <div className="rounded-lg bg-neutral-900 border border-neutral-700 flex flex-col items-center justify-center min-h-[60px] gap-2 py-3">
              <div className="w-5 h-5 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-[10px] text-orange-400">
                {nodeData.progress || "Generating..."}
              </p>
            </div>
          )}

          {nodeData.status === "complete" && (
            <div className="rounded-lg bg-neutral-900 border border-emerald-800 p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <svg
                  className="w-4 h-4 text-emerald-400 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="m21 7.5-9-5.25L3 7.5m18 0-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9"
                  />
                </svg>
                <span className="text-xs text-emerald-300 font-medium">
                  3D Model Generated
                </span>
              </div>

              {nodeData.savedFilename && (
                <button
                  onClick={handleOpenFile}
                  className="nodrag nopan text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors truncate block max-w-full text-left"
                  title={nodeData.savedFilePath || nodeData.savedFilename}
                >
                  {nodeData.savedFilename}
                </button>
              )}

              {nodeData.outputVideoUrl && (
                <p className="text-[10px] text-neutral-500">
                  + video trajectory
                </p>
              )}
            </div>
          )}

          {nodeData.status === "error" && (
            <div className="rounded-lg bg-red-950/30 border border-red-900/50 p-2">
              <p className="text-[10px] text-red-400 break-words">
                {nodeData.error || "Generation failed"}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Handle labels */}
      <div
        className="absolute left-5 text-[9px] text-neutral-600"
        style={{ top: "50%", transform: "translateY(-50%)" }}
      >
        image
      </div>
      <div
        className="absolute right-5 text-[9px] text-neutral-600"
        style={{ top: "50%", transform: "translateY(-50%)" }}
      >
        3d
      </div>
    </BaseNode>
  );
}
