"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { VideoInputNodeData } from "@/types";
import { MediaOverlay } from "../MediaOverlay";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { captureVideoThumbnail } from "@/utils/mediaCapture";
import { saveMediaImmediately, loadMediaById } from "@/utils/mediaStorage";

type VideoInputNodeType = Node<VideoInputNodeData, "videoInput">;

export function VideoInputNode({ id, data, selected }: NodeProps<VideoInputNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const addNode = useWorkflowStore((state) => state.addNode);
  const nodes = useWorkflowStore((state) => state.nodes);
  const saveDirectoryPath = useWorkflowStore((state) => state.saveDirectoryPath);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const [frameGrabCount, setFrameGrabCount] = useState(0);

  const formatTime = useCallback((seconds: number) => {
    if (!isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.type.match(/^video\//)) {
        alert("Unsupported format. Use MP4, WebM, or other video formats.");
        return;
      }

      if (file.size > 500 * 1024 * 1024) {
        alert("Video file too large. Maximum size is 500MB.");
        return;
      }

      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64 = event.target?.result as string;

        // Extract duration using HTML Video element
        const tempVideo = document.createElement("video");
        tempVideo.preload = "metadata";

        const durationPromise = new Promise<number | null>((resolve) => {
          tempVideo.onloadedmetadata = () => resolve(tempVideo.duration);
          tempVideo.onerror = () => resolve(null);
          setTimeout(() => resolve(null), 5000);
        });

        tempVideo.src = base64;
        const duration = await durationPromise;

        // Capture first frame as thumbnail
        const thumbnail = await captureVideoThumbnail(base64);

        // Save video and thumbnail to inputs folder if possible
        let videoFileRef: string | undefined;
        let thumbnailImageRef: string | undefined;
        if (saveDirectoryPath) {
          const videoRefId = await saveMediaImmediately(base64, saveDirectoryPath, "inputs");
          if (videoRefId) videoFileRef = videoRefId;

          if (thumbnail) {
            const thumbRefId = await saveMediaImmediately(thumbnail, saveDirectoryPath, "inputs");
            if (thumbRefId) thumbnailImageRef = thumbRefId;
          }
        }

        updateNodeData(id, {
          videoFile: base64,
          videoFileRef,
          thumbnailImage: thumbnail,
          thumbnailImageRef,
          filename: file.name,
          format: file.type,
          duration,
        });
      };
      reader.readAsDataURL(file);
    },
    [id, updateNodeData, saveDirectoryPath]
  );

  // Generate thumbnail if videoFile exists but thumbnailImage is missing (e.g. loaded from save)
  useEffect(() => {
    if (nodeData.videoFile && !nodeData.thumbnailImage) {
      captureVideoThumbnail(nodeData.videoFile).then((thumbnail) => {
        if (thumbnail) {
          updateNodeData(id, { thumbnailImage: thumbnail });
        }
      });
    }
  }, [id, nodeData.videoFile, nodeData.thumbnailImage, updateNodeData]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const file = e.dataTransfer.files?.[0];
      if (!file) return;

      const dt = new DataTransfer();
      dt.items.add(file);
      if (fileInputRef.current) {
        fileInputRef.current.files = dt.files;
        fileInputRef.current.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    []
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleRemove = useCallback(() => {
    updateNodeData(id, {
      videoFile: null,
      videoFileRef: undefined,
      thumbnailImage: null,
      thumbnailImageRef: undefined,
      filename: null,
      duration: null,
      format: null,
    });
  }, [id, updateNodeData]);

  // No-op handlers for overlay (single video, no carousel)
  const noop = useCallback(() => {}, []);

  // Frame grab: create a new ImageInput node with the captured frame
  const handleFrameGrab = useCallback(async (frameDataUrl: string) => {
    const currentNode = nodes.find((n) => n.id === id);
    const nodeX = currentNode?.position?.x ?? 0;
    const nodeY = currentNode?.position?.y ?? 0;
    const nodeDims = defaultNodeDimensions.videoInput;
    const imgNodeHeight = defaultNodeDimensions.imageInput.height;

    const offsetX = nodeDims.width + 40;
    const baseOffsetY = frameGrabCount * (imgNodeHeight + 20);

    // Save frame to inputs folder
    let imageRef: string | undefined;
    if (saveDirectoryPath) {
      const refId = await saveMediaImmediately(frameDataUrl, saveDirectoryPath, "inputs");
      if (refId) imageRef = refId;
    }

    addNode("imageInput", {
      x: nodeX + offsetX,
      y: nodeY + baseOffsetY,
    });

    // Update the new node with captured image data
    setTimeout(() => {
      const latestNodes = useWorkflowStore.getState().nodes;
      const newNode = latestNodes[latestNodes.length - 1];
      if (newNode && newNode.type === "imageInput") {
        updateNodeData(newNode.id, {
          image: frameDataUrl,
          imageRef,
          filename: `frame-grab-${Date.now()}.png`,
        });
      }
    }, 50);

    setFrameGrabCount((c) => c + 1);
  }, [id, nodes, addNode, updateNodeData, frameGrabCount, saveDirectoryPath]);

  // Whether a video is loaded (either in-memory or externalized to disk)
  const hasVideo = !!(nodeData.videoFile || nodeData.videoFileRef);

  // Display thumbnail of the video on canvas
  const displayImage = nodeData.thumbnailImage;

  // Lazy-load video from ref for overlay playback
  const [isLoadingVideo, setIsLoadingVideo] = useState(false);
  const handleOpenOverlay = useCallback(async () => {
    if (nodeData.videoFile) {
      // Video already in memory
      setShowOverlay(true);
      return;
    }
    if (nodeData.videoFileRef && saveDirectoryPath) {
      // Load from disk
      setIsLoadingVideo(true);
      const video = await loadMediaById(nodeData.videoFileRef, saveDirectoryPath, "inputs");
      setIsLoadingVideo(false);
      if (video) {
        updateNodeData(id, { videoFile: video });
        setShowOverlay(true);
      }
    }
  }, [id, nodeData.videoFile, nodeData.videoFileRef, saveDirectoryPath, updateNodeData]);

  return (
    <>
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip"
      aspectFitMedia={displayImage}
      fullBleed
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="video/mp4,video/webm,video/quicktime,video/*"
        onChange={handleFileChange}
        className="hidden"
      />

      {hasVideo ? (
        <div className="relative group w-full h-full">
          {/* Show thumbnail (first frame) instead of full video */}
          {displayImage ? (
            <img
              src={displayImage}
              alt={nodeData.filename || "Video thumbnail"}
              className="w-full h-full object-contain cursor-pointer"
              draggable={false}
              onDoubleClick={(e) => { e.stopPropagation(); handleOpenOverlay(); }}
            />
          ) : (
            <div
              className="w-full h-full bg-neutral-900/40 flex flex-col items-center justify-center cursor-pointer"
              onDoubleClick={(e) => { e.stopPropagation(); handleOpenOverlay(); }}
            >
              <svg className="w-10 h-10 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
            </div>
          )}

          {/* Filename and duration badge */}
          <div className="absolute top-1 left-1 flex items-center gap-1">
            {nodeData.filename && (
              <span className="text-[9px] text-white/70 bg-black/50 px-1.5 py-0.5 rounded truncate max-w-[120px]">
                {nodeData.filename}
              </span>
            )}
            {nodeData.duration != null && (
              <span className="text-[9px] text-white/70 bg-black/50 px-1.5 py-0.5 rounded">
                {formatTime(nodeData.duration)}
              </span>
            )}
          </div>

          {/* Remove button */}
          <button
            onClick={handleRemove}
            aria-label="Remove video"
            className="absolute top-1 right-1 w-5 h-5 bg-black/60 hover:bg-red-600/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {/* Loading overlay when fetching video from disk */}
          {isLoadingVideo && (
            <div className="absolute inset-0 bg-neutral-900/70 flex items-center justify-center">
              <svg className="w-5 h-5 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            </div>
          )}

          {/* Double-click hint */}
          <div className="absolute bottom-0 left-0 right-0 text-center py-1 bg-neutral-900/40">
            <span className="text-[10px] text-white/30">double click to view</span>
          </div>
        </div>
      ) : (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="w-full h-full min-h-[140px] bg-neutral-900/40 flex flex-col items-center justify-center cursor-pointer hover:bg-neutral-900/60 transition-colors"
        >
          <svg className="w-6 h-6 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
          </svg>
          <span className="text-[10px] text-neutral-400 mt-1">
            Drop video or click
          </span>
        </div>
      )}

      <Handle
        type="target"
        position={Position.Left}
        id="video"
        data-handletype="video"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="video"
        data-handletype="video"
      />
    </BaseNode>

    {showOverlay && nodeData.videoFile && (
      <MediaOverlay
        content={nodeData.videoFile}
        mediaType="video"
        currentIndex={0}
        totalCount={1}
        onPrevious={noop}
        onNext={noop}
        onClose={() => setShowOverlay(false)}
        onFrameGrab={handleFrameGrab}
      />
    )}
    </>
  );
}
