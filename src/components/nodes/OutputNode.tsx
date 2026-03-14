"use client";

import { useCallback, useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { OutputNodeData } from "@/types";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { useVideoAutoplay } from "@/hooks/useVideoAutoplay";
import { FileSaveDialog } from "../FileSaveDialog";
import { extractUpstreamWorkflow } from "@/utils/upstreamExtractor";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";

type OutputNodeType = Node<OutputNodeData, "output">;

export function OutputNode({ id, data, selected }: NodeProps<OutputNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const connectedEdgeCount = useWorkflowStore(
    (state) => state.edges.filter((edge) => edge.target === id).length
  );
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const saveDirectoryPath = useWorkflowStore((state) => state.saveDirectoryPath);
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const edgeStyle = useWorkflowStore((state) => state.edgeStyle);
  const [showLightbox, setShowLightbox] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const previousEdgeCountRef = useRef<number | null>(null);
  const videoAutoplayRef = useVideoAutoplay(id, selected);

  // ── Reactively pull upstream content (fixes #3 and #4) ──
  // This watches all connected upstream nodes' output data and auto-populates
  // the output node when upstream content becomes available, without requiring
  // the workflow execution system to run.
  // Returns a stable string "type|value" (primitive) to avoid Zustand infinite loops
  // from returning new object references on every selector call.
  const upstreamKey = useWorkflowStore(
    useCallback((state) => {
      const { images, videos, audio, model3d } = getConnectedInputsPure(id, state.nodes, state.edges);
      if (audio.length > 0) return `audio|${audio[0]}`;
      if (model3d) return `3d|${model3d}`;
      if (videos.length > 0) return `video|${videos[0]}`;
      if (images.length > 0) {
        const content = images[0];
        const isVid =
          content.startsWith("data:video/") ||
          content.includes(".mp4") ||
          content.includes(".webm") ||
          content.includes("fal.media");
        return `${isVid ? "video" : "image"}|${content}`;
      }
      return null;
    }, [id])
  );

  // Track previous upstream key to prevent unnecessary updates
  const prevUpstreamKeyRef = useRef<string | null>(null);

  // Sync pulled upstream content to this node's display data
  useEffect(() => {
    if (!upstreamKey) {
      prevUpstreamKeyRef.current = null;
      return;
    }

    // Skip if upstream content hasn't changed
    if (prevUpstreamKeyRef.current === upstreamKey) return;
    prevUpstreamKeyRef.current = upstreamKey;

    const pipeIdx = upstreamKey.indexOf("|");
    const type = upstreamKey.substring(0, pipeIdx);
    const value = upstreamKey.substring(pipeIdx + 1);

    if (type === "audio" && value !== nodeData.audio) {
      updateNodeData(id, { audio: value, image: null, video: null, model3d: null, contentType: "audio" });
    } else if (type === "3d" && value !== nodeData.model3d) {
      updateNodeData(id, { model3d: value, image: null, video: null, audio: null, contentType: "3d" });
    } else if (type === "video" && value !== nodeData.video) {
      updateNodeData(id, { image: value, video: value, model3d: null, audio: null, contentType: "video" });
    } else if (type === "image" && value !== nodeData.image) {
      updateNodeData(id, { image: value, video: null, model3d: null, audio: null, contentType: "image" });
    }
  }, [upstreamKey, id, nodeData.audio, nodeData.video, nodeData.image, nodeData.model3d, updateNodeData]);

  // Determine if content is audio
  const isAudio = useMemo(() => {
    if (nodeData.audio) return true;
    if (nodeData.contentType === "audio") return true;
    if (nodeData.image?.startsWith("data:audio/")) return true;
    return false;
  }, [nodeData.audio, nodeData.contentType, nodeData.image]);

  // Determine if content is video
  const isVideo = useMemo(() => {
    if (isAudio) return false;
    if (nodeData.video) return true;
    if (nodeData.contentType === "video") return true;
    if (nodeData.image?.startsWith("data:video/")) return true;
    if (nodeData.image?.includes(".mp4") || nodeData.image?.includes(".webm")) return true;
    return false;
  }, [isAudio, nodeData.video, nodeData.contentType, nodeData.image]);

  // Determine if content is a 3D model
  const isModel3d = useMemo(() => {
    if (isAudio || isVideo) return false;
    if (nodeData.model3d) return true;
    if (nodeData.contentType === "3d") return true;
    return false;
  }, [isAudio, isVideo, nodeData.model3d, nodeData.contentType]);

  // Get the content source (audio, video, 3D model, or image)
  const contentSrc = useMemo(() => {
    if (nodeData.audio) return nodeData.audio;
    if (nodeData.video) return nodeData.video;
    if (nodeData.model3d) return nodeData.model3d;
    return nodeData.image;
  }, [nodeData.audio, nodeData.video, nodeData.model3d, nodeData.image]);

  const videoBlobUrl = useVideoBlobUrl(isVideo ? contentSrc ?? null : null);

  // Auto-trigger execution when a new connection is made
  useEffect(() => {
    if (previousEdgeCountRef.current === null) {
      // First run — just record the baseline, don't trigger
      previousEdgeCountRef.current = connectedEdgeCount;
      return;
    }
    if (connectedEdgeCount > previousEdgeCountRef.current) {
      regenerateNode(id);
    }
    previousEdgeCountRef.current = connectedEdgeCount;
  }, [connectedEdgeCount, id, regenerateNode]);

  // Handle Run button click
  const handleRun = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  // Handle "Output Now" button click
  // Fix #1: Ensure output folder exists before opening save dialog
  const handleOutputNow = useCallback(async () => {
    if (!saveDirectoryPath) {
      alert("Please set a project directory first (File > Save As).");
      return;
    }

    // Create the outputs subdirectory if it doesn't exist
    const sep = saveDirectoryPath.includes("/") ? "/" : "\\";
    const outputsDir = `${saveDirectoryPath}${sep}outputs`;
    try {
      await fetch("/api/save-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: outputsDir,
          filename: ".keep",
          content: "",
          createDirectory: true,
        }),
      });
    } catch {
      // Ignore errors — the directory might already exist
    }

    setShowSaveDialog(true);
  }, [saveDirectoryPath]);

  // Handle save from dialog
  const handleSave = useCallback(async (directoryPath: string, filename: string) => {
    setShowSaveDialog(false);
    setSaveStatus("saving");

    try {
      // 1. Save the output file (image/video/audio/3d)
      const savePayload: Record<string, unknown> = {
        directoryPath,
        customFilename: filename,
        createDirectory: true,
      };

      if (isAudio && contentSrc) {
        savePayload.audio = contentSrc;
      } else if (isVideo && contentSrc) {
        savePayload.video = contentSrc;
      } else if (isModel3d && contentSrc) {
        savePayload.model3d = contentSrc;
      } else if (contentSrc) {
        savePayload.image = contentSrc;
      }

      const saveResponse = await fetch("/api/save-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(savePayload),
      });

      const saveResult = await saveResponse.json();
      if (!saveResult.success) {
        throw new Error(saveResult.error || "Failed to save output file");
      }

      // 2. Save the sidecar JSON (upstream workflow with embedded images)
      const sidecarWorkflow = extractUpstreamWorkflow(
        id,
        nodes,
        edges,
        edgeStyle,
        filename
      );

      await fetch("/api/save-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath,
          filename,
          content: sidecarWorkflow,
          createDirectory: true,
        }),
      });

      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (error) {
      console.error("Failed to save output:", error);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  }, [id, contentSrc, isAudio, isVideo, isModel3d, nodes, edges, edgeStyle]);

  const handleDownload = useCallback(async () => {
    if (!contentSrc) return;

    const timestamp = Date.now();
    const extension = isAudio ? "mp3" : isVideo ? "mp4" : isModel3d ? "glb" : "png";
    // Use custom filename if provided, otherwise use timestamp
    const filename = nodeData.outputFilename
      ? `${nodeData.outputFilename}.${extension}`
      : `generated-${timestamp}.${extension}`;

    // Handle URL-based content (needs fetch + blob conversion)
    if (contentSrc.startsWith("http://") || contentSrc.startsWith("https://")) {
      try {
        const response = await fetch(contentSrc);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(blobUrl);
      } catch (error) {
        console.error("Failed to download:", error);
      }
      return;
    }

    // Handle data URL content (direct download)
    const link = document.createElement("a");
    link.href = contentSrc;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [contentSrc, isAudio, isVideo, isModel3d, nodeData.outputFilename]);

  // Default filename for save dialog
  const defaultFilename = useMemo(() => {
    if (nodeData.outputFilename) return nodeData.outputFilename;
    return `output-${Date.now()}`;
  }, [nodeData.outputFilename]);

  // Default save path
  const defaultSavePath = useMemo(() => {
    if (saveDirectoryPath) {
      const sep = saveDirectoryPath.includes("/") ? "/" : "\\";
      return `${saveDirectoryPath}${sep}outputs`;
    }
    return undefined;
  }, [saveDirectoryPath]);

  // Extract filename from 3D model URL for display
  const model3dFilename = useMemo(() => {
    if (!isModel3d || !contentSrc) return null;
    try {
      const url = new URL(contentSrc);
      const segments = url.pathname.split("/").filter(Boolean);
      const last = segments[segments.length - 1];
      if (last && last.includes(".")) return last;
    } catch { /* not a URL */ }
    return "3D Model";
  }, [isModel3d, contentSrc]);

  // Determine the aspect-fit media for BaseNode (only for visual content, not 3D/audio)
  const aspectMedia = useMemo(() => {
    if (isAudio || isModel3d) return null;
    return contentSrc;
  }, [isAudio, isModel3d, contentSrc]);

  // Output Now button component (shared across all content types)
  const outputNowButton = (
    <button
      onClick={(e) => { e.stopPropagation(); handleOutputNow(); }}
      disabled={saveStatus === "saving"}
      className={`absolute bottom-2 left-2 right-2 z-10 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded shadow-lg transition-colors ${
        saveStatus === "saved"
          ? "bg-green-600 text-white"
          : saveStatus === "error"
          ? "bg-red-600 text-white"
          : saveStatus === "saving"
          ? "bg-blue-700 text-white opacity-70 cursor-wait"
          : "bg-blue-600 hover:bg-blue-500 text-white"
      }`}
    >
      {saveStatus === "saving" ? (
        <>
          <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
          Saving...
        </>
      ) : saveStatus === "saved" ? (
        <>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
          Saved!
        </>
      ) : saveStatus === "error" ? (
        "Save Failed"
      ) : (
        <>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          Output Now
        </>
      )}
    </button>
  );

  return (
    <>
      <BaseNode
        id={id}
        selected={selected}
        isExecuting={isRunning}
        contentClassName="flex-1 min-h-0 relative"
        className="min-w-[200px]"
        aspectFitMedia={aspectMedia}
      >
        {/* Single universal input handle — accepts image, video, audio, 3D */}
        <Handle
          type="target"
          position={Position.Left}
          id="universal"
          data-handletype="universal"
          style={{ zIndex: 10 }}
        />

        <div className="relative w-full h-full overflow-hidden rounded-lg">
        {contentSrc ? (
          <>
            {isAudio ? (
              <div className="w-full h-full flex items-center justify-center p-4">
                <audio
                  src={contentSrc}
                  controls
                  className="w-full rounded"
                />
              </div>
            ) : isModel3d ? (
              /* 3D model placeholder — show icon + filename */
              <div className="w-full h-full bg-neutral-900/60 flex flex-col items-center justify-center gap-3 p-4">
                <svg className="w-12 h-12 text-cyan-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
                </svg>
                <span className="text-xs text-neutral-300 text-center break-all max-w-full">
                  {model3dFilename}
                </span>
                <span className="text-[10px] text-neutral-500">3D Model</span>
              </div>
            ) : (
              <div
                className="relative cursor-pointer group w-full h-full"
                onClick={() => setShowLightbox(true)}
              >
                {isVideo ? (
                  <video
                    ref={videoAutoplayRef}
                    src={videoBlobUrl ?? undefined}
                    controls
                    loop
                    muted
                    playsInline
                    className="w-full h-full object-contain"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <img
                    src={contentSrc}
                    alt="Output"
                    className="w-full h-full object-contain"
                  />
                )}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center pointer-events-none">
                  <span className="text-[10px] font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 px-2 py-1 rounded">
                    View full size
                  </span>
                </div>
              </div>
            )}
            <button
              onClick={handleDownload}
              className="absolute top-2 right-2 p-1.5 bg-black/60 hover:bg-black/80 text-white text-xs rounded transition-colors flex items-center gap-1"
              title="Download"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </button>
            {/* Output Now button */}
            {outputNowButton}
          </>
        ) : (
          <div className="w-full h-full bg-neutral-900/40 flex flex-col items-center justify-center">
            <svg className="w-8 h-8 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
            <span className="text-xs text-neutral-500 mt-2">Connect input</span>
          </div>
        )}
        </div>
      </BaseNode>

      {/* Fix #5: File Save Dialog — portaled to document.body so it renders
          as a full-screen overlay, not clipped by React Flow's node transform */}
      {showSaveDialog && typeof document !== "undefined" && createPortal(
        <FileSaveDialog
          onSave={handleSave}
          onCancel={() => setShowSaveDialog(false)}
          initialPath={defaultSavePath}
          defaultFilename={defaultFilename}
        />,
        document.body
      )}

      {/* Lightbox Modal (skip for audio and 3D) — also portaled */}
      {showLightbox && contentSrc && !isAudio && !isModel3d && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8"
          onClick={() => setShowLightbox(false)}
        >
          <div className="relative max-w-full max-h-full">
            {isVideo ? (
              <video
                src={videoBlobUrl ?? undefined}
                controls
                loop
                autoPlay
                playsInline
                className="max-w-full max-h-[90vh] object-contain rounded"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <img
                src={contentSrc}
                alt="Output full size"
                className="max-w-full max-h-[90vh] object-contain rounded"
              />
            )}
            <button
              onClick={() => setShowLightbox(false)}
              className="absolute top-4 right-4 w-8 h-8 bg-white/10 hover:bg-white/20 rounded text-white text-sm transition-colors flex items-center justify-center"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
