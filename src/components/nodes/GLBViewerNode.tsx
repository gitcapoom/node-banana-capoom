"use client";

import { useCallback, useRef, useState, useEffect, useMemo } from "react";
import { Handle, Position, NodeProps, Node, useUpdateNodeInternals } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { useToast } from "@/components/Toast";
import { GLBViewerNodeData } from "@/types";
import { ThreeModelViewer } from "@/components/ThreeModelViewer";
import { MediaOverlay, CameraSettings } from "@/components/MediaOverlay";
import { saveMediaImmediately, loadMediaById } from "@/utils/mediaStorage";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { ASPECT_RATIO_PRESETS } from "@/utils/cinemaCameraPresets";

type GLBViewerNodeType = Node<GLBViewerNodeData, "glbViewer">;

export function GLBViewerNode({ id, data, selected }: NodeProps<GLBViewerNodeType>) {
  const nodeData = data as GLBViewerNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const addNode = useWorkflowStore((state) => state.addNode);
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const saveDirectoryPath = useWorkflowStore((state) => state.saveDirectoryPath);
  const updateNodeInternals = useUpdateNodeInternals();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<(() => string | null) | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const [isAutoCapturing, setIsAutoCapturing] = useState(false);
  const [frameGrabCount, setFrameGrabCount] = useState(0);

  // Force React Flow to re-compute handle positions after mount
  // (same pattern as RouterNode / ConditionalSwitchNode)
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, updateNodeInternals]);

  // Auto-hydrate glbUrl from glbFileRef after workflow reload
  // Mirrors Generate3DNode's auto-hydration pattern: hydrate in the component
  // via useEffect so React Flow re-measures handles when the data update triggers a re-render.
  const hydrationAttemptedRef = useRef(false);
  useEffect(() => {
    if (hydrationAttemptedRef.current) return;
    if (nodeData.glbUrl) return; // Already has URL
    if (!nodeData.glbFileRef) return; // No file ref to load from
    if (!saveDirectoryPath) return;

    hydrationAttemptedRef.current = true;
    loadMediaById(nodeData.glbFileRef, saveDirectoryPath, "inputs").then((dataUrl) => {
      if (!dataUrl) return;
      // Convert base64 data URL to blob URL
      try {
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return;
        const [, mime, base64] = match;
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: mime });
        const blobUrl = URL.createObjectURL(blob);
        updateNodeData(id, { glbUrl: blobUrl });
      } catch {
        console.warn("Failed to restore GLB blob URL from disk");
      }
    });
  }, [nodeData.glbUrl, nodeData.glbFileRef, saveDirectoryPath, id, updateNodeData]);

  // Resolve background image from "image-bg" handle connection
  const backgroundImage = useMemo(() => {
    const bgEdge = edges.find(e => e.target === id && e.targetHandle === "image-bg");
    if (!bgEdge) return null;
    const srcNode = nodes.find(n => n.id === bgEdge.source);
    if (!srcNode) return null;
    const output = getSourceOutput(srcNode, bgEdge.sourceHandle);
    return output?.type === "image" ? output.value : null;
  }, [id, edges, nodes]);

  // Compute aspect ratio from background image
  const [bgAspectRatio, setBgAspectRatio] = useState<number | null>(null);
  useEffect(() => {
    if (!backgroundImage) {
      setBgAspectRatio(null);
      return;
    }
    const img = new Image();
    img.onload = () => setBgAspectRatio(img.width / img.height);
    img.onerror = () => setBgAspectRatio(null);
    img.src = backgroundImage;
  }, [backgroundImage]);

  // Find closest ASPECT_RATIO_PRESETS index for background image aspect
  const bgAspectIndex = useMemo(() => {
    if (bgAspectRatio == null) return null;
    return ASPECT_RATIO_PRESETS.reduce((bestIdx, preset, idx) =>
      Math.abs(preset.ratio - bgAspectRatio) < Math.abs(ASPECT_RATIO_PRESETS[bestIdx].ratio - bgAspectRatio)
        ? idx
        : bestIdx
    , 0);
  }, [bgAspectRatio]);

  // Revoke blob URL when it changes or when node is unmounted
  const glbUrlRef = useRef<string | null>(nodeData.glbUrl);
  useEffect(() => {
    glbUrlRef.current = nodeData.glbUrl;
    return () => {
      if (glbUrlRef.current) {
        URL.revokeObjectURL(glbUrlRef.current);
      }
    };
  }, [nodeData.glbUrl]);

  // Auto-thumbnail when glbUrl changes
  useEffect(() => {
    if (nodeData.glbUrl && !nodeData.thumbnailImage) {
      setIsAutoCapturing(true);
    }
  }, [nodeData.glbUrl, nodeData.thumbnailImage]);

  // Shared file processing logic for both click-to-upload and drag-and-drop
  const processFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".glb")) {
        useToast.getState().show("Please upload a .GLB file", "warning");
        return;
      }

      if (file.size > 100 * 1024 * 1024) {
        useToast.getState().show("File too large. Maximum size is 100MB", "warning");
        return;
      }

      // Revoke previous URL if exists
      if (nodeData.glbUrl) {
        URL.revokeObjectURL(nodeData.glbUrl);
      }

      const url = URL.createObjectURL(file);

      // Save GLB file to disk BEFORE updating state to prevent race with auto-save.
      // Auto-save triggers on updateNodeData → hasUnsavedChanges, so glbFileRef must
      // already be set by the time that happens.
      let glbFileRef: string | undefined;
      if (saveDirectoryPath) {
        try {
          // Wrap in Blob with explicit MIME type — browsers report empty type for .glb files
          const glbBlob = new Blob([file], { type: "model/gltf-binary" });
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(glbBlob);
          });
          const refId = await saveMediaImmediately(dataUrl, saveDirectoryPath, "inputs");
          if (refId) {
            glbFileRef = refId;
          }
        } catch (error) {
          console.warn("Failed to save GLB file to disk:", error);
        }
      }

      updateNodeData(id, {
        glbUrl: url,
        filename: file.name,
        capturedImage: null,
        thumbnailImage: null,
        thumbnailImageRef: undefined,
        glbFileRef,
      });
    },
    [id, nodeData.glbUrl, updateNodeData, saveDirectoryPath]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      processFile(file);
    },
    [processFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      processFile(file);
    },
    [processFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleRemove = useCallback(() => {
    if (nodeData.glbUrl) {
      URL.revokeObjectURL(nodeData.glbUrl);
    }
    updateNodeData(id, {
      glbUrl: null,
      glbFileRef: undefined,
      filename: null,
      capturedImage: null,
      thumbnailImage: null,
      thumbnailImageRef: undefined,
    });
  }, [id, nodeData.glbUrl, updateNodeData]);

  // Auto-capture callback — saves thumbnail and outputs it
  const handleAutoCapture = useCallback(async (imageDataUrl: string) => {
    setIsAutoCapturing(false);

    // Save thumbnail to inputs folder
    let thumbnailRef: string | undefined;
    if (saveDirectoryPath) {
      const refId = await saveMediaImmediately(imageDataUrl, saveDirectoryPath, "inputs");
      if (refId) {
        thumbnailRef = refId;
      }
    }

    updateNodeData(id, {
      thumbnailImage: imageDataUrl,
      thumbnailImageRef: thumbnailRef,
      capturedImage: imageDataUrl, // Also set as output for the image pin
    });
  }, [id, saveDirectoryPath, updateNodeData]);

  // Frame grab from overlay — creates a new ImageInput node
  const handleFrameGrab = useCallback(async (frameDataUrl: string) => {
    const currentNode = nodes.find((n) => n.id === id);
    const nodeX = currentNode?.position?.x ?? 0;
    const nodeY = currentNode?.position?.y ?? 0;
    const nodeDims = defaultNodeDimensions.glbViewer;
    const imgNodeHeight = defaultNodeDimensions.imageInput.height;

    const offsetX = nodeDims.width + 40;
    const baseOffsetY = frameGrabCount * (imgNodeHeight + 20);

    // Save to inputs folder
    let imageRef: string | undefined;
    if (saveDirectoryPath) {
      const refId = await saveMediaImmediately(frameDataUrl, saveDirectoryPath, "inputs");
      if (refId) {
        imageRef = refId;
      }
    }

    addNode("imageInput", {
      x: nodeX + offsetX,
      y: nodeY + baseOffsetY,
    });

    setTimeout(() => {
      const latestNodes = useWorkflowStore.getState().nodes;
      const newNode = latestNodes[latestNodes.length - 1];
      if (newNode && newNode.type === "imageInput") {
        updateNodeData(newNode.id, {
          image: frameDataUrl,
          imageRef,
          filename: `3d-capture-${Date.now()}.png`,
        });
      }
    }, 50);

    setFrameGrabCount((c) => c + 1);
  }, [id, nodes, addNode, updateNodeData, frameGrabCount, saveDirectoryPath]);

  // Camera settings
  const cameraSettings: CameraSettings = useMemo(() => ({
    sensorIndex: nodeData.sensorIndex ?? 0,
    lensIndex: nodeData.lensIndex ?? 5,
    aspectIndex: nodeData.aspectIndex ?? 2,
    showGrid: nodeData.showGrid ?? false,
  }), [nodeData.sensorIndex, nodeData.lensIndex, nodeData.aspectIndex, nodeData.showGrid]);

  const handleCameraSettingsChange = useCallback((settings: CameraSettings) => {
    updateNodeData(id, {
      sensorIndex: settings.sensorIndex,
      lensIndex: settings.lensIndex,
      aspectIndex: settings.aspectIndex,
      showGrid: settings.showGrid,
    });
  }, [id, updateNodeData]);

  // No-op handlers for overlay (single model, no carousel)
  const noop = useCallback(() => {}, []);

  return (
    <>
    <BaseNode
      id={id}
      selected={selected}
    >
      {/* Image input handle for BG — positioned at bottom, matching Generate3DNode */}
      <Handle
        type="target"
        position={Position.Left}
        id="image-bg"
        style={{ bottom: 12, top: "auto" }}
        data-handletype="image"
        isConnectable={true}
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
        style={{
          right: `calc(100% + 8px)`,
          bottom: 16,
          color: "var(--handle-color-image)",
        }}
      >
        BG
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".glb"
        onChange={handleFileChange}
        className="hidden"
      />

      <div className="flex-1 flex flex-col min-h-0">
        {/* Preview area — matches Generate3DNode container pattern */}
        {nodeData.glbUrl || nodeData.thumbnailImage ? (
          <div
            className="relative w-full flex-1 min-h-[80px] flex flex-col items-center justify-center bg-neutral-800 rounded border border-neutral-700 overflow-hidden cursor-pointer group"
            onDoubleClick={(e) => { e.stopPropagation(); if (nodeData.glbUrl) setShowOverlay(true); }}
          >
            {/* Show thumbnail on canvas */}
            {nodeData.thumbnailImage ? (
              <img
                src={nodeData.thumbnailImage}
                alt={nodeData.filename || "3D model thumbnail"}
                className="w-full h-full object-contain"
                draggable={false}
              />
            ) : isAutoCapturing ? (
              <svg className="w-5 h-5 animate-spin text-neutral-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg className="w-8 h-8 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-2.25-1.313M21 7.5v2.25m0-2.25l-2.25 1.313M3 7.5l2.25-1.313M3 7.5l2.25 1.313M3 7.5v2.25m9 3l2.25-1.313M12 12.75l-2.25-1.313M12 12.75V15m0 6.75l2.25-1.313M12 21.75V19.5m0 2.25l-2.25-1.313m0-16.875L12 2.25l2.25 1.313M21 14.25v2.25l-2.25 1.313m-13.5 0L3 16.5v-2.25" />
              </svg>
            )}

            {/* Filename badge */}
            {nodeData.filename && (
              <div className="absolute top-1 left-1">
                <span className="text-[9px] text-white/70 bg-black/50 px-1.5 py-0.5 rounded truncate max-w-[120px]">
                  {nodeData.filename}
                </span>
              </div>
            )}

            {/* Re-upload hint when model is lost but thumbnail survived */}
            {!nodeData.glbUrl && nodeData.thumbnailImage && (
              <div
                className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
              >
                <span className="text-[11px] text-white/80 bg-black/60 px-2 py-1 rounded">Re-upload .GLB</span>
              </div>
            )}

            {/* Remove button */}
            <div className="absolute top-1 right-1">
              <button
                onClick={(e) => { e.stopPropagation(); handleRemove(); }}
                className="w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100"
                title="Remove model"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Double-click hint */}
            {nodeData.glbUrl && (
              <div className="absolute bottom-0 left-0 right-0 text-center py-1 bg-neutral-900/40">
                <span className="text-[10px] text-white/30">double click to view</span>
              </div>
            )}
          </div>
        ) : (
          <div
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            className="w-full flex-1 min-h-[112px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center cursor-pointer hover:bg-neutral-900/40 transition-colors"
          >
            <svg className="w-8 h-8 text-neutral-500 mb-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-2.25-1.313M21 7.5v2.25m0-2.25l-2.25 1.313M3 7.5l2.25-1.313M3 7.5l2.25 1.313M3 7.5v2.25m9 3l2.25-1.313M12 12.75l-2.25-1.313M12 12.75V15m0 6.75l2.25-1.313M12 21.75V19.5m0 2.25l-2.25-1.313m0-16.875L12 2.25l2.25 1.313M21 14.25v2.25l-2.25 1.313m-13.5 0L3 16.5v-2.25" />
            </svg>
            <span className="text-[10px] text-neutral-400">
              Drop .GLB or click
            </span>
          </div>
        )}
      </div>

      {/* Hidden auto-capture viewer */}
      {isAutoCapturing && nodeData.glbUrl && (
        <div style={{ position: 'absolute', width: 512, height: 512, opacity: 0, pointerEvents: 'none', overflow: 'hidden' }}>
          <ThreeModelViewer
            modelUrl={nodeData.glbUrl}
            onAutoCapture={handleAutoCapture}
            onLoadError={() => setIsAutoCapturing(false)}
            interactive={false}
          />
        </div>
      )}
    </BaseNode>

    {/* 3D Viewer Overlay */}
    {showOverlay && nodeData.glbUrl && (
      <MediaOverlay
        content={nodeData.glbUrl}
        mediaType="3d"
        currentIndex={0}
        totalCount={1}
        onPrevious={noop}
        onNext={noop}
        onClose={() => setShowOverlay(false)}
        onFrameGrab={handleFrameGrab}
        cameraSettings={cameraSettings}
        onCameraSettingsChange={handleCameraSettingsChange}
        backgroundImage={backgroundImage}
        aspectLocked={bgAspectIndex != null}
        lockedAspectIndex={bgAspectIndex ?? undefined}
      />
    )}
    </>
  );
}
