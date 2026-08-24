"use client";

import React, { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import { BaseNode } from "./BaseNode"
import { LoadingBadge } from "./LoadingBadge";
import { SplitGenerationButton } from "./SplitGenerationButton";
import { ModelParameters } from "./ModelParameters";
import { useWorkflowStore, useProviderApiKeys } from "@/store/workflowStore";
import { useCanRun } from "@/hooks/useCanRun";
import { Generate3DNodeData, ProviderType, SelectedModel, ModelInputDef } from "@/types";
import { useDynamicPinsEnabled } from "@/lib/dynamicPins";
import { DynamicInputHandles } from "./DynamicInputHandles";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { useToast } from "@/components/Toast";
import { ProviderBadge } from "./ProviderBadge";
import { getModelPageUrl, getProviderDisplayName } from "@/utils/providerUrls";
import { useInlineParameters } from "@/hooks/useInlineParameters";
import { InlineParameterPanel } from "./InlineParameterPanel";
import { browseRegistry } from "@/utils/browseRegistry";
import { MediaOverlay, CameraSettings } from "../MediaOverlay";
import { ThreeModelViewer } from "@/components/ThreeModelViewer";
import { saveMediaImmediately } from "@/utils/mediaStorage";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { getSourceOutput } from "@/store/utils/connectedInputs";
import { useHydrateUnresolvedInputs, useIncomingEdgeKey } from "@/hooks/useUpstreamHydration";
import { ASPECT_RATIO_PRESETS } from "@/utils/cinemaCameraPresets";

// 3D generation capabilities
const THREE_D_CAPABILITIES: ModelCapability[] = ["text-to-3d", "image-to-3d"];

type Generate3DNodeType = Node<Generate3DNodeData, "generate3d">;

export function Generate3DNode({ id, data, selected }: NodeProps<Generate3DNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const addNode = useWorkflowStore((state) => state.addNode);
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const generationsPath = useWorkflowStore((state) => state.generationsPath);
  const saveDirectoryPath = useWorkflowStore((state) => state.saveDirectoryPath);
  const { replicateApiKey, falApiKey, kieApiKey } = useProviderApiKeys();
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);
  const [isLoadingCarousel3D, setIsLoadingCarousel3D] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [isAutoCapturing, setIsAutoCapturing] = useState(false);
  const [frameGrabCount, setFrameGrabCount] = useState(0);

  const updateNodeInternals = useUpdateNodeInternals();

  // Tell React Flow to recalculate handle positions when schema changes
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, nodeData.inputSchema, updateNodeInternals]);

  // Resolve background image from "image-bg" handle connection
  const backgroundImage = useMemo(() => {
    const bgEdge = edges.find(e => e.target === id && e.targetHandle === "image-bg");
    if (!bgEdge) return null;
    const srcNode = nodes.find(n => n.id === bgEdge.source);
    if (!srcNode) return null;
    const output = getSourceOutput(srcNode, bgEdge.sourceHandle);
    return output?.type === "image" ? output.value : null;
  }, [id, edges, nodes]);

  // Wired vs resolved — see useUpstreamHydration. The TRIGGER is scoped to the
  // bg handle (the load itself is per-node and cannot be narrower): only an
  // unresolved backdrop is worth a request, because that is the one input this
  // node has to display before a run. Keyed on the whole input set instead,
  // every generate3d node on the canvas would hydrate its prompts and control
  // images at open too — which is the run pre-pass's job, not the node's.
  const bgEdgeKey = useIncomingEdgeKey(id, "image-bg");
  useHydrateUnresolvedInputs(id, bgEdgeKey, !!backgroundImage);

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

  // In-memory caches keyed by history item ID — survive carousel navigation within session
  const thumbnailCacheRef = useRef<Map<string, string>>(new Map());
  const modelUrlCacheRef = useRef<Map<string, string>>(new Map());

  // Inline parameters infrastructure
  const { inlineParametersEnabled } = useInlineParameters();
  const dynamicPinsOn = useDynamicPinsEnabled();

  // Register browse callback for floating header button
  useEffect(() => {
    browseRegistry.register(id, () => setIsBrowseDialogOpen(true));
    return () => { browseRegistry.unregister(id); };
  }, [id]);

  // Get the current selected provider (default to fal since most 3D models are there)
  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "fal";

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      updateNodeData(id, { parameters });
    },
    [id, updateNodeData]
  );

  // Handle inputs loaded from schema
  const handleInputsLoaded = useCallback(
    (inputs: ModelInputDef[]) => {
      updateNodeData(id, { inputSchema: inputs });
    },
    [id, updateNodeData]
  );

  // Handle parameters expand/collapse - resize node height
  const { setNodes } = useReactFlow();
  const handleParametersExpandChange = useCallback(
    (expanded: boolean, parameterCount: number) => {
      const parameterHeight = expanded ? Math.max(parameterCount * 28 + 16, 60) : 0;
      const baseHeight = 300;
      const newHeight = baseHeight + parameterHeight;

      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === id
            ? { ...node, style: { ...node.style, height: newHeight } }
            : node
        )
      );
    },
    [id, setNodes]
  );

  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const { isExecuting } = useCanRun(id);

  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  // Cache current model URL in memory so carousel recall skips disk I/O
  useEffect(() => {
    if (nodeData.output3dUrl) {
      const currentItem = (nodeData.model3dHistory || [])[nodeData.selectedModel3dHistoryIndex || 0];
      if (currentItem) {
        modelUrlCacheRef.current.set(currentItem.id, nodeData.output3dUrl);
      }
    }
  }, [nodeData.output3dUrl, nodeData.model3dHistory, nodeData.selectedModel3dHistoryIndex]);

  // Auto-thumbnail when output3dUrl changes
  useEffect(() => {
    if (nodeData.output3dUrl && !nodeData.thumbnailImage) {
      setIsAutoCapturing(true);
    }
  }, [nodeData.output3dUrl, nodeData.thumbnailImage]);

  // Auto-capture callback — caches in memory and saves to generations folder
  const handleAutoCapture = useCallback(async (imageDataUrl: string) => {
    setIsAutoCapturing(false);

    // Cache thumbnail in memory for instant carousel recall
    const historyItem = (nodeData.model3dHistory || [])[nodeData.selectedModel3dHistoryIndex || 0];
    if (historyItem) {
      thumbnailCacheRef.current.set(historyItem.id, imageDataUrl);
    }

    // Save thumbnail to generations folder for persistence across sessions
    let thumbnailRef: string | undefined;
    if (saveDirectoryPath) {
      const refId = await saveMediaImmediately(
        imageDataUrl,
        saveDirectoryPath,
        "generations",
        historyItem ? `${historyItem.id}_thumb` : undefined
      );
      if (refId) {
        thumbnailRef = refId;
      }
    }

    updateNodeData(id, {
      thumbnailImage: imageDataUrl,
      thumbnailImageRef: thumbnailRef,
    });
  }, [id, saveDirectoryPath, nodeData.model3dHistory, nodeData.selectedModel3dHistoryIndex, updateNodeData]);

  // Load 3D model URL by ID from generations folder
  const load3DById = useCallback(async (modelId: string) => {
    if (!generationsPath) {
      console.error("Generations path not configured");
      return null;
    }

    try {
      const response = await fetch("/api/load-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: generationsPath,
          imageId: modelId,
        }),
      });

      const result = await response.json();
      if (!result.success) {
        console.log(`3D model not found: ${modelId}`);
        return null;
      }
      return result.model3d || result.image;
    } catch (error) {
      console.warn("Error loading 3D model:", error);
      return null;
    }
  }, [generationsPath]);

  // Auto-hydrate output3dUrl from history after workflow reload
  // When a workflow is loaded from disk, output3dUrl is null but model3dHistory
  // still has items whose 3D files are saved in the generations folder.
  const hydrationAttemptedRef = useRef(false);
  useEffect(() => {
    if (hydrationAttemptedRef.current) return;
    if (nodeData.output3dUrl) return; // Already has URL, no need to hydrate
    if (!nodeData.model3dHistory || nodeData.model3dHistory.length === 0) return;
    if (!generationsPath) return; // Can't load without a path

    hydrationAttemptedRef.current = true;
    const currentItem = nodeData.model3dHistory[nodeData.selectedModel3dHistoryIndex || 0];
    if (currentItem) {
      load3DById(currentItem.id).then((url) => {
        if (url) {
          modelUrlCacheRef.current.set(currentItem.id, url);
          updateNodeData(id, { output3dUrl: url });
        }
      });
    }
  }, [nodeData.output3dUrl, nodeData.model3dHistory, nodeData.selectedModel3dHistoryIndex, generationsPath, id, load3DById, updateNodeData]);

  // Load a cached thumbnail from disk by history item ID
  const loadThumbnailById = useCallback(async (historyItemId: string): Promise<string | null> => {
    if (!generationsPath) return null;
    try {
      const response = await fetch("/api/load-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: generationsPath,
          imageId: `${historyItemId}_thumb`,
        }),
      });
      const result = await response.json();
      if (result.success && result.image) return result.image;
    } catch { /* not cached — will auto-capture */ }
    return null;
  }, [generationsPath]);

  // Navigate carousel and recall settings from the history item
  const navigateCarousel = useCallback(async (newIndex: number) => {
    const history = nodeData.model3dHistory || [];
    if (history.length === 0 || isLoadingCarousel3D) return;

    const historyItem = history[newIndex];

    // Check in-memory caches first (instant — no disk I/O)
    const cachedModel = modelUrlCacheRef.current.get(historyItem.id);
    const cachedThumb = thumbnailCacheRef.current.get(historyItem.id);

    // If both are cached in memory, update immediately without any async work
    if (cachedModel && cachedThumb) {
      const settingsUpdate: Record<string, unknown> = {
        output3dUrl: cachedModel,
        selectedModel3dHistoryIndex: newIndex,
        thumbnailImage: cachedThumb,
        thumbnailImageRef: `${historyItem.id}_thumb`,
      };
      if (historyItem.prompt !== undefined) settingsUpdate.inputPrompt = historyItem.prompt;
      if (historyItem.selectedModel) settingsUpdate.selectedModel = historyItem.selectedModel;
      if (historyItem.parameters) settingsUpdate.parameters = historyItem.parameters;
      updateNodeData(id, settingsUpdate);
      return;
    }

    setIsLoadingCarousel3D(true);

    // Only load from disk what we don't have in memory
    const [model3dUrl, diskThumbnail] = await Promise.all([
      cachedModel ? Promise.resolve(cachedModel) : load3DById(historyItem.id),
      cachedThumb ? Promise.resolve(null) : loadThumbnailById(historyItem.id),
    ]);
    setIsLoadingCarousel3D(false);

    if (model3dUrl) {
      const thumbnail = cachedThumb || diskThumbnail;

      // Populate memory caches for future navigations
      if (!cachedModel) modelUrlCacheRef.current.set(historyItem.id, model3dUrl);
      if (diskThumbnail && !cachedThumb) thumbnailCacheRef.current.set(historyItem.id, diskThumbnail);

      // Recall stored settings from the history item
      const settingsUpdate: Record<string, unknown> = {
        output3dUrl: model3dUrl,
        selectedModel3dHistoryIndex: newIndex,
        // Use cached thumbnail if available, otherwise null triggers auto-capture
        thumbnailImage: thumbnail,
        thumbnailImageRef: thumbnail ? `${historyItem.id}_thumb` : undefined,
      };
      if (historyItem.prompt !== undefined) settingsUpdate.inputPrompt = historyItem.prompt;
      if (historyItem.selectedModel) settingsUpdate.selectedModel = historyItem.selectedModel;
      if (historyItem.parameters) settingsUpdate.parameters = historyItem.parameters;

      updateNodeData(id, settingsUpdate);
    }
  }, [id, nodeData.model3dHistory, isLoadingCarousel3D, load3DById, loadThumbnailById, updateNodeData]);

  const handleCarouselPrevious = useCallback(async () => {
    const history = nodeData.model3dHistory || [];
    if (history.length === 0) return;
    const currentIndex = nodeData.selectedModel3dHistoryIndex || 0;
    const newIndex = currentIndex === 0 ? history.length - 1 : currentIndex - 1;
    await navigateCarousel(newIndex);
  }, [nodeData.model3dHistory, nodeData.selectedModel3dHistoryIndex, navigateCarousel]);

  const handleCarouselNext = useCallback(async () => {
    const history = nodeData.model3dHistory || [];
    if (history.length === 0) return;
    const currentIndex = nodeData.selectedModel3dHistoryIndex || 0;
    const newIndex = (currentIndex + 1) % history.length;
    await navigateCarousel(newIndex);
  }, [nodeData.model3dHistory, nodeData.selectedModel3dHistoryIndex, navigateCarousel]);

  const hasCarousel3D = (nodeData.model3dHistory || []).length > 1;

  // Handle model selection from browse dialog
  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    const newSelectedModel: SelectedModel = {
      provider: model.provider,
      modelId: model.id,
      displayName: model.name,
    };
    updateNodeData(id, { selectedModel: newSelectedModel, parameters: {} });
    setIsBrowseDialogOpen(false);
  }, [id, updateNodeData]);

  // Dynamic title based on selected model
  const displayTitle = useMemo(() => {
    if (nodeData.selectedModel?.displayName && nodeData.selectedModel.modelId) {
      return nodeData.selectedModel.displayName;
    }
    return "Select 3D model...";
  }, [nodeData.selectedModel?.displayName, nodeData.selectedModel?.modelId]);

  // Inline parameters: compute collapse state and toggle handler
  const isParamsExpanded = nodeData.parametersExpanded ?? true; // default expanded

  const handleToggleParams = useCallback(() => {
    updateNodeData(id, { parametersExpanded: !isParamsExpanded });
  }, [id, isParamsExpanded, updateNodeData]);

  // Track previous status to detect error transitions
  const prevStatusRef = useRef(nodeData.status);

  // Show toast when error occurs
  useEffect(() => {
    if (nodeData.status === "error" && prevStatusRef.current !== "error" && nodeData.error) {
      useToast.getState().show("3D generation failed", "error", true, nodeData.error);
    }
    prevStatusRef.current = nodeData.status;
  }, [nodeData.status, nodeData.error]);

  const handleClear3D = useCallback(() => {
    updateNodeData(id, {
      output3dUrl: null,
      savedFilename: null,
      savedFilePath: null,
      thumbnailImage: null,
      thumbnailImageRef: undefined,
      status: "idle",
      error: null,
    });
  }, [id, updateNodeData]);

  // Frame grab from overlay — creates a new ImageInput node
  const handleFrameGrab = useCallback(async (frameDataUrl: string) => {
    const currentNode = nodes.find((n) => n.id === id);
    const nodeX = currentNode?.position?.x ?? 0;
    const nodeY = currentNode?.position?.y ?? 0;
    const nodeDims = defaultNodeDimensions.generate3d;
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

  return (
    <>
    <BaseNode
      id={id}
      selected={selected}
      settingsExpanded={inlineParametersEnabled && isParamsExpanded}
      isExecuting={isExecuting}
      hasError={nodeData.status === "error"}
      settingsPanel={inlineParametersEnabled ? (
        <InlineParameterPanel
          expanded={isParamsExpanded}
          onToggle={handleToggleParams}
          nodeId={id}
        >
          {/* Model selector: Browse button + current model display */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-neutral-200 truncate">
                {displayTitle}
              </div>
              <div className="text-[9px] text-neutral-500">
                {currentProvider}
              </div>
            </div>
            <button
              onClick={() => setIsBrowseDialogOpen(true)}
              className="nodrag nopan shrink-0 px-2 py-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
            >
              Browse
            </button>
          </div>

          {/* External provider parameters - reuse ModelParameters component */}
          {nodeData.selectedModel?.modelId && (
            <ModelParameters
              modelId={nodeData.selectedModel.modelId}
              provider={currentProvider}
              parameters={nodeData.parameters || {}}
              onParametersChange={handleParametersChange}
              onInputsLoaded={handleInputsLoaded}
            />
          )}
        </InlineParameterPanel>
      ) : undefined}
    >
      {/* Dynamic input handles based on model schema */}
      {dynamicPinsOn ? (
        <DynamicInputHandles nodeId={id} inputSchema={nodeData.inputSchema} />
      ) : nodeData.inputSchema && nodeData.inputSchema.length > 0 ? (
        (() => {
          const imageInputs = nodeData.inputSchema!.filter(i => i.type === "image");
          const textInputs = nodeData.inputSchema!.filter(i => i.type === "text");
          const videoInputs = nodeData.inputSchema!.filter(i => i.type === "video");
          const audioInputs = nodeData.inputSchema!.filter(i => i.type === "audio");

          const hasImageInput = imageInputs.length > 0;
          const hasTextInput = textInputs.length > 0;

          type HandleType = "image" | "text" | "video" | "audio";
          const handles: Array<{
            id: string;
            type: HandleType;
            label: string;
            schemaName: string | null;
            description: string | null;
            isPlaceholder: boolean;
          }> = [];

          const addHandles = (inputs: typeof imageInputs, handleType: HandleType) => {
            inputs.forEach((input, index) => {
              handles.push({
                id: index === 0 ? handleType : `${handleType}-${index}`,
                type: handleType,
                label: input.label,
                schemaName: input.name,
                description: input.description || null,
                isPlaceholder: false,
              });
            });
          };

          if (hasImageInput) {
            addHandles(imageInputs, "image");
          } else {
            handles.push({
              id: "image", type: "image", label: "Image",
              schemaName: null, description: "Not used by this model", isPlaceholder: true,
            });
          }

          addHandles(videoInputs, "video");
          addHandles(audioInputs, "audio");

          if (hasTextInput) {
            addHandles(textInputs, "text");
          } else {
            handles.push({
              id: "text", type: "text", label: "Prompt",
              schemaName: null, description: "Not used by this model", isPlaceholder: true,
            });
          }

          const handleColors: Record<HandleType, string> = {
            image: "var(--handle-color-image, #3b82f6)",
            video: "var(--handle-color-video, #0d9488)",
            audio: "var(--handle-color-audio, #8b5cf6)",
            text: "var(--handle-color-text, #f59e0b)",
          };
          const mediaHandles = handles.filter(h => h.type !== "text");
          const textHandles = handles.filter(h => h.type === "text");
          const totalSlots = mediaHandles.length + textHandles.length + 1;

          const renderedHandles = handles.map((handle) => {
            const isText = handle.type === "text";
            const typeGroup = isText ? textHandles : mediaHandles;
            const typeIndex = typeGroup.findIndex(h => h.id === handle.id);
            const adjustedIndex = isText ? mediaHandles.length + 1 + typeIndex : typeIndex;
            const topPercent = ((adjustedIndex + 1) / (totalSlots + 1)) * 100;

            return (
              <React.Fragment key={handle.id}>
                <Handle
                  type="target"
                  position={Position.Left}
                  id={handle.id}
                  style={{
                    top: `${topPercent}%`,
                    opacity: handle.isPlaceholder ? 0.3 : 1,
                  }}
                  data-handletype={handle.type}
                  data-schema-name={handle.schemaName || undefined}
                  isConnectable={true}
                  title={handle.description || handle.label}
                />
                <div
                  className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
                  style={{
                    right: `calc(100% + 8px)`,
                    top: `calc(${topPercent}% - 18px)`,
                    color: handleColors[handle.type],
                    opacity: handle.isPlaceholder ? 0.3 : 1,
                  }}
                >
                  {handle.label}
                </div>
              </React.Fragment>
            );
          });

          return <>{renderedHandles}</>;
        })()
      ) : (
        // Default handles when no schema
        <>
          <Handle
            type="target"
            position={Position.Left}
            id="image"
            style={{ top: "35%" }}
            data-handletype="image"
            isConnectable={true}
          />
          <div
            className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
            style={{
              right: `calc(100% + 8px)`,
              top: "calc(35% - 18px)",
              color: "var(--handle-color-image)",
            }}
          >
            Image
          </div>
          <Handle
            type="target"
            position={Position.Left}
            id="text"
            style={{ top: "65%" }}
            data-handletype="text"
          />
          <div
            className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
            style={{
              right: `calc(100% + 8px)`,
              top: "calc(65% - 18px)",
              color: "var(--handle-color-text)",
            }}
          >
            Prompt
          </div>
        </>
      )}

      {/* Background image input handle — always present, positioned at bottom of node */}
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

      {/* 3D output handle */}
      <Handle
        type="source"
        position={Position.Right}
        id="3d"
        data-handletype="3d"
      />
      {/* Output label */}
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{
          left: `calc(100% + 8px)`,
          top: "calc(50% - 18px)",
          color: "var(--handle-color-3d)",
        }}
      >
        3D
      </div>

      <div className="flex-1 flex flex-col min-h-0 gap-2">
        {/* Preview area */}
        {nodeData.output3dUrl ? (
          <div
            className="relative w-full flex-1 min-h-[80px] flex flex-col items-center justify-center bg-neutral-800 rounded border border-neutral-700 overflow-hidden cursor-pointer"
            onDoubleClick={(e) => { e.stopPropagation(); setShowOverlay(true); }}
          >
            <SplitGenerationButton id={id} count={nodeData.model3dHistory?.length ?? 0} />
            {/* Show thumbnail image if available, otherwise 3D icon */}
            {nodeData.thumbnailImage ? (
              <img
                src={nodeData.thumbnailImage}
                alt="3D model thumbnail"
                className="w-full h-full object-contain"
                draggable={false}
              />
            ) : isAutoCapturing ? (
              <svg className="w-5 h-5 animate-spin text-neutral-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg className="w-8 h-8 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-2.25-1.313M21 7.5v2.25m0-2.25l-2.25 1.313M3 7.5l2.25-1.313M3 7.5l2.25 1.313M3 7.5v2.25m9 3l2.25-1.313M12 12.75l-2.25-1.313M12 12.75V15m0 6.75l2.25-1.313M12 21.75V19.5m0 2.25l-2.25-1.313m0-16.875L12 2.25l2.25 1.313M21 14.25v2.25l-2.25 1.313m-13.5 0L3 16.5v-2.25" />
              </svg>
            )}
            {/* Saved filename */}
            {nodeData.savedFilename ? (
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!nodeData.savedFilePath) {
                    useToast.getState().show("No file path available", "error");
                    return;
                  }
                  try {
                    const res = await fetch("/api/open-file", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ filePath: nodeData.savedFilePath }),
                    });
                    if (!res.ok) {
                      const detail = await res.text().catch(() => `Status ${res.status}`);
                      useToast.getState().show("Failed to open file", "error", true, detail);
                    }
                  } catch (err) {
                    console.error("Failed to open file location:", err);
                    useToast.getState().show("Failed to open file location", "error");
                  }
                }}
                className="nodrag nopan absolute bottom-8 text-[10px] text-neutral-400 hover:text-orange-300 truncate max-w-full cursor-pointer transition-colors flex items-center gap-1 px-2"
                title={`Open in explorer: ${nodeData.savedFilePath}`}
              >
                <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                {nodeData.savedFilename}
              </button>
            ) : null}
            {/* Loading overlay for re-generation */}
            {nodeData.status === "loading" && (
              <div className="absolute inset-0 bg-neutral-900/70 rounded flex items-center justify-center">
                <LoadingBadge
                  active
                  loadingStartedAt={nodeData.loadingStartedAt}
                  loadingPhase={nodeData.loadingPhase}
                  queuePosition={nodeData.queuePosition}
                />
                <svg className="w-6 h-6 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </div>
            )}
            {/* Error overlay */}
            {nodeData.status === "error" && (
              <div className="absolute inset-0 bg-red-900/40 rounded flex flex-col items-center justify-center gap-1">
                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-white text-xs font-medium">Generation failed</span>
                <span className="text-white/70 text-[10px]">See toast for details</span>
              </div>
            )}
            {/* Loading overlay for carousel navigation */}
            {isLoadingCarousel3D && (
              <div className="absolute inset-0 bg-neutral-900/50 rounded flex items-center justify-center">
                <svg className="w-4 h-4 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </div>
            )}
            <div className="absolute top-1 right-1">
              <button
                onClick={(e) => { e.stopPropagation(); handleClear3D(); }}
                className="w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Clear 3D model"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* Carousel controls OR double-click hint — never both */}
            {hasCarousel3D ? (
              <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-2 py-1.5 bg-neutral-900/60 backdrop-blur-sm rounded-b">
                <button
                  onClick={(e) => { e.stopPropagation(); handleCarouselPrevious(); }}
                  disabled={isLoadingCarousel3D}
                  className="w-5 h-5 rounded hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-white/70 hover:text-white transition-colors"
                  title="Previous 3D model"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <span className="text-[10px] text-white/70 min-w-[32px] text-center">
                  {(nodeData.selectedModel3dHistoryIndex || 0) + 1} / {(nodeData.model3dHistory || []).length}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleCarouselNext(); }}
                  disabled={isLoadingCarousel3D}
                  className="w-5 h-5 rounded hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-white/70 hover:text-white transition-colors"
                  title="Next 3D model"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            ) : nodeData.status !== "loading" && (
              <div className="absolute bottom-0 left-0 right-0 text-center py-1 bg-neutral-900/40">
                <span className="text-[10px] text-white/30">double click to view</span>
              </div>
            )}
          </div>
        ) : (
          <div className="w-full flex-1 min-h-[112px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center">
            {nodeData.status === "loading" ? (
              <svg className="w-4 h-4 animate-spin text-neutral-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : nodeData.status === "error" ? (
              <span className="text-[10px] text-red-400 text-center px-2">
                {nodeData.error || "Failed"}
              </span>
            ) : (
              <span className="text-neutral-500 text-[10px]">
                Run to generate
              </span>
            )}
          </div>
        )}

        {/* Hidden ModelParameters — only for schema-loading side effect (dynamic handles) when inline disabled */}
        {!inlineParametersEnabled && nodeData.selectedModel?.modelId && (
          <div className="hidden">
            <ModelParameters
              modelId={nodeData.selectedModel.modelId}
              provider={currentProvider}
              parameters={nodeData.parameters || {}}
              onParametersChange={handleParametersChange}
              onExpandChange={handleParametersExpandChange}
              onInputsLoaded={handleInputsLoaded}
            />
          </div>
        )}

      </div>

      {/* Hidden auto-capture viewer */}
      {isAutoCapturing && nodeData.output3dUrl && (
        <div style={{ position: 'absolute', width: 512, height: 512, opacity: 0, pointerEvents: 'none', overflow: 'hidden' }}>
          <ThreeModelViewer
            modelUrl={nodeData.output3dUrl}
            onAutoCapture={handleAutoCapture}
            onLoadError={() => setIsAutoCapturing(false)}
            interactive={false}
          />
        </div>
      )}
    </BaseNode>

    {/* Model browser dialog */}
    {isBrowseDialogOpen && (
      <ModelSearchDialog
        isOpen={isBrowseDialogOpen}
        onClose={() => setIsBrowseDialogOpen(false)}
        onModelSelected={handleBrowseModelSelect}
        initialCapabilityFilter="3d"
      />
    )}
    {/* 3D overlay — interactive Three.js viewer */}
    {showOverlay && nodeData.output3dUrl && (
      <MediaOverlay
        content={nodeData.output3dUrl}
        mediaType="3d"
        currentIndex={nodeData.selectedModel3dHistoryIndex || 0}
        totalCount={(nodeData.model3dHistory || []).length}
        isLoading={isLoadingCarousel3D}
        onPrevious={handleCarouselPrevious}
        onNext={handleCarouselNext}
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
