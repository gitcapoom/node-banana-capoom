"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { buildLlmHeaders } from "@/store/utils/buildApiHeaders";
import { LLMGenerateNodeData, LLMProvider, LLMModelType } from "@/types";
import { useInlineParameters } from "@/hooks/useInlineParameters";
import { InlineParameterPanel } from "./InlineParameterPanel";

// LLM providers — the model list for each is fetched dynamically below.
const LLM_PROVIDERS: { value: LLMProvider; label: string }[] = [
  { value: "google", label: "Google" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
];

// Fallback model lists used when the live `/api/llm/models` call hasn't
// resolved yet, or when the user has no API key configured for that
// provider. Keeps the dropdown functional offline. Kept short on purpose
// — once the live fetch completes it replaces this with everything the
// provider advertises (filtered to chat-completion models).
const FALLBACK_MODELS: Record<LLMProvider, { value: string; label: string }[]> = {
  google: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
    { value: "gemini-3-pro-preview", label: "Gemini 3.0 Pro" },
    { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  ],
  openai: [
    { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
  ],
  anthropic: [
    { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { value: "claude-opus-4.6", label: "Claude Opus 4.6" },
  ],
};

// Module-level cache so all instances of the node share one fetch.
// Re-fetched when the user provides API keys (cache key = the joined key
// triple), and on an explicit refresh.
type ModelLists = Record<LLMProvider, { value: string; label: string }[]>;
let modelCachePromise: Promise<ModelLists> | null = null;
let modelCacheKey: string | null = null;

async function fetchModelLists(
  headers: Record<string, string>,
): Promise<ModelLists> {
  const lists: ModelLists = { google: [], openai: [], anthropic: [] };
  try {
    const res = await fetch("/api/llm/models", { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: {
      google: { id: string; label: string }[];
      openai: { id: string; label: string }[];
      anthropic: { id: string; label: string }[];
    } = await res.json();
    for (const provider of ["google", "openai", "anthropic"] as const) {
      lists[provider] = (data[provider] || []).map((m) => ({ value: m.id, label: m.label }));
    }
  } catch (err) {
    console.warn("[LLMGenerateNode] failed to fetch model list, falling back to static list:", err);
  }
  // Anywhere the live fetch yielded nothing, fall back so the dropdown
  // still has options.
  for (const provider of ["google", "openai", "anthropic"] as const) {
    if (!lists[provider].length) lists[provider] = FALLBACK_MODELS[provider];
  }
  return lists;
}

type LLMGenerateNodeType = Node<LLMGenerateNodeData, "llmGenerate">;

export function LLMGenerateNode({ id, data, selected }: NodeProps<LLMGenerateNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);

  // Inline parameters infrastructure
  const { inlineParametersEnabled } = useInlineParameters();

  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const handleClearOutput = useCallback(() => {
    updateNodeData(id, { outputText: null, status: "idle", error: null });
  }, [id, updateNodeData]);

  const [copied, setCopied] = useState(false);

  const handleCopyOutput = useCallback(async () => {
    if (nodeData.outputText) {
      try {
        await navigator.clipboard.writeText(nodeData.outputText);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch (err) {
        console.error("Failed to copy text:", err);
      }
    }
  }, [nodeData.outputText]);

  // Inline parameters: compute collapse state and toggle handler
  const isParamsExpanded = nodeData.parametersExpanded ?? true; // default expanded

  const handleToggleParams = useCallback(() => {
    updateNodeData(id, { parametersExpanded: !isParamsExpanded });
  }, [id, isParamsExpanded, updateNodeData]);

  // Pull the API keys via the same helper the executor uses, then key the
  // model-list cache by them so adding a key re-fetches automatically.
  const providerSettings = useWorkflowStore((s) => s.providerSettings);
  const llmKeys = useMemo(
    () => ({
      google: providerSettings.providers.gemini?.apiKey || "",
      openai: providerSettings.providers.openai?.apiKey || "",
      anthropic: providerSettings.providers.anthropic?.apiKey || "",
    }),
    [providerSettings],
  );

  const [modelLists, setModelLists] = useState<ModelLists>(FALLBACK_MODELS);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const cacheKey = `${llmKeys.google}|${llmKeys.openai}|${llmKeys.anthropic}|${refreshTick}`;
    if (modelCacheKey !== cacheKey || !modelCachePromise) {
      modelCacheKey = cacheKey;
      // Build the headers for /api/llm/models the same way an executor would
      // build them for /api/llm. We deliberately union all three providers'
      // headers in one request so the endpoint can fan out in parallel.
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      Object.assign(headers, buildLlmHeaders("google", providerSettings));
      Object.assign(headers, buildLlmHeaders("openai", providerSettings));
      Object.assign(headers, buildLlmHeaders("anthropic", providerSettings));
      modelCachePromise = fetchModelLists(headers);
    }
    let cancelled = false;
    modelCachePromise.then((lists) => {
      if (!cancelled) setModelLists(lists);
    });
    return () => { cancelled = true; };
  }, [llmKeys.google, llmKeys.openai, llmKeys.anthropic, providerSettings, refreshTick]);

  const handleRefreshModels = useCallback(() => {
    // Invalidate the module cache and re-fetch.
    modelCachePromise = null;
    modelCacheKey = null;
    setRefreshTick((n) => n + 1);
  }, []);

  // LLM parameter handlers
  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newProvider = e.target.value as LLMProvider;
      const firstModelForProvider =
        modelLists[newProvider][0]?.value ?? FALLBACK_MODELS[newProvider][0].value;
      const updates: Partial<LLMGenerateNodeData> = {
        provider: newProvider,
        model: firstModelForProvider,
      };
      if (newProvider === "anthropic" && (nodeData.temperature ?? 0.7) > 1) {
        updates.temperature = 1;
      }
      updateNodeData(id, updates);
    },
    [id, nodeData.temperature, modelLists, updateNodeData]
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateNodeData(id, { model: e.target.value as LLMModelType });
    },
    [id, updateNodeData]
  );

  const handleTemperatureChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { temperature: parseFloat(e.target.value) });
    },
    [id, updateNodeData]
  );

  const handleMaxTokensChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { maxTokens: parseInt(e.target.value, 10) });
    },
    [id, updateNodeData]
  );

  const provider = nodeData.provider || "google";
  // Use the live list when present; if the selected model isn't in the
  // live list (e.g. legacy alias like "claude-sonnet-4.5"), tack it on at
  // the top so the dropdown can still display it.
  const baseModels = modelLists[provider] || FALLBACK_MODELS[provider];
  const availableModels = useMemo(() => {
    if (!nodeData.model) return baseModels;
    if (baseModels.some((m) => m.value === nodeData.model)) return baseModels;
    return [{ value: nodeData.model, label: `${nodeData.model} (saved)` }, ...baseModels];
  }, [baseModels, nodeData.model]);

  return (
    <BaseNode
      id={id}
      selected={selected}
      hasError={nodeData.status === "error"}
      isExecuting={isRunning}
      fullBleed
      settingsExpanded={inlineParametersEnabled && isParamsExpanded}
      settingsPanel={inlineParametersEnabled ? (
        <InlineParameterPanel
          expanded={isParamsExpanded}
          onToggle={handleToggleParams}
          nodeId={id}
        >
          {/* LLM-specific controls */}
          <div className="space-y-1.5 max-w-[280px]">
            {/* Provider */}
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-neutral-400 shrink-0">Provider</label>
              <select
                value={provider}
                onChange={handleProviderChange}
                className="nodrag nopan flex-1 min-w-0 text-[11px] py-1 px-2 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white"
              >
                {LLM_PROVIDERS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            {/* Model */}
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-neutral-400 shrink-0">Model</label>
              <select
                value={nodeData.model || availableModels[0].value}
                onChange={handleModelChange}
                className="nodrag nopan flex-1 min-w-0 text-[11px] py-1 px-2 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white"
              >
                {availableModels.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              <button
                onClick={handleRefreshModels}
                title="Refresh model list from each provider"
                className="nodrag nopan w-5 h-5 shrink-0 rounded text-neutral-500 hover:text-white hover:bg-neutral-800 transition-colors flex items-center justify-center"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>

            {/* Temperature */}
            <div className="flex flex-col gap-0.5">
              <label className="text-[11px] text-neutral-400">
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

            {/* Max Tokens */}
            <div className="flex flex-col gap-0.5">
              <label className="text-[11px] text-neutral-400">
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
          </div>
        </InlineParameterPanel>
      ) : undefined}
    >
      {/* Image input - optional */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        style={{ top: "35%" }}
        data-handletype="image"
      />
      {/* Text input */}
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        style={{ top: "65%" }}
        data-handletype="text"
      />
      {/* Text output */}
      <Handle
        type="source"
        position={Position.Right}
        id="text"
        data-handletype="text"
      />

      <div className="relative w-full h-full min-h-0 overflow-hidden rounded-lg">
        {nodeData.status === "loading" ? (
          <div className="w-full h-full bg-neutral-900/40 flex items-center justify-center">
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
          </div>
        ) : nodeData.status === "error" ? (
          <div className="w-full h-full bg-red-900/40 flex flex-col items-center justify-center gap-1">
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
            {nodeData.error && (
              <span className="text-red-200 text-[10px] text-center px-3 mt-1 line-clamp-3">{nodeData.error}</span>
            )}
          </div>
        ) : nodeData.outputText ? (
          <div className="group/text relative w-full h-full bg-neutral-900/40 p-2 overflow-auto nowheel">
            <p className="text-[10px] text-neutral-300 whitespace-pre-wrap break-words">
              {nodeData.outputText}
            </p>
            <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover/text:opacity-100 transition-opacity">
              <button
                onClick={handleCopyOutput}
                className={`nodrag nopan w-5 h-5 ${copied ? "bg-green-600/80" : "bg-neutral-900/80 hover:bg-neutral-700/80"} rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors`}
                title={copied ? "Copied!" : "Copy to clipboard"}
              >
                {copied ? (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
              <button
                onClick={handleRegenerate}
                disabled={isRunning}
                className="nodrag nopan w-5 h-5 bg-neutral-900/80 hover:bg-blue-600/80 disabled:opacity-50 disabled:cursor-not-allowed rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Regenerate"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
              <button
                onClick={handleClearOutput}
                className="nodrag nopan w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Clear output"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        ) : (
          <div className="w-full h-full bg-neutral-900/40 flex items-center justify-center">
            <span className="text-neutral-500 text-[10px]">
              Run to generate
            </span>
          </div>
        )}
      </div>

    </BaseNode>
  );
}
