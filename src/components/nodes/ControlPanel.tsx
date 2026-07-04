"use client";

import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Node } from "@xyflow/react";
import { useWorkflowStore, saveNanoBananaDefaults, useProviderApiKeys } from "@/store/workflowStore";
import { NodeType, NanoBananaNodeData, UpscaleGridNodeData, LLMGenerateNodeData, GenerateVideoNodeData, Generate3DNodeData, GenerateAudioNodeData, EaseCurveNodeData, ConditionalSwitchNodeData, WorldLabsPanoNodeData, WorldLabsWorldNodeData, AspectRatio, Resolution, ModelType, MODEL_DISPLAY_NAMES, ProviderType, SelectedModel, LLMProvider, LLMModelType, MatchMode, ConditionalSwitchRule } from "@/types";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { ModelParameters } from "./ModelParameters";
import { PromptSkillPicker } from "./PromptSkillPicker";
import { useLlmModelLists, FALLBACK_MODELS } from "@/hooks/useLlmModelLists";
import { useCanRun } from "@/hooks/useCanRun";
import { CubicBezierEditor } from "@/components/CubicBezierEditor";
import { deduplicatedFetch } from "@/utils/deduplicatedFetch";
import { evaluateRule } from "@/store/utils/ruleEvaluation";
import { EASING_PRESETS, getPresetBezier, getEasingBezier } from "@/lib/easing-presets";
import { getAllEasingNames, getEasingFunction } from "@/lib/easing-functions";
import { getModelPageUrl, getProviderDisplayName } from "@/utils/providerUrls";
import { useInlineParameters } from "@/hooks/useInlineParameters";

// List of node types that have configurable parameters
const CONFIGURABLE_NODE_TYPES: NodeType[] = [
  "nanoBanana",
  "upscaleGrid",
  "generateVideo",
  "generate3d",
  "generateAudio",
  "llmGenerate",
  "easeCurve",
  "conditionalSwitch",
  "worldLabsPano",
  "worldLabsWorld",
];

// Generation node types that can use inline parameters
const GENERATION_NODE_TYPES: NodeType[] = [
  "nanoBanana",
  "upscaleGrid",
  "generateVideo",
  "generate3d",
  "generateAudio",
  "llmGenerate",
  "worldLabsPano",
  "worldLabsWorld",
];

// Base 10 aspect ratios (all Gemini image models)
const BASE_ASPECT_RATIOS: AspectRatio[] = ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

