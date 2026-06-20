"use client";

import React, { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { LoadingBadge } from "./LoadingBadge";
import { SplitGenerationButton } from "./SplitGenerationButton";
import { ModelParameters } from "./ModelParameters";
import { useWorkflowStore, saveNanoBananaDefaults, useProviderApiKeys } from "@/store/workflowStore";
import { useCanRun } from "@/hooks/useCanRun";
import { deduplicatedFetch } from "@/utils/deduplicatedFetch";
import { NanoBananaNodeData, AspectRatio, Resolution, ModelType, MODEL_DISPLAY_NAMES, ProviderType, SelectedModel, ModelInputDef } from "@/types";
import { useDynamicPinsEnabled } from "@/lib/dynamicPins";
import { DynamicInputHandles } from "./DynamicInputHandles";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { useToast } from "@/components/Toast";
import { getImageDimensions, calculateNodeSizePreservingHeight } from "@/utils/nodeDimensions";
import { ProviderBadge } from "./ProviderBadge";
import { useInlineParameters } from "@/hooks/useInlineParameters";
import { InlineParameterPanel } from "./InlineParameterPanel";
import { browseRegistry } from "@/utils/browseRegistry";
import { MediaOverlay } from "../MediaOverlay";

/** Reorder items so they read column-first in a row-based CSS grid.
 *  e.g. [1,2,3,4,5,6,7,8] with 2 cols → [1,5,2,6,3,7,4,8] */
function reorderColumnFirst<T>(items: T[], cols: number): T[] {
  const rows = Math.ceil(items.length / cols);
  const result: T[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = c * rows + r;
      if (idx < items.length) result.push(items[idx]);
    }
  }
  return result;
}

// Base 10 aspect ratios (all Gemini image models)
const BASE_ASPECT_RATIOS: AspectRatio[] = ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

