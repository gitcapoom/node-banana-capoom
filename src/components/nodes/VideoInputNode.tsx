"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { VideoInputNodeData } from "@/types";

type VideoInputNodeType = Node<VideoInputNodeData, "videoInput">;

export function VideoInputNode({ id, data, selected }: NodeProps<VideoInputNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);

  // Sync video element time updates
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    const onLoadedMetadata = () => {
      setVideoDuration(video.duration);
      if (nodeData.duration !== video.duration) {
        updateNodeData(id, { duration: video.duration });
      }
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("loadedmetadata", onLoadedMetadata);

    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, [id, nodeData.duration, updateNodeData]);

  const handlePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  }, []);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !videoDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, x / rect.width));
    video.currentTime = fraction * videoDuration;
  }, [videoDuration]);

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
      reader.onload = (event) => {
        const base64 = event.target?.result as string;

        // Extract duration using HTML Video element
        const tempVideo = document.createElement("video");
        tempVideo.preload = "metadata";
        tempVideo.onloadedmetadata = () => {
          updateNodeData(id, {
            videoFile: base64,
            filename: file.name,
            format: file.type,
            duration: tempVideo.duration,
          });
        };
        tempVideo.onerror = () => {
          updateNodeData(id, {
            videoFile: base64,
            filename: file.name,
            format: file.type,
            duration: null,
          });
        };
        tempVideo.src = base64;
      };
      reader.readAsDataURL(file);
    },
    [id, updateNodeData]
  );

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
    if (videoRef.current) {
      videoRef.current.pause();
    }
    setIsPlaying(false);
    setCurrentTime(0);
    setVideoDuration(0);
    updateNodeData(id, {
      videoFile: null,
      filename: null,
      duration: null,
      format: null,
    });
  }, [id, updateNodeData]);

  return (
    <BaseNode
      id={id}
      selected={selected}
      minWidth={280}
      minHeight={200}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="video/mp4,video/webm,video/quicktime,video/*"
        onChange={handleFileChange}
        className="hidden"
      />

      {nodeData.videoFile ? (
        <div className="relative group flex-1 flex flex-col min-h-0 gap-1.5">
          {/* Filename and duration */}
          <div className="flex items-center justify-between shrink-0">
            <span className="text-[10px] text-neutral-400 truncate max-w-[180px]" title={nodeData.filename || ""}>
              {nodeData.filename}
            </span>
            {nodeData.duration != null && (
              <span className="text-[10px] text-neutral-500 bg-neutral-700/50 px-1.5 py-0.5 rounded">
                {formatTime(nodeData.duration)}
              </span>
            )}
          </div>

          {/* Video player */}
          <div className="flex-1 min-h-[120px] bg-black rounded overflow-hidden relative">
            <video
              ref={videoRef}
              src={nodeData.videoFile}
              className="w-full h-full object-contain"
              preload="metadata"
              playsInline
              onClick={handlePlayPause}
            />
            {/* Big play overlay when paused */}
            {!isPlaying && (
              <div
                className="absolute inset-0 flex items-center justify-center bg-black/20 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={handlePlayPause}
              >
                <div className="w-10 h-10 flex items-center justify-center bg-black/60 rounded-full">
                  <svg className="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </div>
            )}
          </div>

          {/* Playback controls */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handlePlayPause}
              className="w-7 h-7 flex items-center justify-center bg-purple-600 hover:bg-purple-500 rounded transition-colors"
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Progress bar / scrubber */}
            <div
              className="flex-1 h-1.5 bg-neutral-700 rounded-full overflow-hidden relative cursor-pointer"
              onClick={handleSeek}
            >
              {videoDuration > 0 && (
                <div
                  className="h-full bg-purple-500 transition-all"
                  style={{ width: `${(currentTime / videoDuration) * 100}%` }}
                />
              )}
            </div>

            {/* Current time */}
            <span className="text-[10px] text-neutral-500 min-w-[32px] text-right">
              {formatTime(currentTime)}
            </span>
          </div>

          {/* Remove button */}
          <button
            onClick={handleRemove}
            className="absolute top-1 right-1 w-5 h-5 bg-black/60 text-white rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="w-full flex-1 min-h-[140px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center cursor-pointer hover:border-neutral-500 hover:bg-neutral-700/50 transition-colors"
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
  );
}