// Extended 14 aspect ratios (Nano Banana 2 adds extreme ratios)
const EXTENDED_ASPECT_RATIOS: AspectRatio[] = ["auto", "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];

// Resolutions per model
const RESOLUTIONS_PRO: Resolution[] = ["1K", "2K", "4K"];
const RESOLUTIONS_NB2: Resolution[] = ["512", "1K", "2K", "4K"];

// Hardcoded Gemini image models
const GEMINI_IMAGE_MODELS: { value: ModelType; label: string }[] = [
  { value: "nano-banana", label: "Nano Banana" },
  { value: "nano-banana-2", label: "Nano Banana 2" },
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
];

// LLM providers and models
const LLM_PROVIDERS: { value: LLMProvider; label: string }[] = [
  { value: "google", label: "Google" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
];

// Image/video/audio/3d generation capabilities
const IMAGE_CAPABILITIES: ModelCapability[] = ["text-to-image", "image-to-image"];
const VIDEO_CAPABILITIES: ModelCapability[] = ["text-to-video", "image-to-video"];
const AUDIO_CAPABILITIES: ModelCapability[] = ["text-to-audio"];
const MODEL_3D_CAPABILITIES: ModelCapability[] = ["text-to-3d", "image-to-3d"];

// Easing names
const ALL_EASING_NAMES = getAllEasingNames();
const PRESET_NAMES = new Set(EASING_PRESETS);

// Generate SVG polyline for easing preview
function generateEasingPolyline(
  easingName: string,
  width: number,
  height: number,
  samples: number = 20
): string {
  const fn = getEasingFunction(easingName);
  return Array.from({ length: samples + 1 }, (_, i) => {
    const t = i / samples;
    const y = fn(t);
    return `${(t * width).toFixed(1)},${((1 - y) * height).toFixed(1)}`;
  }).join(" ");
}

/**
 * Fixed-position control panel on the right side of viewport
 * Displays controls for the currently selected node
 */
export function ControlPanel() {
  const selectedNode = useWorkflowStore((state) => {
    const selected = state.nodes.filter((n) => n.selected);
    return selected.length === 1 ? selected[0] : null;
  });
  const { inlineParametersEnabled } = useInlineParameters();

  // Check if the selected node is configurable
  const isConfigurable = selectedNode && CONFIGURABLE_NODE_TYPES.includes(selectedNode.type as NodeType);

  // If no single node selected or not configurable, hide panel
  if (!selectedNode || !isConfigurable) {
    return null;
  }

  // Check if this is a generation node
  const isGenerationNode = selectedNode &&
    GENERATION_NODE_TYPES.includes(selectedNode.type as NodeType);

  // Hide for generation nodes when inline parameters enabled
  if (isGenerationNode && inlineParametersEnabled) {
    return null;
  }

  return (
    <div className="fixed top-0 right-6 h-screen z-[90] flex items-center pointer-events-none">
      <div
        className="w-80 bg-neutral-800 border border-neutral-700 rounded-xl max-h-[80vh] overflow-y-auto pointer-events-auto transition-opacity duration-200 nowheel"
        style={{
          boxShadow: [
            '-1px 0 2px rgba(0,0,0,0.18)',
            '-2px 0 4px rgba(0,0,0,0.15)',
            '-4px 0 8px rgba(0,0,0,0.12)',
            '-8px 0 16px rgba(0,0,0,0.10)',
            '-16px 0 32px rgba(0,0,0,0.08)',
            '-32px 0 64px rgba(0,0,0,0.06)',
          ].join(', '),
        }}
      >
        <div className="p-4">
          {/* Header */}
          <h3 className="text-sm font-medium text-neutral-200">
            {getNodeTypeTitle(selectedNode.type as NodeType)}
          </h3>

          {/* Node-specific controls */}
          <div className="space-y-4 mt-4">
            {selectedNode.type === "nanoBanana" && (
              <GenerateImageControls node={selectedNode} />
            )}
            {selectedNode.type === "upscaleGrid" && (
              <UpscaleGridControls node={selectedNode} />
            )}
            {selectedNode.type === "generateVideo" && (
              <GenerateVideoControls node={selectedNode} />
            )}
            {selectedNode.type === "generate3d" && (
              <Generate3DControls node={selectedNode} />
            )}
            {selectedNode.type === "generateAudio" && (
              <GenerateAudioControls node={selectedNode} />
            )}
            {selectedNode.type === "llmGenerate" && (
              <LLMControls node={selectedNode} />
            )}
            {selectedNode.type === "easeCurve" && (
              <EaseCurveControls node={selectedNode} />
            )}
            {selectedNode.type === "conditionalSwitch" && (
              <ConditionalSwitchControls node={selectedNode} />
            )}
            {selectedNode.type === "worldLabsPano" && (
              <WorldLabsPanoControls node={selectedNode} />
            )}
            {selectedNode.type === "worldLabsWorld" && (
              <WorldLabsWorldControls node={selectedNode} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function getNodeTypeTitle(type: NodeType): string {
  const titles: Record<string, string> = {
    nanoBanana: "Generate Image Settings",
    upscaleGrid: "Upscale Grid Settings",
    generateVideo: "Generate Video Settings",
    generate3d: "Generate 3D Settings",
    generateAudio: "Generate Audio Settings",
    llmGenerate: "LLM Settings",
    easeCurve: "Ease Curve Settings",
    conditionalSwitch: "Conditional Switch Settings",
    worldLabsPano: "Panorama Generator Settings",
    worldLabsWorld: "World Generator Settings",
  };
  return titles[type] || "Settings";
}

/** Azimuth presets for WorldLabsPano multi-image generation */
const AZIMUTH_OPTIONS = [
  { label: "Front", value: 0 },
  { label: "Right", value: 90 },
  { label: "Back", value: 180 },
  { label: "Left", value: 270 },
] as const;
const DEFAULT_AZIMUTHS = [0, 90, 180, 270];

// WorldLabs Panorama Generator Controls
function WorldLabsPanoControls({ node }: { node: Node }) {
  const nodeData = node.data as WorldLabsPanoNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const edges = useWorkflowStore((state) => state.edges);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const { canRun, blockedReason, isExecuting } = useCanRun(node.id);

  const connectedImageCount = useMemo(() => {
    return edges.filter(
      (e) => e.target === node.id && e.targetHandle === "image"
    ).length;
  }, [edges, node.id]);

  const showAzimuthControls = connectedImageCount >= 2;

  return (
    <div className="space-y-4">
      {/* World Name */}
      <div>
        <label className="text-[10px] text-neutral-500 block mb-1">World Name</label>
        <input
          type="text"
          value={nodeData.worldName}
          onChange={(e) => updateNodeData(node.id, { worldName: e.target.value })}
          className="w-full bg-neutral-900 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-700 focus:border-indigo-500 focus:outline-none"
          placeholder="My World"
        />
      </div>

      {/* Model Selection */}
      <div>
        <label className="text-[10px] text-neutral-500 block mb-1">Model</label>
        <select
          value={nodeData.model}
          onChange={(e) => updateNodeData(node.id, { model: e.target.value as WorldLabsPanoNodeData["model"] })}
          className="w-full bg-neutral-900 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-700 focus:border-indigo-500 focus:outline-none appearance-none"
        >
          <option value="Marble 0.1-mini">Marble 0.1 Mini (fast)</option>
          <option value="Marble 0.1-plus">Marble 0.1 Plus</option>
        </select>
      </div>

      {/* Seed */}
      <div>
        <label className="text-[10px] text-neutral-500 block mb-1">Seed (optional)</label>
        <input
          type="number"
          value={nodeData.seed ?? ""}
          onChange={(e) => {
            const val = e.target.value.trim();
            updateNodeData(node.id, { seed: val === "" ? null : parseInt(val, 10) || null });
          }}
          className="w-full bg-neutral-900 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-700 focus:border-indigo-500 focus:outline-none"
          placeholder="Random"
        />
      </div>

      {/* Azimuth Controls */}
      {showAzimuthControls && (
        <div>
          <label className="text-[10px] text-neutral-500 block mb-1.5">
            Image Azimuths ({connectedImageCount} images)
          </label>
          <div className="space-y-1">
            {Array.from({ length: connectedImageCount }, (_, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-[10px] text-neutral-600 w-10 shrink-0">Img {i + 1}</span>
                <select
                  value={nodeData.imageAzimuths[i] ?? DEFAULT_AZIMUTHS[i % DEFAULT_AZIMUTHS.length]}
                  onChange={(e) => updateNodeData(node.id, {
                    imageAzimuths: { ...nodeData.imageAzimuths, [i]: Number(e.target.value) },
                  })}
                  className="flex-1 bg-neutral-900 text-neutral-200 text-[11px] rounded px-1.5 py-1 border border-neutral-700 focus:border-indigo-500 focus:outline-none appearance-none"
                >
                  {AZIMUTH_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label} ({opt.value}°)</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Run button */}
      <div className="flex justify-end">
        <button
          onClick={() => regenerateNode(node.id)}
          disabled={!canRun}
          title={blockedReason || undefined}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          {isExecuting ? "Running..." : "Run"}
        </button>
      </div>
    </div>
  );
}

// WorldLabs World Generator Controls
function WorldLabsWorldControls({ node }: { node: Node }) {
  const nodeData = node.data as WorldLabsWorldNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const { canRun, blockedReason, isExecuting } = useCanRun(node.id);

  return (
    <div className="space-y-4">
      {/* World Name */}
      <div>
        <label className="text-[10px] text-neutral-500 block mb-1">World Name</label>
        <input
          type="text"
          value={nodeData.worldName}
          onChange={(e) => updateNodeData(node.id, { worldName: e.target.value })}
          className="w-full bg-neutral-900 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-700 focus:border-indigo-500 focus:outline-none"
          placeholder="My World"
        />
      </div>

      {/* Model Selection */}
      <div>
        <label className="text-[10px] text-neutral-500 block mb-1">Model</label>
        <select
          value={nodeData.model}
          onChange={(e) => updateNodeData(node.id, { model: e.target.value as WorldLabsWorldNodeData["model"] })}
          className="w-full bg-neutral-900 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-700 focus:border-indigo-500 focus:outline-none appearance-none"
        >
          <option value="Marble 0.1-plus">Marble 0.1 Plus</option>
          <option value="Marble 0.1-mini">Marble 0.1 Mini</option>
        </select>
      </div>

      {/* Seed */}
      <div>
        <label className="text-[10px] text-neutral-500 block mb-1">Seed (optional)</label>
        <input
          type="number"
          value={nodeData.seed ?? ""}
          onChange={(e) => {
            const val = e.target.value.trim();
            updateNodeData(node.id, { seed: val === "" ? null : parseInt(val, 10) || null });
          }}
          className="w-full bg-neutral-900 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-700 focus:border-indigo-500 focus:outline-none"
          placeholder="Random"
        />
      </div>

      {/* Is Panorama */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={nodeData.isPano}
          onChange={() => updateNodeData(node.id, { isPano: !nodeData.isPano })}
          className="w-3.5 h-3.5 rounded bg-neutral-800 border-neutral-600 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0 cursor-pointer"
        />
        <span className="text-[11px] text-neutral-400">Input is panorama</span>
      </label>

      {/* Run button */}
      <div className="flex justify-end">
        <button
          onClick={() => regenerateNode(node.id)}
          disabled={!canRun}
          title={blockedReason || undefined}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          {isExecuting ? "Running..." : "Run"}
        </button>
      </div>
    </div>
  );
}

// Apple SHARP (3D) Controls
// Generate Image Controls
function GenerateImageControls({ node }: { node: Node }) {
  const nodeData = node.data as NanoBananaNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const { canRun, blockedReason, isExecuting } = useCanRun(node.id);
  const { replicateApiKey, falApiKey, kieApiKey, replicateEnabled, kieEnabled } = useProviderApiKeys();
  const [externalModels, setExternalModels] = useState<ProviderModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);

  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "gemini";

  // Get enabled providers
  const enabledProviders = useMemo(() => {
    const providers: { id: ProviderType; name: string }[] = [];
    providers.push({ id: "gemini", name: "Gemini" });
    providers.push({ id: "fal", name: "fal.ai" });
    if (replicateEnabled && replicateApiKey) {
      providers.push({ id: "replicate", name: "Replicate" });
    }
    if (kieEnabled && kieApiKey) {
      providers.push({ id: "kie", name: "Kie.ai" });
    }
    return providers;
  }, [replicateEnabled, replicateApiKey, kieEnabled, kieApiKey]);

  // Fetch models from external providers
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
      switch (currentProvider) {
        case "replicate":
          if (replicateApiKey) headers["X-Replicate-Key"] = replicateApiKey;
          break;
        case "fal":
          if (falApiKey) headers["X-Fal-Key"] = falApiKey;
          break;
        case "kie":
          if (kieApiKey) headers["X-Kie-Key"] = kieApiKey;
          break;
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
        setModelsFetchError(errorMsg);
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

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const provider = e.target.value as ProviderType;

      if (provider === "gemini") {
        const newSelectedModel: SelectedModel = {
          provider: "gemini",
          modelId: nodeData.model || "nano-banana-pro",
          displayName: GEMINI_IMAGE_MODELS.find(m => m.value === (nodeData.model || "nano-banana-pro"))?.label || "Nano Banana Pro",
        };
        updateNodeData(node.id, { selectedModel: newSelectedModel, parameters: {} });
      } else {
        const newSelectedModel: SelectedModel = {
          provider,
          modelId: "",
          displayName: "Select model...",
        };
        updateNodeData(node.id, { selectedModel: newSelectedModel, parameters: {} });
      }
    },
    [node.id, nodeData.model, updateNodeData]
  );

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
        updateNodeData(node.id, { selectedModel: newSelectedModel, parameters: {} });
      }
    },
    [node.id, currentProvider, externalModels, updateNodeData]
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const model = e.target.value as ModelType;
      updateNodeData(node.id, { model });
      saveNanoBananaDefaults({ model });

      const newSelectedModel: SelectedModel = {
        provider: "gemini",
        modelId: model,
        displayName: GEMINI_IMAGE_MODELS.find(m => m.value === model)?.label || model,
      };
      updateNodeData(node.id, { selectedModel: newSelectedModel });
    },
    [node.id, updateNodeData]
  );

  const handleAspectRatioChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const aspectRatio = e.target.value as AspectRatio;
      updateNodeData(node.id, { aspectRatio });
      saveNanoBananaDefaults({ aspectRatio });
    },
    [node.id, updateNodeData]
  );

  const handleResolutionChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const resolution = e.target.value as Resolution;
      updateNodeData(node.id, { resolution });
      saveNanoBananaDefaults({ resolution });
    },
    [node.id, updateNodeData]
  );

  const handleGoogleSearchToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const useGoogleSearch = e.target.checked;
      updateNodeData(node.id, { useGoogleSearch });
      saveNanoBananaDefaults({ useGoogleSearch });
    },
    [node.id, updateNodeData]
  );

  const handleImageSearchToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const useImageSearch = e.target.checked;
      updateNodeData(node.id, { useImageSearch });
      saveNanoBananaDefaults({ useImageSearch });
    },
    [node.id, updateNodeData]
  );

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      updateNodeData(node.id, { parameters });
    },
    [node.id, updateNodeData]
  );

  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    const newSelectedModel: SelectedModel = {
      provider: model.provider,
      modelId: model.id,
      displayName: model.name,
      capabilities: model.capabilities,
    };
    updateNodeData(node.id, { selectedModel: newSelectedModel, parameters: {} });
    setIsBrowseDialogOpen(false);
  }, [node.id, updateNodeData]);

  const isGeminiProvider = currentProvider === "gemini";
  const currentModelId = isGeminiProvider ? (nodeData.selectedModel?.modelId || nodeData.model) : null;
  const supportsResolution = currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2";
  const supportsAdvanced = currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2";
  const aspectRatios = currentModelId === "nano-banana-2" ? EXTENDED_ASPECT_RATIOS : BASE_ASPECT_RATIOS;
  const resolutions = currentModelId === "nano-banana-2" ? RESOLUTIONS_NB2 : RESOLUTIONS_PRO;
  const geminiParams = nodeData.parameters || {};
  const setGeminiParam = (key: string, value: unknown) =>
    updateNodeData(node.id, { parameters: { ...(nodeData.parameters || {}), [key]: value } });
  const hasExternalProviders = !!(replicateEnabled && replicateApiKey);

  return (
    <>
      <div className="space-y-3">
        {/* Model name + provider with link — sits directly under title divider */}
        <div className="border-t border-neutral-700 pt-3">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-neutral-100 truncate">
                {nodeData.selectedModel?.displayName || GEMINI_IMAGE_MODELS.find(m => m.value === nodeData.model)?.label || "Select model..."}
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-[10px] text-neutral-500 truncate">
                  {enabledProviders.find(p => p.id === currentProvider)?.name || currentProvider}
                </span>
                {nodeData.selectedModel?.modelId && (
                  <a
                    href={getModelPageUrl(currentProvider, nodeData.selectedModel.modelId) || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-neutral-500 hover:text-neutral-300 transition-colors"
                    title={`View on ${getProviderDisplayName(currentProvider)}`}
                    onClick={(e) => {
                      if (!getModelPageUrl(currentProvider, nodeData.selectedModel?.modelId || "")) {
                        e.preventDefault();
                      }
                    }}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            </div>
            <button
              onClick={() => setIsBrowseDialogOpen(true)}
              className="nodrag nopan shrink-0 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
            >
              Browse
            </button>
          </div>
        </div>

        {/* Gemini-specific controls */}
        {isGeminiProvider && (
          <>
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">Aspect Ratio</label>
              <select
                value={nodeData.aspectRatio || "1:1"}
                onChange={handleAspectRatioChange}
                className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {aspectRatios.map(ar => (
                  <option key={ar} value={ar}>{ar === "auto" ? "Auto" : ar}</option>
                ))}
              </select>
            </div>

            {supportsResolution && (
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">Resolution</label>
                <select
                  value={nodeData.resolution || "1K"}
                  onChange={handleResolutionChange}
                  className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {resolutions.map(res => (
                    <option key={res} value={res}>{res}</option>
                  ))}
                </select>
              </div>
            )}

            {(currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2") && (
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id={`google-search-${node.id}`}
                  checked={nodeData.useGoogleSearch || false}
                  onChange={handleGoogleSearchToggle}
                  className="nodrag nopan w-3 h-3 text-blue-600 bg-neutral-700 border-neutral-600 rounded focus:ring-blue-500"
                />
                <label htmlFor={`google-search-${node.id}`} className="ml-2 text-xs text-neutral-300">
                  Google Search
                </label>
              </div>
            )}

            {currentModelId === "nano-banana-2" && (
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id={`image-search-${node.id}`}
                  checked={nodeData.useImageSearch || false}
                  onChange={handleImageSearchToggle}
                  className="nodrag nopan w-3 h-3 text-blue-600 bg-neutral-700 border-neutral-600 rounded focus:ring-blue-500"
                />
                <label htmlFor={`image-search-${node.id}`} className="ml-2 text-xs text-neutral-300">
                  Image Search
                </label>
              </div>
            )}

            {supportsAdvanced && (() => {
              const sel = "nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500";
              return (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-neutral-300 mb-1">Seed</label>
                      <input type="number" placeholder="random" value={(geminiParams.seed as number | string | undefined) ?? ""}
                        onChange={(e) => setGeminiParam("seed", e.target.value === "" ? "" : Number(e.target.value))} className={sel} />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-neutral-300 mb-1">Images</label>
                      <input type="number" min={1} max={4} value={(geminiParams.numImages as number | undefined) ?? 1}
                        onChange={(e) => setGeminiParam("numImages", Math.min(4, Math.max(1, Math.round(Number(e.target.value) || 1))))} className={sel} title="Number of images (1–4)" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-neutral-300 mb-1">Safety</label>
                      <select value={(geminiParams.safety as string | undefined) ?? "default"} onChange={(e) => setGeminiParam("safety", e.target.value)} className={sel}>
                        <option value="default">Default</option>
                        <option value="none">Block none</option>
                        <option value="high">Block few (high)</option>
                        <option value="medium">Block some (med+)</option>
                        <option value="low">Block most (low+)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-neutral-300 mb-1">Thinking</label>
                      <select value={(geminiParams.thinkingLevel as string | undefined) ?? "default"} onChange={(e) => setGeminiParam("thinkingLevel", e.target.value)} className={sel} title="Reasoning effort (model-dependent)">
                        <option value="default">Default</option>
                        <option value="low">Low</option>
                        <option value="high">High</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-neutral-300 mb-1">System Prompt</label>
                    <textarea value={(geminiParams.systemPrompt as string | undefined) ?? ""} rows={2}
                      onChange={(e) => setGeminiParam("systemPrompt", e.target.value)} placeholder="Optional system instruction…"
                      className="nodrag nopan nowheel w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y" />
                  </div>
                </>
              );
            })()}
          </>
        )}

        {/* External provider parameters */}
        {!isGeminiProvider && nodeData.selectedModel?.modelId && (
          <ModelParameters
            modelId={nodeData.selectedModel.modelId}
            provider={currentProvider}
            parameters={nodeData.parameters || {}}
            onParametersChange={handleParametersChange}
          />
        )}
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => regenerateNode(node.id)}
          disabled={!canRun}
          title={blockedReason || undefined}
          className="nodrag nopan inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          {isExecuting ? "Running..." : "Run"}
        </button>
      </div>

      {isBrowseDialogOpen && (
        <ModelSearchDialog
          isOpen={isBrowseDialogOpen}
          onClose={() => setIsBrowseDialogOpen(false)}
          onModelSelected={handleBrowseModelSelect}
          initialCapabilityFilter="image"
        />
      )}
    </>
  );
}

// Upscale Grid Controls — full image-model picker (any provider) + tile/blend params
function UpscaleGridControls({ node }: { node: Node }) {
  const nodeData = node.data as UpscaleGridNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const { canRun, blockedReason, isExecuting } = useCanRun(node.id);
  const { replicateApiKey, falApiKey, kieApiKey, replicateEnabled, kieEnabled } = useProviderApiKeys();
  const [externalModels, setExternalModels] = useState<ProviderModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);

  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "gemini";

  const enabledProviders = useMemo(() => {
    const providers: { id: ProviderType; name: string }[] = [];
    providers.push({ id: "gemini", name: "Gemini" });
    providers.push({ id: "fal", name: "fal.ai" });
    if (replicateEnabled && replicateApiKey) providers.push({ id: "replicate", name: "Replicate" });
    if (kieEnabled && kieApiKey) providers.push({ id: "kie", name: "Kie.ai" });
    return providers;
  }, [replicateEnabled, replicateApiKey, kieEnabled, kieApiKey]);

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
      switch (currentProvider) {
        case "replicate": if (replicateApiKey) headers["X-Replicate-Key"] = replicateApiKey; break;
        case "fal": if (falApiKey) headers["X-Fal-Key"] = falApiKey; break;
        case "kie": if (kieApiKey) headers["X-Kie-Key"] = kieApiKey; break;
      }
      const response = await deduplicatedFetch(`/api/models?provider=${currentProvider}&capabilities=${capabilities}`, { headers });
      if (response.ok) {
        const data = await response.json();
        setExternalModels(data.models || []);
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

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const provider = e.target.value as ProviderType;
      if (provider === "gemini") {
        const modelId = nodeData.model || "nano-banana-pro";
        updateNodeData(node.id, {
          selectedModel: { provider: "gemini", modelId, displayName: GEMINI_IMAGE_MODELS.find(m => m.value === modelId)?.label || "Nano Banana Pro" },
          parameters: {},
        });
      } else {
        updateNodeData(node.id, { selectedModel: { provider, modelId: "", displayName: "Select model..." }, parameters: {} });
      }
    },
    [node.id, nodeData.model, updateNodeData]
  );

  const handleExternalModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const model = externalModels.find(m => m.id === e.target.value);
      if (model) {
        updateNodeData(node.id, {
          selectedModel: { provider: currentProvider, modelId: model.id, displayName: model.name, capabilities: model.capabilities },
          parameters: {},
        });
      }
    },
    [node.id, currentProvider, externalModels, updateNodeData]
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const model = e.target.value as ModelType;
      updateNodeData(node.id, {
        model,
        selectedModel: { provider: "gemini", modelId: model, displayName: GEMINI_IMAGE_MODELS.find(m => m.value === model)?.label || model },
      });
    },
    [node.id, updateNodeData]
  );

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => updateNodeData(node.id, { parameters }),
    [node.id, updateNodeData]
  );

  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    updateNodeData(node.id, {
      selectedModel: { provider: model.provider, modelId: model.id, displayName: model.name, capabilities: model.capabilities },
      parameters: {},
    });
    setIsBrowseDialogOpen(false);
  }, [node.id, updateNodeData]);

  const isGeminiProvider = currentProvider === "gemini";
  const currentModelId = isGeminiProvider ? (nodeData.selectedModel?.modelId || nodeData.model) : null;
  const supportsResolution = currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2";
  const aspectRatios = currentModelId === "nano-banana-2" ? EXTENDED_ASPECT_RATIOS : BASE_ASPECT_RATIOS;
  const resolutions = currentModelId === "nano-banana-2" ? RESOLUTIONS_NB2 : RESOLUTIONS_PRO;
  const selCls = "nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const LONG_EDGE_OPTIONS = [4096, 6144, 8192, 12288, 16384];

  return (
    <>
      <div className="space-y-3">
        {/* Model name + provider + browse */}
        <div className="border-t border-neutral-700 pt-3">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-neutral-100 truncate">
                {nodeData.selectedModel?.displayName || GEMINI_IMAGE_MODELS.find(m => m.value === nodeData.model)?.label || "Select model..."}
              </div>
              <span className="text-[10px] text-neutral-500 truncate block mt-0.5">
                {enabledProviders.find(p => p.id === currentProvider)?.name || currentProvider}
              </span>
            </div>
            <button
              onClick={() => setIsBrowseDialogOpen(true)}
              className="nodrag nopan shrink-0 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
            >
              Browse
            </button>
          </div>
        </div>

        {/* Provider selector */}
        <div>
          <label className="block text-xs font-medium text-neutral-300 mb-1">Provider</label>
          <select value={currentProvider} onChange={handleProviderChange} className={selCls}>
            {enabledProviders.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Gemini controls */}
        {isGeminiProvider && (
          <>
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">Model</label>
              <select value={currentModelId || "nano-banana-pro"} onChange={handleModelChange} className={selCls}>
                {GEMINI_IMAGE_MODELS.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">Aspect Ratio</label>
              <select value={nodeData.aspectRatio || "1:1"} onChange={(e) => updateNodeData(node.id, { aspectRatio: e.target.value as AspectRatio })} className={selCls}>
                {aspectRatios.map(ar => (
                  <option key={ar} value={ar}>{ar === "auto" ? "Auto" : ar}</option>
                ))}
              </select>
            </div>
            {supportsResolution && (
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">Resolution</label>
                <select value={nodeData.resolution || "2K"} onChange={(e) => updateNodeData(node.id, { resolution: e.target.value as Resolution })} className={selCls}>
                  {resolutions.map(res => (
                    <option key={res} value={res}>{res}</option>
                  ))}
                </select>
              </div>
            )}
            {(currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2") && (
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id={`ug-google-search-${node.id}`}
                  checked={nodeData.useGoogleSearch || false}
                  onChange={(e) => updateNodeData(node.id, { useGoogleSearch: e.target.checked })}
                  className="nodrag nopan w-3 h-3 text-blue-600 bg-neutral-700 border-neutral-600 rounded focus:ring-blue-500"
                />
                <label htmlFor={`ug-google-search-${node.id}`} className="ml-2 text-xs text-neutral-300">Google Search</label>
              </div>
            )}
          </>
        )}

        {/* External provider model + parameters */}
        {!isGeminiProvider && (
          <>
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">Model</label>
              <select value={nodeData.selectedModel?.modelId || ""} onChange={handleExternalModelChange} className={selCls} disabled={isLoadingModels}>
                <option value="">{isLoadingModels ? "Loading…" : "Select model…"}</option>
                {externalModels.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
              {modelsFetchError && <span className="text-[10px] text-red-400 block mt-1">{modelsFetchError}</span>}
            </div>
            {nodeData.selectedModel?.modelId && (
              <ModelParameters
                modelId={nodeData.selectedModel.modelId}
                provider={currentProvider}
                parameters={nodeData.parameters || {}}
                onParametersChange={handleParametersChange}
              />
            )}
          </>
        )}

        {/* Upscale-specific params */}
        <div className="border-t border-neutral-700 pt-3 space-y-3">
          <div>
            <label className="block text-xs font-medium text-neutral-300 mb-1" title="Each quadrant crop is this much larger than a perfect quarter">Quadrant Overlap %</label>
            <input
              type="number"
              min={2}
              max={50}
              step={1}
              value={nodeData.overlapPercent ?? 10}
              onChange={(e) => updateNodeData(node.id, { overlapPercent: Math.min(50, Math.max(2, Math.round(Number(e.target.value) || 10))) })}
              className={selCls}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-300 mb-1" title="Long edge of the final blended image">Output Size</label>
            <select value={nodeData.finalLongEdge ?? 8192} onChange={(e) => updateNodeData(node.id, { finalLongEdge: Number(e.target.value) })} className={selCls}>
              {LONG_EDGE_OPTIONS.map(px => (
                <option key={px} value={px}>{px === 8192 ? "8K (8192)" : px === 4096 ? "4K (4096)" : `${px}px`}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => regenerateNode(node.id)}
          disabled={!canRun}
          title={blockedReason || undefined}
          className="nodrag nopan inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          {isExecuting ? "Running..." : "Run"}
        </button>
      </div>

      {isBrowseDialogOpen && (
        <ModelSearchDialog
          isOpen={isBrowseDialogOpen}
          onClose={() => setIsBrowseDialogOpen(false)}
          onModelSelected={handleBrowseModelSelect}
          initialCapabilityFilter="image"
        />
      )}
    </>
  );
}

// Generate Video Controls
function GenerateVideoControls({ node }: { node: Node }) {
  const nodeData = node.data as GenerateVideoNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const { canRun, blockedReason, isExecuting } = useCanRun(node.id);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);

  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "fal";

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      updateNodeData(node.id, { parameters });
    },
    [node.id, updateNodeData]
  );

  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    const newSelectedModel: SelectedModel = {
      provider: model.provider,
      modelId: model.id,
      displayName: model.name,
      capabilities: model.capabilities,
    };
    updateNodeData(node.id, { selectedModel: newSelectedModel, parameters: {} });
    setIsBrowseDialogOpen(false);
  }, [node.id, updateNodeData]);

  return (
    <>
      <div className="space-y-3">
        {/* Model name + provider with link */}
        <div className="border-t border-neutral-700 pt-3">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-neutral-100 truncate">
                {nodeData.selectedModel?.displayName || "Select model..."}
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-[10px] text-neutral-500 truncate">
                  {getProviderDisplayName(currentProvider)}
                </span>
                {nodeData.selectedModel?.modelId && (
                  <a
                    href={getModelPageUrl(currentProvider, nodeData.selectedModel.modelId) || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-neutral-500 hover:text-neutral-300 transition-colors"
                    title={`View on ${getProviderDisplayName(currentProvider)}`}
                    onClick={(e) => {
                      if (!getModelPageUrl(currentProvider, nodeData.selectedModel?.modelId || "")) {
                        e.preventDefault();
                      }
                    }}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            </div>
            <button
              onClick={() => setIsBrowseDialogOpen(true)}
              className="nodrag nopan shrink-0 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
            >
              Browse
            </button>
          </div>
        </div>

        {nodeData.selectedModel?.modelId && (
          <ModelParameters
            modelId={nodeData.selectedModel.modelId}
            provider={currentProvider}
            parameters={nodeData.parameters || {}}
            onParametersChange={handleParametersChange}
          />
        )}
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => regenerateNode(node.id)}
          disabled={!canRun}
          title={blockedReason || undefined}
          className="nodrag nopan inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          {isExecuting ? "Running..." : "Run"}
        </button>
      </div>

      {isBrowseDialogOpen && (
        <ModelSearchDialog
          isOpen={isBrowseDialogOpen}
          onClose={() => setIsBrowseDialogOpen(false)}
          onModelSelected={handleBrowseModelSelect}
          initialCapabilityFilter="video"
        />
      )}
    </>
  );
}

// Generate 3D Controls
function Generate3DControls({ node }: { node: Node }) {
  const nodeData = node.data as Generate3DNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const { canRun, blockedReason, isExecuting } = useCanRun(node.id);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);

  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "fal";

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      updateNodeData(node.id, { parameters });
    },
    [node.id, updateNodeData]
  );

  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    updateNodeData(node.id, {
      selectedModel: {
        provider: model.provider,
        modelId: model.id,
        displayName: model.name,
        capabilities: model.capabilities,
      },
      parameters: {}
    });
    setIsBrowseDialogOpen(false);
  }, [node.id, updateNodeData]);

  return (
    <>
      <div className="space-y-3">
        {/* Model name + provider with link */}
        <div className="border-t border-neutral-700 pt-3">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-neutral-100 truncate">
                {nodeData.selectedModel?.displayName || "Select model..."}
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-[10px] text-neutral-500 truncate">
                  {getProviderDisplayName(currentProvider)}
                </span>
                {nodeData.selectedModel?.modelId && (
                  <a
                    href={getModelPageUrl(currentProvider, nodeData.selectedModel.modelId) || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-neutral-500 hover:text-neutral-300 transition-colors"
                    title={`View on ${getProviderDisplayName(currentProvider)}`}
                    onClick={(e) => {
                      if (!getModelPageUrl(currentProvider, nodeData.selectedModel?.modelId || "")) {
                        e.preventDefault();
                      }
                    }}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            </div>
            <button
              onClick={() => setIsBrowseDialogOpen(true)}
              className="nodrag nopan shrink-0 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
            >
              Browse
            </button>
          </div>
        </div>

        {nodeData.selectedModel?.modelId && (
          <ModelParameters
            modelId={nodeData.selectedModel.modelId}
            provider={currentProvider}
            parameters={nodeData.parameters || {}}
            onParametersChange={handleParametersChange}
          />
        )}
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => regenerateNode(node.id)}
          disabled={!canRun}
          title={blockedReason || undefined}
          className="nodrag nopan inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          {isExecuting ? "Running..." : "Run"}
        </button>
      </div>

      {isBrowseDialogOpen && (
        <ModelSearchDialog
          isOpen={isBrowseDialogOpen}
          onClose={() => setIsBrowseDialogOpen(false)}
          onModelSelected={handleBrowseModelSelect}
          initialCapabilityFilter="3d"
        />
      )}
    </>
  );
}

// Generate Audio Controls
function GenerateAudioControls({ node }: { node: Node }) {
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const { canRun, blockedReason, isExecuting } = useCanRun(node.id);

  return (
    <div className="space-y-3">
      <div className="text-xs text-neutral-400">
        Audio generation settings
      </div>
      <div className="flex justify-end">
        <button
          onClick={() => regenerateNode(node.id)}
          disabled={!canRun}
          title={blockedReason || undefined}
          className="nodrag nopan inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          {isExecuting ? "Running..." : "Run"}
        </button>
      </div>
    </div>
  );
}

// LLM Controls
function LLMControls({ node }: { node: Node }) {
  const nodeData = node.data as LLMGenerateNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const { canRun, blockedReason, isExecuting } = useCanRun(node.id);

  // Live per-provider model lists (Google/OpenAI/Anthropic), fetched via
  // /api/llm/models. Shared with LLMGenerateNode's inline params so the
  // two surfaces stay in sync.
  const { modelLists, refresh: handleRefreshModels } = useLlmModelLists();

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newProvider = e.target.value as LLMProvider;
      const firstModelForProvider =
        modelLists[newProvider][0]?.value ?? FALLBACK_MODELS[newProvider][0].value;
      const updates: Partial<LLMGenerateNodeData> = {
        provider: newProvider,
        model: firstModelForProvider,
      };
      if (newProvider === "anthropic" && nodeData.temperature > 1) {
        updates.temperature = 1;
      }
      updateNodeData(node.id, updates);
    },
    [node.id, updateNodeData, nodeData.temperature, modelLists]
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateNodeData(node.id, { model: e.target.value as LLMModelType });
    },
    [node.id, updateNodeData]
  );

  const handleTemperatureChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(node.id, { temperature: parseFloat(e.target.value) });
    },
    [node.id, updateNodeData]
  );

  const handleMaxTokensChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(node.id, { maxTokens: parseInt(e.target.value, 10) });
    },
    [node.id, updateNodeData]
  );

  // ─── Conversation handlers (mirror LLMGenerateNode's inline panel) ──
  const conversation = nodeData.conversation ?? [];
  const conversationMode = nodeData.conversationMode === true;

  const handleToggleConversationMode = useCallback(() => {
    updateNodeData(node.id, { conversationMode: !conversationMode });
  }, [node.id, conversationMode, updateNodeData]);

  const handleSystemPromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      // Hand-editing detaches from the loaded skill (the text is now the user's).
      updateNodeData(node.id, { systemPrompt: e.target.value, promptSkillName: undefined });
    },
    [node.id, updateNodeData]
  );

  const handleApplySkill = useCallback(
    (skill: { name: string; body: string }) => {
      updateNodeData(node.id, { systemPrompt: skill.body, promptSkillName: skill.name });
    },
    [node.id, updateNodeData]
  );

  const handleClearSkill = useCallback(() => {
    updateNodeData(node.id, { systemPrompt: "", promptSkillName: undefined });
  }, [node.id, updateNodeData]);

  const handleMaxHistoryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const n = parseInt(e.target.value, 10);
      updateNodeData(node.id, { maxHistoryTurns: Number.isFinite(n) && n >= 0 ? n : 0 });
    },
    [node.id, updateNodeData]
  );

  const handleClearConversation = useCallback(() => {
    if (conversation.length === 0) return;
    if (!confirm("Clear all conversation history? (System prompt is kept.)")) return;
    updateNodeData(node.id, { conversation: [], outputText: null });
  }, [node.id, conversation.length, updateNodeData]);

  const handleReasoningChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateNodeData(node.id, { reasoning: e.target.value as "off" | "low" | "medium" | "high" });
    },
    [node.id, updateNodeData],
  );

  const provider = nodeData.provider || "google";
  const baseModels = modelLists[provider] || FALLBACK_MODELS[provider];
  // Tack a non-listed saved model onto the top of the dropdown so it can
  // still display (mirrors LLMGenerateNode behaviour).
  const availableModels = useMemo(() => {
    if (!nodeData.model) return baseModels;
    if (baseModels.some((m) => m.value === nodeData.model)) return baseModels;
    return [{ value: nodeData.model, label: `${nodeData.model} (saved)` }, ...baseModels];
  }, [baseModels, nodeData.model]);

  // Auto-fill the newest model when none is set — see LLMGenerateNode.
  useEffect(() => {
    if (!nodeData.model && baseModels.length > 0) {
      updateNodeData(node.id, { model: baseModels[0].value });
    }
  }, [node.id, nodeData.model, baseModels, updateNodeData]);

  // Reasoning support gating (mirrors /api/llm/route.ts).
  const supportsReasoning = useMemo(() => {
    const m = (nodeData.model || "").toLowerCase();
    if (provider === "openai") return /^o[134](-|$)/.test(m) || /^gpt-5/.test(m);
    if (provider === "anthropic") return /^claude-3-7-sonnet/.test(m) || /^claude-(opus|sonnet|haiku)-[4-9]/.test(m);
    if (provider === "google") {
      if (!/^gemini-(2\.5|3)/.test(m)) return false;
      if (/-image\b/.test(m) || /-tts\b/.test(m)) return false;
      return true;
    }
    return false;
  }, [provider, nodeData.model]);
  const reasoningLevel = (nodeData.reasoning ?? "off") as "off" | "low" | "medium" | "high";

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-neutral-300 mb-1">Provider</label>
        <select
          value={provider}
          onChange={handleProviderChange}
          className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {LLM_PROVIDERS.map(p => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-300 mb-1">Model</label>
        <div className="flex items-center gap-1">
          <select
            value={nodeData.model || availableModels[0].value}
            onChange={handleModelChange}
            className="nodrag nopan flex-1 min-w-0 px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {availableModels.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <button
            onClick={handleRefreshModels}
            title="Refresh model list from each provider"
            className="nodrag nopan w-6 h-6 shrink-0 rounded text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors flex items-center justify-center"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-300 mb-1">
          Temperature: {(nodeData.temperature ?? 0.7).toFixed(2)}
        </label>
        <input
          type="range"
          min="0"
          max={provider === "anthropic" ? "1" : "2"}
          step="0.01"
          value={nodeData.temperature ?? 0.7}
          onChange={handleTemperatureChange}
          className="nodrag nopan w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-300 mb-1">
          Max Tokens: {(nodeData.maxTokens || 2048).toLocaleString()}
        </label>
        <input
          type="range"
          min="256"
          max="16384"
          step="256"
          value={nodeData.maxTokens || 2048}
          onChange={handleMaxTokensChange}
          className="nodrag nopan w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
      </div>

      {supportsReasoning && (
        <div>
          <label className="block text-xs font-medium text-neutral-300 mb-1">Reasoning</label>
          <select
            value={reasoningLevel}
            onChange={handleReasoningChange}
            title="Higher = more thinking before reply. Costs more output tokens."
            className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="off">Off (provider default)</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      )}

      {/* ─── System prompt + prompt skill (applies in both modes) ─── */}
      <div className="border-t border-neutral-700 pt-3 space-y-2">
        <label className="block text-[10px] text-neutral-500">System prompt</label>
        <PromptSkillPicker
          activeSkillName={nodeData.promptSkillName}
          onApply={handleApplySkill}
          onClear={handleClearSkill}
        />
        <textarea
          value={nodeData.systemPrompt ?? ""}
          onChange={handleSystemPromptChange}
          placeholder="(optional) instructions — or load a prompt skill above"
          rows={2}
          className="nodrag nopan w-full text-xs py-1 px-2 bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y min-h-[48px] max-h-[160px]"
        />
      </div>

      {/* ─── Conversation mode ─────────────────────────────── */}
      <div className="border-t border-neutral-700 pt-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={conversationMode}
            onChange={handleToggleConversationMode}
            className="nodrag accent-blue-500"
          />
          <span className="text-xs font-medium text-neutral-300">Conversation mode</span>
          {conversationMode && conversation.length > 0 && (
            <span className="text-[10px] text-neutral-500 ml-auto">
              {conversation.filter(t => t.role === "user").length} turn{conversation.filter(t => t.role === "user").length === 1 ? "" : "s"}
            </span>
          )}
        </label>
        {conversationMode && (
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-neutral-500 shrink-0">Max turns</label>
              <input
                type="number"
                min={0}
                step={1}
                value={nodeData.maxHistoryTurns ?? 0}
                onChange={handleMaxHistoryChange}
                title="Most-recent N user+assistant pairs to send each request. 0 = unlimited."
                className="nodrag nopan w-16 text-xs py-0.5 px-1 bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500 tabular-nums"
              />
              <button
                onClick={handleClearConversation}
                disabled={conversation.length === 0}
                className="nodrag nopan ml-auto text-[10px] py-1 px-2 rounded bg-neutral-700 hover:bg-red-900/60 text-neutral-300 disabled:opacity-40 disabled:hover:bg-neutral-700 transition-colors"
              >
                Clear history
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => regenerateNode(node.id)}
          disabled={!canRun}
          title={blockedReason || undefined}
          className="nodrag nopan inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          {isExecuting ? "Running..." : "Run"}
        </button>
      </div>
    </div>
  );
}

// Ease Curve Controls
function EaseCurveControls({ node }: { node: Node }) {
  const nodeData = node.data as EaseCurveNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const { canRun, blockedReason, isExecuting } = useCanRun(node.id);
  const edges = useWorkflowStore((state) => state.edges);
  const removeEdge = useWorkflowStore((state) => state.removeEdge);
  const [showPresets, setShowPresets] = useState(false);
  const presetsButtonRef = useRef<HTMLButtonElement>(null);
  const presetsPopupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showPresets) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowPresets(false);
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (presetsButtonRef.current?.contains(e.target as HTMLElement)) return;
      if (presetsPopupRef.current?.contains(e.target as HTMLElement)) return;
      setShowPresets(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showPresets]);

  const inheritedEdge = useMemo(() => {
    return edges.find((e) => e.target === node.id && e.targetHandle === "easeCurve") || null;
  }, [edges, node.id]);

  const isInherited = !!inheritedEdge;

  const handleBreakInheritance = useCallback(() => {
    if (inheritedEdge) {
      removeEdge(inheritedEdge.id);
      updateNodeData(node.id, { inheritedFrom: null });
    }
  }, [inheritedEdge, removeEdge, node.id, updateNodeData]);

  const handleBezierChange = useCallback(
    (value: [number, number, number, number]) => {
      updateNodeData(node.id, { bezierHandles: value, easingPreset: null });
    },
    [node.id, updateNodeData]
  );

  const handleSelectEasing = useCallback(
    (name: string) => {
      updateNodeData(node.id, {
        easingPreset: name,
        bezierHandles: getEasingBezier(name),
      });
      setShowPresets(false);
    },
    [node.id, updateNodeData]
  );

  const handleDurationChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseFloat(e.target.value);
      updateNodeData(node.id, { outputDuration: isNaN(val) ? 1.5 : Math.max(0.1, Math.min(30, val)) });
    },
    [node.id, updateNodeData]
  );

  const editorEasingCurve = useMemo(() => {
    if (!nodeData.easingPreset) return undefined;
    return generateEasingPolyline(nodeData.easingPreset, 100, 100, 50);
  }, [nodeData.easingPreset]);

  const presetThumbnails = useMemo(() => {
    return ALL_EASING_NAMES.map((name) => ({
      name,
      polyline: generateEasingPolyline(name, 36, 36),
      isPreset: PRESET_NAMES.has(name as any),
    }));
  }, []);

  return (
    <div className="space-y-3 relative">
      {isInherited && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-900/80 backdrop-blur-sm rounded z-10">
          <p className="text-sm text-neutral-200 font-medium">Settings inherited</p>
          <p className="text-[11px] text-neutral-400 mt-1">Break connection to edit manually</p>
          <button
            className="nodrag nopan mt-3 px-3 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded text-xs text-neutral-200 transition-colors"
            onClick={handleBreakInheritance}
          >
            Control manually
          </button>
        </div>
      )}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-xs font-medium text-neutral-300">Easing Function</label>
          <button
            ref={presetsButtonRef}
            onClick={() => setShowPresets(!showPresets)}
            className="nodrag nopan text-xs px-2 py-0.5 bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
          >
            Presets
          </button>
        </div>
        <CubicBezierEditor
          value={nodeData.bezierHandles || [0.42, 0, 0.58, 1]}
          onChange={handleBezierChange}
          onCommit={handleBezierChange}
          easingCurve={editorEasingCurve}
        />
        {nodeData.easingPreset && (
          <div className="text-xs text-neutral-400 mt-1">
            Current: {nodeData.easingPreset}
          </div>
        )}
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-300 mb-1">
          Output Duration: {nodeData.outputDuration?.toFixed(1) || "1.5"}s
        </label>
        <input
          type="number"
          min="0.1"
          max="30"
          step="0.1"
          value={nodeData.outputDuration || 1.5}
          onChange={handleDurationChange}
          className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => regenerateNode(node.id)}
          disabled={!canRun}
          title={blockedReason || undefined}
          className="nodrag nopan inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
          {isExecuting ? "Applying..." : "Apply"}
        </button>
      </div>

      {showPresets && typeof document !== 'undefined' && createPortal(
        <div
          ref={presetsPopupRef}
          className="fixed z-[100] bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl p-2 max-h-[60vh] overflow-y-auto nowheel"
          style={{
            top: presetsButtonRef.current?.getBoundingClientRect().bottom || 0,
            right: window.innerWidth - (presetsButtonRef.current?.getBoundingClientRect().left || 0),
            width: 280,
          }}
        >
          <div className="grid grid-cols-4 gap-1">
            {presetThumbnails.map(({ name, polyline }) => (
              <button
                key={name}
                onClick={() => handleSelectEasing(name)}
                className="nodrag nopan p-1 bg-neutral-900 hover:bg-neutral-700 rounded flex flex-col items-center gap-1 transition-colors"
                title={name}
              >
                <svg width="36" height="36" viewBox="0 0 36 36" className="flex-shrink-0">
                  <polyline
                    points={polyline}
                    fill="none"
                    stroke="#a3a3a3"
                    strokeWidth="1.5"
                  />
                </svg>
                <span className="text-[8px] text-neutral-400 text-center break-words w-full">
                  {name}
                </span>
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Conditional Switch Controls
function ConditionalSwitchControls({ node }: { node: Node }) {
  const nodeData = node.data as ConditionalSwitchNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const { canRun, blockedReason, isExecuting } = useCanRun(node.id);
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleRuleValueChange = useCallback(
    (ruleId: string, newValue: string) => {
      const updatedRules = nodeData.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, value: newValue } : rule
      );
      updateNodeData(node.id, { rules: updatedRules, evaluationPaused: false });
    },
    [node.id, nodeData.rules, updateNodeData]
  );

  const handleModeChange = useCallback(
    (ruleId: string, newMode: MatchMode) => {
      const updatedRules = nodeData.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, mode: newMode } : rule
      );
      updateNodeData(node.id, { rules: updatedRules, evaluationPaused: false });
    },
    [node.id, nodeData.rules, updateNodeData]
  );

  const handleLabelEdit = useCallback(
    (ruleId: string, newLabel: string) => {
      const updatedRules = nodeData.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, label: newLabel } : rule
      );
      updateNodeData(node.id, { rules: updatedRules });
      setEditingId(null);
    },
    [node.id, nodeData.rules, updateNodeData]
  );

  const handleDelete = useCallback(
    (ruleId: string) => {
      if (nodeData.rules.length <= 1) return;
      const updatedRules = nodeData.rules.filter((rule) => rule.id !== ruleId);
      updateNodeData(node.id, { rules: updatedRules });
    },
    [node.id, nodeData.rules, updateNodeData]
  );

  const handleAddRule = useCallback(() => {
    const newRule: ConditionalSwitchRule = {
      id: "rule-" + Math.random().toString(36).slice(2, 9),
      value: "",
      mode: "contains",
      label: `Rule ${nodeData.rules.length + 1}`,
      isMatched: false,
    };
    updateNodeData(node.id, { rules: [...nodeData.rules, newRule] });
  }, [node.id, nodeData.rules, updateNodeData]);

  return (
    <div className="space-y-2">
      {nodeData.rules.map((rule, index) => (
        <div key={rule.id} className="border border-neutral-600 rounded p-2 space-y-2">
          <div className="flex items-center justify-between">
            <input
              type="text"
              value={editingId === rule.id ? rule.label : rule.label || `Rule ${index + 1}`}
              onChange={(e) => handleLabelEdit(rule.id, e.target.value)}
              onFocus={() => setEditingId(rule.id)}
              onBlur={() => setEditingId(null)}
              className="nodrag nopan flex-1 px-1 py-0.5 text-xs bg-transparent border-none text-neutral-200 focus:outline-none"
            />
            {nodeData.rules.length > 1 && (
              <button
                onClick={() => handleDelete(rule.id)}
                className="nodrag nopan text-neutral-500 hover:text-red-400"
                title="Delete rule"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          <select
            value={rule.mode}
            onChange={(e) => handleModeChange(rule.id, e.target.value as MatchMode)}
            className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="exact">Exact match</option>
            <option value="contains">Contains</option>
            <option value="starts-with">Starts with</option>
            <option value="ends-with">Ends with</option>
          </select>

          <input
            type="text"
            value={rule.value}
            onChange={(e) => handleRuleValueChange(rule.id, e.target.value)}
            placeholder="Enter match value"
            className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />

          {rule.isMatched !== undefined && (
            <div className="flex items-center gap-1">
              <div className={`w-2 h-2 rounded-full ${rule.isMatched ? 'bg-green-500' : 'bg-neutral-600'}`} />
              <span className="text-xs text-neutral-400">
                {rule.isMatched ? 'Matched' : 'Not matched'}
              </span>
            </div>
          )}
        </div>
      ))}

      <button
        onClick={handleAddRule}
        className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
      >
        + Add Rule
      </button>

      <div className="flex justify-end">
        <button
          onClick={() => regenerateNode(node.id)}
          disabled={!canRun}
          title={blockedReason || undefined}
          className="nodrag nopan inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          {isExecuting ? "Running..." : "Run"}
        </button>
      </div>
    </div>
  );
}
