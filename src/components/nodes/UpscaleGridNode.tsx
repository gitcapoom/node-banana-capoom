"use client";

import React, { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { LoadingBadge } from "./LoadingBadge";
import { ModelParameters } from "./ModelParameters";
import { useWorkflowStore, useProviderApiKeys } from "@/store/workflowStore";
import { useCanRun } from "@/hooks/useCanRun";
import { deduplicatedFetch } from "@/utils/deduplicatedFetch";
import {
  UpscaleGridNodeData,
  AspectRatio,
  Resolution,
  ModelType,
  MODEL_DISPLAY_NAMES,
  ProviderType,
  SelectedModel,
  ModelInputDef,
} from "@/types";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { useToast } from "@/components/Toast";
import { getImageDimensions, calculateNodeSizePreservingHeight } from "@/utils/nodeDimensions";
import { useInlineParameters } from "@/hooks/useInlineParameters";
import { InlineParameterPanel } from "./InlineParameterPanel";
import { browseRegistry } from "@/utils/browseRegistry";
import { MediaOverlay } from "../MediaOverlay";

const BASE_ASPECT_RATIOS: AspectRatio[] = ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const EXTENDED_ASPECT_RATIOS: AspectRatio[] = ["auto", "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const RESOLUTIONS_PRO: Resolution[] = ["1K", "2K", "4K"];
const RESOLUTIONS_NB2: Resolution[] = ["512", "1K", "2K", "4K"];

const GEMINI_IMAGE_MODELS: { value: ModelType; label: string }[] = [
  { value: "nano-banana", label: "Nano Banana" },
  { value: "nano-banana-2", label: "Nano Banana 2" },
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
];

const IMAGE_CAPABILITIES: ModelCapability[] = ["text-to-image", "image-to-image"];

// Final-canvas long-edge presets (px).
const LONG_EDGE_OPTIONS = [4096, 6144, 8192, 12288, 16384];

type UpscaleGridNodeType = Node<UpscaleGridNodeData, "upscaleGrid">;

const ctrlCls =
  "nodrag nopan flex-1 min-w-0 text-[11px] py-1 px-2 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white";

export function UpscaleGridNode({ id, data, selected }: NodeProps<UpscaleGridNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const generationsPath = useWorkflowStore((state) => state.generationsPath);
  const { replicateApiKey, falApiKey, kieApiKey, muapiApiKey, replicateEnabled, kieEnabled } = useProviderApiKeys();

  const [externalModels, setExternalModels] = useState<ProviderModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [fullResImage, setFullResImage] = useState<string | null>(null);
  const [isLoadingFull, setIsLoadingFull] = useState(false);

  const { inlineParametersEnabled } = useInlineParameters();
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, nodeData.inputSchema, updateNodeInternals]);

  // Register browse callback for the floating header's Browse button
  useEffect(() => {
    browseRegistry.register(id, () => setIsBrowseDialogOpen(true));
    return () => { browseRegistry.unregister(id); };
  }, [id]);

  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "gemini";
  const isGeminiProvider = currentProvider === "gemini";

  const enabledProviders = useMemo(() => {
    const providers: { id: ProviderType; name: string }[] = [
      { id: "gemini", name: "Gemini" },
      { id: "fal", name: "fal.ai" },
    ];
    if (replicateEnabled && replicateApiKey) providers.push({ id: "replicate", name: "Replicate" });
    if (kieEnabled && kieApiKey) providers.push({ id: "kie", name: "Kie.ai" });
    return providers;
  }, [replicateEnabled, replicateApiKey, kieEnabled, kieApiKey]);

  // Migrate legacy data: derive selectedModel from model field if missing
  useEffect(() => {
    if (nodeData.model && !nodeData.selectedModel) {
      const displayName = MODEL_DISPLAY_NAMES[nodeData.model] || nodeData.model;
      updateNodeData(id, { selectedModel: { provider: "gemini", modelId: nodeData.model, displayName } });
    }
  }, [id, nodeData.model, nodeData.selectedModel, updateNodeData]);

  // Fetch models for external providers
  const fetchModels = useCallback(async () => {
    if (currentProvider === "gemini") {
      setExternalModels([]);
      setModelsFetchError(null);
      return;
    }
    setIsLoadingModels(true);
    setModelsFetchError(null);
    try {
      const capabilities = IMAGE_CAPABILITIES.join(",");
      const headers: HeadersInit = {};
      if (replicateApiKey) headers["X-Replicate-Key"] = replicateApiKey;
      if (falApiKey) headers["X-Fal-Key"] = falApiKey;
      if (kieApiKey) headers["X-Kie-Key"] = kieApiKey;
      const response = await deduplicatedFetch(`/api/models?provider=${currentProvider}&capabilities=${capabilities}`, { headers });
      if (response.ok) {
        const d = await response.json();
        setExternalModels(d.models || []);
        setModelsFetchError(null);
      } else {
        const errorData = await response.json().catch(() => ({}));
        setExternalModels([]);
        setModelsFetchError(errorData.error || `Failed to load models (${response.status})`);
      }
    } catch {
      setExternalModels([]);
      setModelsFetchError("Failed to load models. Check your connection.");
    } finally {
      setIsLoadingModels(false);
    }
  }, [currentProvider, replicateApiKey, falApiKey, kieApiKey]);

  useEffect(() => { fetchModels(); }, [fetchModels]);

  // Inline-params collapse state
  const isParamsExpanded = nodeData.parametersExpanded ?? true;
  const handleToggleParams = useCallback(() => {
    updateNodeData(id, { parametersExpanded: !isParamsExpanded });
  }, [id, isParamsExpanded, updateNodeData]);

  // Eagerly fetch input schema so dynamic handles appear before opening params
  useEffect(() => {
    const modelId = nodeData.selectedModel?.modelId;
    const provider = nodeData.selectedModel?.provider;
    if (!modelId || !provider || provider === "gemini") {
      if (nodeData.inputSchema && nodeData.inputSchema.length > 0) updateNodeData(id, { inputSchema: [] });
      return;
    }
    const headers: HeadersInit = {};
    if (replicateApiKey) headers["X-Replicate-Key"] = replicateApiKey;
    if (falApiKey) headers["X-Fal-Key"] = falApiKey;
    if (kieApiKey) headers["X-Kie-Key"] = kieApiKey;
    if (muapiApiKey) headers["X-Muapi-API-Key"] = muapiApiKey;
    const encodedModelId = encodeURIComponent(modelId);
    deduplicatedFetch(`/api/models/${encodedModelId}?provider=${provider}`, { headers })
      .then(async (response) => {
        if (!response.ok) return;
        const d = await response.json();
        updateNodeData(id, { inputSchema: d.inputs || [] });
      })
      .catch(() => { /* handles stay static */ });
  }, [nodeData.selectedModel?.modelId, nodeData.selectedModel?.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ──
  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const provider = e.target.value as ProviderType;
      if (provider === "gemini") {
        const modelId = nodeData.model || "nano-banana-pro";
        updateNodeData(id, {
          selectedModel: { provider: "gemini", modelId, displayName: GEMINI_IMAGE_MODELS.find((m) => m.value === modelId)?.label || "Nano Banana Pro" },
          parameters: {},
        });
      } else {
        updateNodeData(id, { selectedModel: { provider, modelId: "", displayName: "Select model..." }, parameters: {} });
      }
    },
    [id, nodeData.model, updateNodeData]
  );

  const handleExternalModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const model = externalModels.find((m) => m.id === e.target.value);
      if (model) {
        updateNodeData(id, {
          selectedModel: { provider: currentProvider, modelId: model.id, displayName: model.name, capabilities: model.capabilities },
          parameters: {},
        });
      }
    },
    [id, currentProvider, externalModels, updateNodeData]
  );

  const handleGeminiModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const model = e.target.value as ModelType;
      updateNodeData(id, {
        model,
        selectedModel: { provider: "gemini", modelId: model, displayName: GEMINI_IMAGE_MODELS.find((m) => m.value === model)?.label || model },
      });
    },
    [id, updateNodeData]
  );

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => updateNodeData(id, { parameters }),
    [id, updateNodeData]
  );
  const handleInputsLoaded = useCallback(
    (inputs: ModelInputDef[]) => updateNodeData(id, { inputSchema: inputs }),
    [id, updateNodeData]
  );
  const setGeminiParam = useCallback(
    (key: string, value: unknown) => updateNodeData(id, { parameters: { ...(nodeData.parameters || {}), [key]: value } }),
    [id, nodeData.parameters, updateNodeData]
  );
  const handleBrowseModelSelect = useCallback(
    (model: ProviderModel) => {
      updateNodeData(id, {
        selectedModel: { provider: model.provider, modelId: model.id, displayName: model.name, capabilities: model.capabilities },
        parameters: {},
      });
      setIsBrowseDialogOpen(false);
    },
    [id, updateNodeData]
  );

  const handleClearImage = useCallback(() => {
    updateNodeData(id, { outputImage: null, outputImageThumb: null, outputImageRef: undefined, status: "idle", error: null, quadrantOutputs: [null, null, null, null] });
  }, [id, updateNodeData]);

  const { isExecuting } = useCanRun(id);

  // Lightweight preview source (thumbnail); full-res only loads on double-click.
  const previewSrc = nodeData.outputImageThumb || nodeData.outputImage || null;
  const hasOutput = !!(previewSrc || nodeData.outputImageRef);

  // Open the full-res overlay — load from the generations folder if the node
  // only holds a thumbnail + reference (the baked state).
  const handleOpenOverlay = useCallback(async () => {
    if (nodeData.outputImage) {
      setFullResImage(nodeData.outputImage);
      setShowOverlay(true);
      return;
    }
    if (nodeData.outputImageRef && generationsPath) {
      setShowOverlay(true);
      setIsLoadingFull(true);
      try {
        const resp = await fetch("/api/load-generation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ directoryPath: generationsPath, imageId: nodeData.outputImageRef }),
        });
        const result = await resp.json();
        setFullResImage(result.success && result.image ? result.image : (previewSrc ?? null));
      } catch {
        setFullResImage(previewSrc ?? null);
      } finally {
        setIsLoadingFull(false);
      }
      return;
    }
    // No ref — show whatever preview we have.
    setFullResImage(previewSrc ?? null);
    setShowOverlay(true);
  }, [nodeData.outputImage, nodeData.outputImageRef, generationsPath, previewSrc]);

  // Error toast
  const prevStatusRef = useRef(nodeData.status);
  useEffect(() => {
    if (nodeData.status === "error" && prevStatusRef.current !== "error" && nodeData.error) {
      useToast.getState().show("Upscale failed", "error", true, nodeData.error);
    }
    prevStatusRef.current = nodeData.status;
  }, [nodeData.status, nodeData.error]);

  // Auto-resize node when output changes (match its aspect — use the thumbnail,
  // which shares the full-res aspect ratio).
  const prevOutputImageRef = useRef<string | null>(null);
  useEffect(() => {
    const src = nodeData.outputImageThumb || nodeData.outputImage;
    if (!src || src === prevOutputImageRef.current) {
      prevOutputImageRef.current = src ?? null;
      return;
    }
    prevOutputImageRef.current = src;
    requestAnimationFrame(() => {
      getImageDimensions(src).then((dims) => {
        if (!dims) return;
        const aspectRatio = dims.width / dims.height;
        setNodes((nodes) =>
          nodes.map((node) => {
            if (node.id !== id) return node;
            const currentHeight = typeof node.style?.height === "number" ? node.style.height : undefined;
            const newSize = calculateNodeSizePreservingHeight(aspectRatio, currentHeight);
            return { ...node, style: { ...node.style, width: newSize.width, height: newSize.height } };
          })
        );
      });
    });
  }, [id, nodeData.outputImage, nodeData.outputImageThumb, setNodes]);

  const currentModelId = isGeminiProvider ? (nodeData.selectedModel?.modelId || nodeData.model) : null;
  const supportsResolution = currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2";
  const supportsAdvanced = currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2";
  const aspectRatios = currentModelId === "nano-banana-2" ? EXTENDED_ASPECT_RATIOS : BASE_ASPECT_RATIOS;
  const resolutions = currentModelId === "nano-banana-2" ? RESOLUTIONS_NB2 : RESOLUTIONS_PRO;

  const quad = nodeData.quadrantOutputs || [null, null, null, null];
  const showQuadGrid = nodeData.status === "loading" && quad.some((q) => q);

  // Upscale-specific settings block (shared across providers)
  const upscaleControls = (
    <div className="mt-2 pt-2 border-t border-neutral-700/60 space-y-1.5 max-w-[280px]">
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-neutral-400 shrink-0" title="Each quadrant crop is this much larger than a perfect quarter">Overlap %</label>
        <input
          type="number"
          min={2}
          max={50}
          step={1}
          value={nodeData.overlapPercent ?? 10}
          onChange={(e) => updateNodeData(id, { overlapPercent: Math.min(50, Math.max(2, Math.round(Number(e.target.value) || 10))) })}
          className={ctrlCls}
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-neutral-400 shrink-0" title="Long edge of the final blended image">Output size</label>
        <select
          value={nodeData.finalLongEdge ?? 8192}
          onChange={(e) => updateNodeData(id, { finalLongEdge: Number(e.target.value) })}
          className={ctrlCls}
        >
          {LONG_EDGE_OPTIONS.map((px) => (
            <option key={px} value={px}>{px === 8192 ? "8K (8192)" : px === 4096 ? "4K (4096)" : `${px}px`}</option>
          ))}
        </select>
      </div>
    </div>
  );

  return (
    <>
      <BaseNode
        id={id}
        selected={selected}
        isExecuting={isExecuting}
        hasError={nodeData.status === "error"}
        fullBleed
        settingsExpanded={inlineParametersEnabled && isParamsExpanded}
        aspectFitMedia={nodeData.outputImage}
        settingsPanel={inlineParametersEnabled ? (
          <InlineParameterPanel expanded={isParamsExpanded} onToggle={handleToggleParams} nodeId={id}>
            {/* Provider selector */}
            <div className="flex items-center gap-2 mb-1.5 max-w-[280px]">
              <label className="text-[11px] text-neutral-400 shrink-0">Provider</label>
              <select value={currentProvider} onChange={handleProviderChange} className={ctrlCls}>
                {enabledProviders.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            {/* Gemini controls */}
            {isGeminiProvider && currentModelId && (
              <div className="space-y-1.5 max-w-[280px]">
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-neutral-400 shrink-0">Model</label>
                  <select value={currentModelId} onChange={handleGeminiModelChange} className={ctrlCls}>
                    {GEMINI_IMAGE_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-neutral-400 shrink-0">Aspect Ratio</label>
                  <select
                    value={nodeData.aspectRatio || "1:1"}
                    onChange={(e) => updateNodeData(id, { aspectRatio: e.target.value as AspectRatio })}
                    className={ctrlCls}
                  >
                    {aspectRatios.map((r) => (
                      <option key={r} value={r}>{r === "auto" ? "Auto" : r}</option>
                    ))}
                  </select>
                </div>
                {supportsResolution && (
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-neutral-400 shrink-0">Resolution</label>
                    <select
                      value={nodeData.resolution || "2K"}
                      onChange={(e) => updateNodeData(id, { resolution: e.target.value as Resolution })}
                      className={ctrlCls}
                    >
                      {resolutions.map((res) => (
                        <option key={res} value={res}>{res}</option>
                      ))}
                    </select>
                  </div>
                )}
                {(currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2") && (
                  <label className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={nodeData.useGoogleSearch || false}
                      onChange={(e) => updateNodeData(id, { useGoogleSearch: e.target.checked })}
                      className="nodrag nopan w-3 h-3 rounded bg-[#1a1a1a]"
                    />
                    Google Search
                  </label>
                )}
                {supportsAdvanced && (
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-neutral-400 shrink-0">Seed</label>
                    <input
                      type="number"
                      placeholder="random"
                      value={(nodeData.parameters?.seed as number | string | undefined) ?? ""}
                      onChange={(e) => setGeminiParam("seed", e.target.value === "" ? "" : Number(e.target.value))}
                      className={ctrlCls}
                    />
                  </div>
                )}
              </div>
            )}

            {/* External provider parameters */}
            {!isGeminiProvider && (
              <div className="space-y-1.5 max-w-[420px]">
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-neutral-400 shrink-0">Model</label>
                  <select
                    value={nodeData.selectedModel?.modelId || ""}
                    onChange={handleExternalModelChange}
                    className={ctrlCls}
                    disabled={isLoadingModels}
                  >
                    <option value="">{isLoadingModels ? "Loading…" : "Select model…"}</option>
                    {externalModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => setIsBrowseDialogOpen(true)}
                    className="nodrag nopan text-[10px] px-2 py-1 bg-[#1a1a1a] hover:bg-neutral-700 rounded-md text-neutral-300"
                    title="Browse all models"
                  >
                    Browse
                  </button>
                </div>
                {modelsFetchError && <span className="text-[10px] text-red-400 block">{modelsFetchError}</span>}
                {nodeData.selectedModel?.modelId && (
                  <ModelParameters
                    modelId={nodeData.selectedModel.modelId}
                    provider={currentProvider}
                    parameters={nodeData.parameters || {}}
                    onParametersChange={handleParametersChange}
                    onInputsLoaded={handleInputsLoaded}
                  />
                )}
              </div>
            )}

            {upscaleControls}
          </InlineParameterPanel>
        ) : undefined}
      >
        {/* Dynamic input handles based on model schema */}
        {nodeData.inputSchema && nodeData.inputSchema.length > 0 ? (
          (() => {
            const imageInputs = nodeData.inputSchema!.filter((i) => i.type === "image");
            const videoInputs = nodeData.inputSchema!.filter((i) => i.type === "video");
            const audioInputs = nodeData.inputSchema!.filter((i) => i.type === "audio");

            type HandleType = "image" | "text" | "video" | "audio";
            const handles: Array<{ id: string; type: HandleType; label: string; schemaName: string | null }> = [];

            if (imageInputs.length > 0) {
              imageInputs.forEach((input, index) =>
                handles.push({ id: index === 0 ? "image" : `image-${index}`, type: "image", label: index === 0 ? "Image" : input.label, schemaName: input.name })
              );
            } else {
              handles.push({ id: "image", type: "image", label: "Image", schemaName: null });
            }
            videoInputs.forEach((input, index) =>
              handles.push({ id: index === 0 ? "video" : `video-${index}`, type: "video", label: input.label, schemaName: input.name })
            );
            audioInputs.forEach((input, index) =>
              handles.push({ id: index === 0 ? "audio" : `audio-${index}`, type: "audio", label: input.label, schemaName: input.name })
            );
            handles.push({ id: "text", type: "text", label: "Prompt", schemaName: null });

            const handleColors: Record<HandleType, string> = {
              image: "var(--handle-color-image, #3b82f6)",
              video: "var(--handle-color-video, #0d9488)",
              audio: "var(--handle-color-audio, #8b5cf6)",
              text: "var(--handle-color-text, #f59e0b)",
            };
            const mediaHandles = handles.filter((h) => h.type !== "text");
            const textHandles = handles.filter((h) => h.type === "text");
            const totalSlots = mediaHandles.length + textHandles.length + 1;

            return (
              <>
                {handles.map((handle) => {
                  const isText = handle.type === "text";
                  const typeGroup = isText ? textHandles : mediaHandles;
                  const typeIndex = typeGroup.findIndex((h) => h.id === handle.id);
                  const adjustedIndex = isText ? mediaHandles.length + 1 + typeIndex : typeIndex;
                  const topPercent = ((adjustedIndex + 1) / (totalSlots + 1)) * 100;
                  return (
                    <React.Fragment key={handle.id}>
                      <Handle
                        type="target"
                        position={Position.Left}
                        id={handle.id}
                        style={{ top: `${topPercent}%`, zIndex: 10 }}
                        data-handletype={handle.type}
                        data-schema-name={handle.schemaName || undefined}
                        isConnectable={true}
                        title={handle.label}
                      />
                      <div
                        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
                        style={{ right: `calc(100% + 8px)`, top: `calc(${topPercent}% - 18px)`, color: handleColors[handle.type], zIndex: 10 }}
                      >
                        {handle.label}
                      </div>
                    </React.Fragment>
                  );
                })}
              </>
            );
          })()
        ) : (
          <>
            <Handle type="target" position={Position.Left} id="image" style={{ top: "35%", zIndex: 10 }} data-handletype="image" isConnectable={true} />
            <div className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right" style={{ right: `calc(100% + 8px)`, top: "calc(35% - 18px)", color: "var(--handle-color-image)", zIndex: 10 }}>Image</div>
            <Handle type="target" position={Position.Left} id="text" style={{ top: "65%", zIndex: 10 }} data-handletype="text" isConnectable={true} />
            <div className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right" style={{ right: `calc(100% + 8px)`, top: "calc(65% - 18px)", color: "var(--handle-color-text)", zIndex: 10 }}>Prompt</div>
          </>
        )}

        {/* Output handle */}
        <Handle type="source" position={Position.Right} id="image" style={{ top: "50%", zIndex: 10 }} data-handletype="image" />
        <div className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none" style={{ left: `calc(100% + 8px)`, top: "calc(50% - 18px)", color: "var(--handle-color-image)", zIndex: 10 }}>Image</div>

        <div className="relative w-full h-full min-h-0 overflow-hidden rounded-lg">
          {previewSrc ? (
            <img
              src={previewSrc}
              alt="Upscaled"
              className="w-full h-full object-contain cursor-pointer"
              title="Double-click to view full resolution"
              onDoubleClick={(e) => { e.stopPropagation(); handleOpenOverlay(); }}
            />
          ) : showQuadGrid ? (
            <div className="grid grid-cols-2 grid-rows-2 gap-0.5 w-full h-full">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="bg-neutral-800 flex items-center justify-center overflow-hidden">
                  {quad[i] ? (
                    <img src={quad[i]!} alt={`q${i}`} className="w-full h-full object-cover" />
                  ) : (
                    <svg className="w-4 h-4 animate-spin text-neutral-500" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="w-full h-full min-h-[112px] bg-neutral-900/40 flex flex-col items-center justify-center">
              {nodeData.status === "loading" ? (
                <svg className="w-5 h-5 animate-spin text-neutral-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : nodeData.status === "error" ? (
                <span className="text-[10px] text-red-400 text-center px-2">{nodeData.error || "Failed"}</span>
              ) : (
                <span className="text-neutral-500 text-[10px]">Run to upscale</span>
              )}
            </div>
          )}

          {/* Loading badge */}
          {nodeData.status === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center bg-neutral-900/30 pointer-events-none">
              <LoadingBadge active loadingStartedAt={nodeData.loadingStartedAt} loadingPhase={nodeData.loadingPhase} />
            </div>
          )}

          {/* Clear button */}
          {hasOutput && (
            <div className="absolute top-1 right-1">
              <button
                onClick={handleClearImage}
                className="w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Clear image"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </BaseNode>

      {isBrowseDialogOpen && (
        <ModelSearchDialog
          isOpen={isBrowseDialogOpen}
          onClose={() => setIsBrowseDialogOpen(false)}
          onModelSelected={handleBrowseModelSelect}
          initialCapabilityFilter="image"
        />
      )}
      {showOverlay && (fullResImage || previewSrc) && (
        <MediaOverlay
          content={(fullResImage || previewSrc)!}
          mediaType="image"
          currentIndex={0}
          totalCount={1}
          isLoading={isLoadingFull}
          onPrevious={() => {}}
          onNext={() => {}}
          onClose={() => { setShowOverlay(false); setFullResImage(null); }}
        />
      )}
    </>
  );
}