// Extended 14 aspect ratios (Nano Banana 2 adds extreme ratios)
const EXTENDED_ASPECT_RATIOS: AspectRatio[] = ["auto", "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];

// Resolutions per model (nano-banana-pro: 1K-4K, nano-banana-2: 512-4K)
const RESOLUTIONS_PRO: Resolution[] = ["1K", "2K", "4K"];
const RESOLUTIONS_NB2: Resolution[] = ["512", "1K", "2K", "4K"];

// Hardcoded Gemini image models (always available)
const GEMINI_IMAGE_MODELS: { value: ModelType; label: string }[] = [
  { value: "nano-banana", label: "Nano Banana" },
  { value: "nano-banana-2", label: "Nano Banana 2" },
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
];

// Image generation capabilities
const IMAGE_CAPABILITIES: ModelCapability[] = ["text-to-image", "image-to-image"];

type NanoBananaNodeType = Node<NanoBananaNodeData, "nanoBanana">;

export function GenerateImageNode({ id, data, selected }: NodeProps<NanoBananaNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const generationsPath = useWorkflowStore((state) => state.generationsPath);
  const connectedImageCount = useWorkflowStore((state) =>
    state.edges.filter(e => e.target === id && (e.targetHandle === "image" || e.targetHandle?.startsWith("image-"))).length
  );
  // Use stable selector for API keys to prevent unnecessary re-fetches
  const { replicateApiKey, falApiKey, kieApiKey, muapiApiKey, replicateEnabled, kieEnabled } = useProviderApiKeys();
  const [isLoadingCarouselImage, setIsLoadingCarouselImage] = useState(false);
  // True when the carousel is parked on a history item whose image file is
  // missing on disk (so we show a placeholder yet keep the nav controls usable).
  const [carouselMissing, setCarouselMissing] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [externalModels, setExternalModels] = useState<ProviderModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);

  // Inline parameters infrastructure
  const { inlineParametersEnabled } = useInlineParameters();
  const dynamicPinsOn = useDynamicPinsEnabled();
  const updateNodeInternals = useUpdateNodeInternals();

  // Tell React Flow to recalculate handle positions when schema changes
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, nodeData.inputSchema, updateNodeInternals]);

  // Register browse callback for floating header button
  useEffect(() => {
    browseRegistry.register(id, () => setIsBrowseDialogOpen(true));
    return () => { browseRegistry.unregister(id); };
  }, [id]);

  // Get the current selected provider (default to gemini)
  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "gemini";

  // Get enabled providers
  const enabledProviders = useMemo(() => {
    const providers: { id: ProviderType; name: string }[] = [];
    // Gemini is always available
    providers.push({ id: "gemini", name: "Gemini" });
    // fal.ai is always available (works without key but rate limited)
    providers.push({ id: "fal", name: "fal.ai" });
    // Add Replicate if configured
    if (replicateEnabled && replicateApiKey) {
      providers.push({ id: "replicate", name: "Replicate" });
    }
    // Add Kie.ai if configured
    if (kieEnabled && kieApiKey) {
      providers.push({ id: "kie", name: "Kie.ai" });
    }
    return providers;
  }, [replicateEnabled, replicateApiKey, kieEnabled, kieApiKey]);

  // Migrate legacy data: derive selectedModel from model field if missing
  useEffect(() => {
    if (nodeData.model && !nodeData.selectedModel) {
      const displayName = MODEL_DISPLAY_NAMES[nodeData.model] || nodeData.model;
      const newSelectedModel: SelectedModel = {
        provider: "gemini",
        modelId: nodeData.model,
        displayName,
      };
      updateNodeData(id, { selectedModel: newSelectedModel });
    }
  }, [id, nodeData.model, nodeData.selectedModel, updateNodeData]);

  // Fetch models from external providers when provider changes
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
      if (replicateApiKey) {
        headers["X-Replicate-Key"] = replicateApiKey;
      }
      if (falApiKey) {
        headers["X-Fal-Key"] = falApiKey;
      }
      if (kieApiKey) {
        headers["X-Kie-Key"] = kieApiKey;
      }
      const response = await deduplicatedFetch(`/api/models?provider=${currentProvider}&capabilities=${capabilities}`, { headers });
      if (response.ok) {
        const data = await response.json();
        setExternalModels(data.models || []);
        setModelsFetchError(null);
      } else {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || `Failed to load models (${response.status})`;
        setExternalModels([]);
        setModelsFetchError(
          currentProvider === "replicate" && response.status === 401
            ? "Invalid Replicate API key. Check your settings."
            : errorMsg
        );
      }
    } catch (error) {
      console.error("Failed to fetch models:", error);
      setExternalModels([]);
      setModelsFetchError("Failed to load models. Check your connection.");
    } finally {
      setIsLoadingModels(false);
    }
  }, [currentProvider, replicateApiKey, falApiKey, kieApiKey]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // Inline parameters: compute collapse state and toggle handler
  const isParamsExpanded = nodeData.parametersExpanded ?? true; // default expanded

  const handleToggleParams = useCallback(() => {
    updateNodeData(id, { parametersExpanded: !isParamsExpanded });
  }, [id, isParamsExpanded, updateNodeData]);

  // Handle provider change
  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const provider = e.target.value as ProviderType;

      if (provider === "gemini") {
        // Reset to Gemini default
        const newSelectedModel: SelectedModel = {
          provider: "gemini",
          modelId: nodeData.model || "nano-banana-pro",
          displayName: GEMINI_IMAGE_MODELS.find(m => m.value === (nodeData.model || "nano-banana-pro"))?.label || "Nano Banana Pro",
        };
        // Clear parameters when switching providers (different providers have different schemas)
        updateNodeData(id, { selectedModel: newSelectedModel, parameters: {} });
      } else {
        // Set placeholder for external provider
        const newSelectedModel: SelectedModel = {
          provider,
          modelId: "",
          displayName: "Select model...",
        };
        // Clear parameters when switching providers
        updateNodeData(id, { selectedModel: newSelectedModel, parameters: {} });
      }
    },
    [id, nodeData.model, updateNodeData]
  );

  // Handle model change for external providers
  const handleExternalModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const modelId = e.target.value;
      const model = externalModels.find(m => m.id === modelId);
      if (model) {
        const newSelectedModel: SelectedModel = {
          provider: currentProvider,
          modelId: model.id,
          displayName: model.name,
          capabilities: model.capabilities,
        };
        // Clear parameters when changing models (different models have different schemas)
        updateNodeData(id, { selectedModel: newSelectedModel, parameters: {} });
      }
    },
    [id, currentProvider, externalModels, updateNodeData]
  );

  const handleAspectRatioChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const aspectRatio = e.target.value as AspectRatio;
      updateNodeData(id, { aspectRatio });
      saveNanoBananaDefaults({ aspectRatio });
    },
    [id, updateNodeData]
  );

  const handleResolutionChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const resolution = e.target.value as Resolution;
      updateNodeData(id, { resolution });
      saveNanoBananaDefaults({ resolution });
    },
    [id, updateNodeData]
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const model = e.target.value as ModelType;
      updateNodeData(id, { model });
      saveNanoBananaDefaults({ model });

      // Also update selectedModel for consistency
      const newSelectedModel: SelectedModel = {
        provider: "gemini",
        modelId: model,
        displayName: GEMINI_IMAGE_MODELS.find(m => m.value === model)?.label || model,
      };
      updateNodeData(id, { selectedModel: newSelectedModel });
    },
    [id, updateNodeData]
  );

  const handleGoogleSearchToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const useGoogleSearch = e.target.checked;
      updateNodeData(id, { useGoogleSearch });
      saveNanoBananaDefaults({ useGoogleSearch });
    },
    [id, updateNodeData]
  );

  const handleImageSearchToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const useImageSearch = e.target.checked;
      updateNodeData(id, { useImageSearch });
      saveNanoBananaDefaults({ useImageSearch });
    },
    [id, updateNodeData]
  );

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      updateNodeData(id, { parameters });
    },
    [id, updateNodeData]
  );

  // Merge a single Gemini advanced parameter into nodeData.parameters.
  const setGeminiParam = useCallback(
    (key: string, value: unknown) => {
      updateNodeData(id, { parameters: { ...(nodeData.parameters || {}), [key]: value } });
    },
    [id, nodeData.parameters, updateNodeData]
  );

  // Handle inputs loaded from schema
  const handleInputsLoaded = useCallback(
    (inputs: ModelInputDef[]) => {
      updateNodeData(id, { inputSchema: inputs });
    },
    [id, updateNodeData]
  );

  // Fetch input schema eagerly when model changes (so dynamic handles appear
  // even before the parameter panel is opened)
  useEffect(() => {
    const modelId = nodeData.selectedModel?.modelId;
    const provider = nodeData.selectedModel?.provider;
    if (!modelId || !provider || provider === "gemini") {
      // Gemini models don't have extra image inputs via schema
      if (nodeData.inputSchema && nodeData.inputSchema.length > 0) {
        updateNodeData(id, { inputSchema: [] });
      }
      return;
    }

    // Check localStorage cache first (same cache as ModelParameters)
    try {
      const cache = JSON.parse(localStorage.getItem("node-banana-schema-cache") || "{}");
      const entry = cache[`${provider}:${modelId}`];
      if (entry && Date.now() - entry.timestamp < 48 * 60 * 60 * 1000) {
        if (entry.inputs && entry.inputs.length > 0) {
          updateNodeData(id, { inputSchema: entry.inputs });
        } else if (nodeData.inputSchema && nodeData.inputSchema.length > 0) {
          updateNodeData(id, { inputSchema: [] });
        }
        return;
      }
    } catch { /* ignore cache errors */ }

    // Fetch schema from API
    const headers: HeadersInit = {};
    if (replicateApiKey) headers["X-Replicate-Key"] = replicateApiKey;
    if (falApiKey) headers["X-Fal-Key"] = falApiKey;
    if (kieApiKey) headers["X-Kie-Key"] = kieApiKey;
    if (muapiApiKey) headers["X-Muapi-API-Key"] = muapiApiKey;

    const encodedModelId = encodeURIComponent(modelId);
    deduplicatedFetch(`/api/models/${encodedModelId}?provider=${provider}`, { headers })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        const inputs = data.inputs || [];
        updateNodeData(id, { inputSchema: inputs });
      })
      .catch(() => { /* schema fetch failed — handles stay static */ });
  }, [nodeData.selectedModel?.modelId, nodeData.selectedModel?.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle parameters expand/collapse - resize node height
  const { setNodes } = useReactFlow();
  const handleParametersExpandChange = useCallback(
    (expanded: boolean, parameterCount: number) => {
      // Each parameter row is ~24px, plus some padding
      const parameterHeight = expanded ? Math.max(parameterCount * 28 + 16, 60) : 0;
      const baseHeight = 300; // Default node height
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

  const handleClearImage = useCallback(() => {
    updateNodeData(id, { outputImage: null, status: "idle", error: null });
  }, [id, updateNodeData]);

  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const { isExecuting } = useCanRun(id);

  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const loadImageById = useCallback(async (imageId: string) => {
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
          imageId,
        }),
      });

      const result = await response.json();
      if (!result.success) {
        // Missing images are expected when refs point to deleted/moved files
        console.log(`Image not found: ${imageId}`);
        return null;
      }
      return result.image;
    } catch (error) {
      console.warn("Error loading image:", error);
      return null;
    }
  }, [generationsPath]);

  // Navigate carousel and recall settings from the history item
  const navigateCarousel = useCallback(async (newIndex: number) => {
    const history = nodeData.imageHistory || [];
    if (history.length === 0 || isLoadingCarouselImage) return;

    const imageItem = history[newIndex];
    setIsLoadingCarouselImage(true);
    const image = await loadImageById(imageItem.id);
    setIsLoadingCarouselImage(false);

    // Always move to the target item and recall its settings — even if its
    // image file is missing on disk — so the whole history stays browsable and
    // missing generations are surfaced instead of the carousel silently
    // sticking on the last image that happened to load.
    setCarouselMissing(!image);
    const settingsUpdate: Record<string, unknown> = {
      outputImage: image ?? null,
      selectedHistoryIndex: newIndex,
    };
    if (imageItem.prompt !== undefined) settingsUpdate.inputPrompt = imageItem.prompt;
    if (imageItem.aspectRatio) settingsUpdate.aspectRatio = imageItem.aspectRatio;
    if (imageItem.model) settingsUpdate.model = imageItem.model;
    if (imageItem.resolution) settingsUpdate.resolution = imageItem.resolution;
    if (imageItem.selectedModel) settingsUpdate.selectedModel = imageItem.selectedModel;
    if (imageItem.parameters) settingsUpdate.parameters = imageItem.parameters;
    if (imageItem.useGoogleSearch !== undefined) settingsUpdate.useGoogleSearch = imageItem.useGoogleSearch;
    if (imageItem.useImageSearch !== undefined) settingsUpdate.useImageSearch = imageItem.useImageSearch;
    updateNodeData(id, settingsUpdate);
  }, [id, nodeData.imageHistory, isLoadingCarouselImage, loadImageById, updateNodeData]);

  const handleCarouselPrevious = useCallback(async () => {
    const history = nodeData.imageHistory || [];
    if (history.length === 0) return;
    const currentIndex = nodeData.selectedHistoryIndex || 0;
    const newIndex = currentIndex === 0 ? history.length - 1 : currentIndex - 1;
    await navigateCarousel(newIndex);
  }, [nodeData.imageHistory, nodeData.selectedHistoryIndex, navigateCarousel]);

  const handleCarouselNext = useCallback(async () => {
    const history = nodeData.imageHistory || [];
    if (history.length === 0) return;
    const currentIndex = nodeData.selectedHistoryIndex || 0;
    const newIndex = (currentIndex + 1) % history.length;
    await navigateCarousel(newIndex);
  }, [nodeData.imageHistory, nodeData.selectedHistoryIndex, navigateCarousel]);

  // Clear the "missing" placeholder once a real image becomes the output
  // (a present generation loaded, a fresh generation, or hydration on open).
  useEffect(() => {
    if (nodeData.outputImage) setCarouselMissing(false);
  }, [nodeData.outputImage]);

  // Handle model selection from browse dialog
  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    const newSelectedModel: SelectedModel = {
      provider: model.provider,
      modelId: model.id,
      displayName: model.name,
      capabilities: model.capabilities,
    };
    updateNodeData(id, { selectedModel: newSelectedModel, parameters: {} });
    setIsBrowseDialogOpen(false);
  }, [id, updateNodeData]);

  const isGeminiProvider = currentProvider === "gemini";

  // Dynamic title based on selected model - just the model name
  const displayTitle = useMemo(() => {
    if (nodeData.selectedModel?.displayName && nodeData.selectedModel.modelId) {
      return nodeData.selectedModel.displayName;
    }
    // Fallback for legacy data or no model selected
    if (nodeData.model) {
      return GEMINI_IMAGE_MODELS.find(m => m.value === nodeData.model)?.label || nodeData.model;
    }
    return "Select model...";
  }, [nodeData.selectedModel?.displayName, nodeData.selectedModel?.modelId, nodeData.model]);

  // Provider badge as title prefix
  const titlePrefix = useMemo(() => (
    <ProviderBadge provider={currentProvider} />
  ), [currentProvider]);

  // Use selectedModel.modelId for Gemini models, fallback to legacy model field
  const currentModelId = isGeminiProvider ? (nodeData.selectedModel?.modelId || nodeData.model) : null;
  const supportsResolution = currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2";
  const aspectRatios = currentModelId === "nano-banana-2" ? EXTENDED_ASPECT_RATIOS : BASE_ASPECT_RATIOS;
  const resolutions = currentModelId === "nano-banana-2" ? RESOLUTIONS_NB2 : RESOLUTIONS_PRO;
  const hasCarouselImages = (nodeData.imageHistory || []).length > 1;

  // Count visible Gemini controls to match ModelParameters grid/max-width rules
  const supportsAdvanced = currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2";
  const geminiControlCount = 2 // Model + Aspect Ratio (always)
    + (supportsResolution ? 1 : 0)
    + (currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2" ? 1 : 0)
    + (currentModelId === "nano-banana-2" ? 1 : 0)
    + (supportsAdvanced ? 4 : 0); // Seed, Images, Safety, Thinking
  const useGeminiGrid = geminiControlCount > 4;
  const geminiGridRef = useRef<HTMLDivElement>(null);
  const [geminiColCount, setGeminiColCount] = useState(1);

  useEffect(() => {
    const el = geminiGridRef.current;
    if (!el || !useGeminiGrid) { setGeminiColCount(1); return; }
    let rafId: number;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const cols = getComputedStyle(el).gridTemplateColumns.split(" ").length;
        setGeminiColCount(prev => prev === cols ? prev : cols);
      });
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [useGeminiGrid]);

  // Track previous status to detect error transitions
  const prevStatusRef = useRef(nodeData.status);

  // Show toast when error occurs
  useEffect(() => {
    if (nodeData.status === "error" && prevStatusRef.current !== "error" && nodeData.error) {
      useToast.getState().show("Generation failed", "error", true, nodeData.error);
    }
    prevStatusRef.current = nodeData.status;
  }, [nodeData.status, nodeData.error]);

  // Auto-resize node when output image changes
  const prevOutputImageRef = useRef<string | null>(null);
  useEffect(() => {
    // Only resize when outputImage transitions from null/different to a new value
    if (!nodeData.outputImage || nodeData.outputImage === prevOutputImageRef.current) {
      prevOutputImageRef.current = nodeData.outputImage ?? null;
      return;
    }
    prevOutputImageRef.current = nodeData.outputImage;

    // Use requestAnimationFrame to avoid React Flow update conflicts
    requestAnimationFrame(() => {
      getImageDimensions(nodeData.outputImage!).then((dims) => {
        if (!dims) return;

        const aspectRatio = dims.width / dims.height;

        setNodes((nodes) =>
          nodes.map((node) => {
            if (node.id !== id) return node;

            // Preserve user's manually set height if present
            const currentHeight = typeof node.style?.height === 'number'
              ? node.style.height
              : undefined;

            const newSize = calculateNodeSizePreservingHeight(aspectRatio, currentHeight);

            return { ...node, style: { ...node.style, width: newSize.width, height: newSize.height } };
          })
        );
      });
    });
  }, [id, nodeData.outputImage, setNodes]);

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
        <InlineParameterPanel
          expanded={isParamsExpanded}
          onToggle={handleToggleParams}
          nodeId={id}
        >
          {/* Gemini-specific controls */}
          {isGeminiProvider && currentModelId && (() => {
            const controls: React.ReactNode[] = [
              <div key="model" className="flex items-center gap-2">
                <label className="text-[11px] text-neutral-400 shrink-0">Model</label>
                <select
                  value={currentModelId}
                  onChange={handleModelChange}
                  className="nodrag nopan flex-1 min-w-0 text-[11px] py-1 px-2 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white"
                >
                  {GEMINI_IMAGE_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>,
              <div key="aspect-ratio" className="flex items-center gap-2">
                <label className="text-[11px] text-neutral-400 shrink-0">Aspect Ratio</label>
                <select
                  value={nodeData.aspectRatio || "1:1"}
                  onChange={handleAspectRatioChange}
                  className="nodrag nopan flex-1 min-w-0 text-[11px] py-1 px-2 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white"
                >
                  {aspectRatios.map((ratio) => (
                    <option key={ratio} value={ratio}>
                      {ratio === "auto" ? "Auto" : ratio}
                    </option>
                  ))}
                </select>
              </div>,
            ];

            if (supportsResolution) {
              controls.push(
                <div key="resolution" className="flex items-center gap-2">
                  <label className="text-[11px] text-neutral-400 shrink-0">Resolution</label>
                  <select
                    value={nodeData.resolution || "2K"}
                    onChange={handleResolutionChange}
                    className="nodrag nopan flex-1 min-w-0 text-[11px] py-1 px-2 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white"
                  >
                    {resolutions.map((res) => (
                      <option key={res} value={res}>
                        {res}
                      </option>
                    ))}
                  </select>
                </div>
              );
            }

            if (currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2") {
              controls.push(
                <label key="google-search" className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={nodeData.useGoogleSearch || false}
                    onChange={handleGoogleSearchToggle}
                    className="nodrag nopan w-3 h-3 rounded bg-[#1a1a1a] text-neutral-600 focus:ring-1 focus:ring-neutral-600 focus:ring-offset-0"
                  />
                  Google Search
                </label>
              );
            }

            if (currentModelId === "nano-banana-2") {
              controls.push(
                <label key="image-search" className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={nodeData.useImageSearch || false}
                    onChange={handleImageSearchToggle}
                    className="nodrag nopan w-3 h-3 rounded bg-[#1a1a1a] text-neutral-600 focus:ring-1 focus:ring-neutral-600 focus:ring-offset-0"
                  />
                  Image Search
                </label>
              );
            }

            if (supportsAdvanced) {
              const params = nodeData.parameters || {};
              const inputCls = "nodrag nopan flex-1 min-w-0 text-[11px] py-1 px-2 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white";
              controls.push(
                <div key="seed" className="flex items-center gap-2">
                  <label className="text-[11px] text-neutral-400 shrink-0">Seed</label>
                  <input
                    type="number"
                    placeholder="random"
                    value={(params.seed as number | string | undefined) ?? ""}
                    onChange={(e) => setGeminiParam("seed", e.target.value === "" ? "" : Number(e.target.value))}
                    className={inputCls}
                  />
                </div>,
                <div key="num-images" className="flex items-center gap-2">
                  <label className="text-[11px] text-neutral-400 shrink-0">Images</label>
                  <input
                    type="number"
                    min={1}
                    max={4}
                    value={(params.numImages as number | undefined) ?? 1}
                    onChange={(e) => setGeminiParam("numImages", Math.min(4, Math.max(1, Math.round(Number(e.target.value) || 1))))}
                    className={inputCls}
                    title="Number of images to generate (1–4)"
                  />
                </div>,
                <div key="safety" className="flex items-center gap-2">
                  <label className="text-[11px] text-neutral-400 shrink-0">Safety</label>
                  <select value={(params.safety as string | undefined) ?? "default"} onChange={(e) => setGeminiParam("safety", e.target.value)} className={inputCls} title="Content-moderation thresholds">
                    <option value="default">Default</option>
                    <option value="none">Block none</option>
                    <option value="high">Block few (high only)</option>
                    <option value="medium">Block some (medium+)</option>
                    <option value="low">Block most (low+)</option>
                  </select>
                </div>,
                <div key="thinking" className="flex items-center gap-2">
                  <label className="text-[11px] text-neutral-400 shrink-0">Thinking</label>
                  <select value={(params.thinkingLevel as string | undefined) ?? "default"} onChange={(e) => setGeminiParam("thinkingLevel", e.target.value)} className={inputCls} title="Reasoning effort (model-dependent)">
                    <option value="default">Default</option>
                    <option value="low">Low</option>
                    <option value="high">High</option>
                  </select>
                </div>
              );
            }

            const display = useGeminiGrid && geminiColCount > 1
              ? reorderColumnFirst(controls, geminiColCount)
              : controls;

            return (
              <>
                <div
                  ref={geminiGridRef}
                  className={useGeminiGrid
                    ? "grid grid-cols-[repeat(auto-fill,minmax(min(180px,100%),1fr))] max-w-[420px] gap-x-6 gap-y-1.5"
                    : "space-y-1.5 max-w-[280px]"
                  }
                >
                  {display}
                </div>
                {supportsAdvanced && (
                  <div className="mt-1.5 max-w-[420px]">
                    <label className="text-[11px] text-neutral-400 block mb-0.5">System Prompt</label>
                    <textarea
                      value={(nodeData.parameters?.systemPrompt as string | undefined) ?? ""}
                      onChange={(e) => setGeminiParam("systemPrompt", e.target.value)}
                      placeholder="Optional system instruction…"
                      rows={2}
                      className="nodrag nopan nowheel w-full text-[11px] py-1 px-2 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white resize-y"
                    />
                  </div>
                )}
              </>
            );
          })()}

          {/* External provider parameters - reuse ModelParameters component */}
          {!isGeminiProvider && nodeData.selectedModel?.modelId && (
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

          // Helper to add handles for a given type
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
              id: "image",
              type: "image",
              label: "Image",
              schemaName: null,
              description: "Not used by this model",
              isPlaceholder: true,
            });
          }

          // Add video/audio handles from schema (no placeholder — not all models need these)
          addHandles(videoInputs, "video");
          addHandles(audioInputs, "audio");

          if (hasTextInput) {
            addHandles(textInputs, "text");
          } else {
            handles.push({
              id: "text",
              type: "text",
              label: "Prompt",
              schemaName: null,
              description: "Not used by this model",
              isPlaceholder: true,
            });
          }

          // Calculate positions — group order: image, video, audio, gap, text
          const handleColors: Record<HandleType, string> = {
            image: "var(--handle-color-image, #3b82f6)",
            video: "var(--handle-color-video, #0d9488)",
            audio: "var(--handle-color-audio, #8b5cf6)",
            text: "var(--handle-color-text, #f59e0b)",
          };
          const mediaHandles = handles.filter(h => h.type !== "text");
          const textHandles = handles.filter(h => h.type === "text");
          const totalSlots = mediaHandles.length + textHandles.length + 1; // +1 for gap

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
                    zIndex: 10,
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
                    zIndex: 10,
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
        /* Default handles when no schema */
        <>
          <Handle
            type="target"
            position={Position.Left}
            id="image"
            style={{ top: "35%", zIndex: 10 }}
            data-handletype="image"
            isConnectable={true}
          />
          <div
            className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
            style={{
              right: `calc(100% + 8px)`,
              top: "calc(35% - 18px)",
              color: "var(--handle-color-image)",
              zIndex: 10,
            }}
          >
            Image{connectedImageCount > 1 && (
              <span className="ml-0.5 text-[8px] text-emerald-400"> ×{connectedImageCount}</span>
            )}
          </div>
          <Handle
            type="target"
            position={Position.Left}
            id="text"
            style={{ top: "65%", zIndex: 10 }}
            data-handletype="text"
            isConnectable={true}
          />
          <div
            className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
            style={{
              right: `calc(100% + 8px)`,
              top: "calc(65% - 18px)",
              color: "var(--handle-color-text)",
              zIndex: 10,
            }}
          >
            Prompt
          </div>
        </>
      )}
      {/* Output handle - always static */}
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        style={{ top: "50%", zIndex: 10 }}
        data-handletype="image"
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{
          left: `calc(100% + 8px)`,
          top: "calc(50% - 18px)",
          color: "var(--handle-color-image)",
          zIndex: 10,
        }}
      >
        Image
      </div>

      <div className="relative w-full h-full min-h-0 overflow-hidden rounded-lg">
        <SplitGenerationButton id={id} count={nodeData.imageHistory?.length ?? 0} />
        {/* Preview area */}
        {nodeData.outputImage || carouselMissing ? (
          <>
            {nodeData.outputImage ? (
              <img
                src={nodeData.outputImage}
                alt="Generated"
                className="w-full h-full object-contain cursor-pointer"
                onDoubleClick={(e) => { e.stopPropagation(); setShowOverlay(true); }}
              />
            ) : (
              /* Selected generation's file is missing on disk — placeholder keeps the carousel browsable */
              <div className="w-full h-full min-h-[112px] flex flex-col items-center justify-center gap-1 bg-neutral-900/40 text-center px-3">
                <svg className="w-5 h-5 text-amber-400/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M3 16.5l5.25-5.25a2.25 2.25 0 013.182 0L15 15M21 15V6a1.5 1.5 0 00-1.5-1.5H7.5" />
                </svg>
                <span className="text-[10px] text-amber-300/90 font-medium">Generation image missing</span>
                <span className="text-[9px] text-white/40">file not in generations folder</span>
              </div>
            )}
            {/* Loading overlay for generation */}
            {nodeData.status === "loading" && (
              <div className="absolute inset-0 bg-neutral-900/70 flex items-center justify-center">
                <LoadingBadge
                  active
                  loadingStartedAt={nodeData.loadingStartedAt}
                  loadingPhase={nodeData.loadingPhase}
                  queuePosition={nodeData.queuePosition}
                />
                <svg
                  className="w-6 h-6 animate-spin text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              </div>
            )}
            {/* Error overlay when generation failed */}
            {nodeData.status === "error" && (
              <div className="absolute inset-0 bg-red-900/40 flex flex-col items-center justify-center gap-1">
                <svg
                  className="w-6 h-6 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-white text-xs font-medium">Generation failed</span>
                <span className="text-white/70 text-[10px]">See toast for details</span>
              </div>
            )}
            {/* Loading overlay for carousel navigation */}
            {isLoadingCarouselImage && (
              <div className="absolute inset-0 bg-neutral-900/50 flex items-center justify-center">
                <svg
                  className="w-4 h-4 animate-spin text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              </div>
            )}
            {/* Clear button */}
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

            {/* Carousel controls OR double-click hint — never both */}
            {hasCarouselImages ? (
              <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-2 py-1.5 bg-neutral-900/60 backdrop-blur-sm">
                <button
                  onClick={handleCarouselPrevious}
                  disabled={isLoadingCarouselImage}
                  className="w-5 h-5 rounded hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-white/70 hover:text-white transition-colors"
                  title="Previous image"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <span className="text-[10px] text-white/70 min-w-[32px] text-center">
                  {(nodeData.selectedHistoryIndex || 0) + 1} / {(nodeData.imageHistory || []).length}
                </span>
                <button
                  onClick={handleCarouselNext}
                  disabled={isLoadingCarouselImage}
                  className="w-5 h-5 rounded hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-white/70 hover:text-white transition-colors"
                  title="Next image"
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
          </>
        ) : (
          <div className="w-full h-full min-h-[112px] bg-neutral-900/40 flex flex-col items-center justify-center">
            {nodeData.status === "loading" ? (
              <svg
                className="w-4 h-4 animate-spin text-neutral-400"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
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
      </div>

    </BaseNode>

    {/* Model browse dialog */}
    {isBrowseDialogOpen && (
      <ModelSearchDialog
        isOpen={isBrowseDialogOpen}
        onClose={() => setIsBrowseDialogOpen(false)}
        onModelSelected={handleBrowseModelSelect}
        initialCapabilityFilter="image"
      />
    )}
    {showOverlay && nodeData.outputImage && (
      <MediaOverlay
        content={nodeData.outputImage}
        mediaType="image"
        currentIndex={nodeData.selectedHistoryIndex || 0}
        totalCount={(nodeData.imageHistory || []).length}
        isLoading={isLoadingCarouselImage}
        onPrevious={handleCarouselPrevious}
        onNext={handleCarouselNext}
        onClose={() => setShowOverlay(false)}
      />
    )}
    </>
  );
}

/**
 * @deprecated Use `GenerateImageNode` instead. This alias is kept for backward compatibility
 * with existing workflows but will be removed in a future version.
 */
export { GenerateImageNode as NanoBananaNode };
