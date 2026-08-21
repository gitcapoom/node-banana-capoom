"use client";

import { useCallback, useMemo, useState, useRef, useEffect } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { LLMGenerateNodeData, LLMProvider, LLMModelType, ConversationTurn } from "@/types";
import { useInlineParameters } from "@/hooks/useInlineParameters";
import { InlineParameterPanel } from "./InlineParameterPanel";
import { useLlmModelLists, FALLBACK_MODELS } from "@/hooks/useLlmModelLists";
import { useCanRun } from "@/hooks/useCanRun";
import { useDynamicPinsEnabled } from "@/lib/dynamicPins";
import { DynamicInputHandles } from "./DynamicInputHandles";
import { PromptSkillPicker } from "./PromptSkillPicker";
import { LLMChatPanel } from "./LLMChatPanel";

// LLM providers — the model list for each is fetched live via the
// `useLlmModelLists` hook (shared with ControlPanel).
const LLM_PROVIDERS: { value: LLMProvider; label: string }[] = [
  { value: "google", label: "Google" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
];

type LLMGenerateNodeType = Node<LLMGenerateNodeData, "llmGenerate">;

export function LLMGenerateNode({ id, data, selected }: NodeProps<LLMGenerateNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  // Per-node Run gating: canRun is true unless this node is currently
  // executing or one of its upstream deps is. Use `isExecuting` for the
  // executing-border / "Running..." labels; don't fall back to the
  // global `state.isRunning` (which lights up unrelated nodes).
  const { canRun, blockedReason, isExecuting } = useCanRun(id);

  // Inline parameters infrastructure
  const { inlineParametersEnabled } = useInlineParameters();
  const dynamicPinsOn = useDynamicPinsEnabled();

  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  // A single "Send" action (= handleRegenerate). It shows the model
  // the latest render (if any) + references, folds in the compose-box direction,
  // assesses the render when there is one, and returns a refined prompt. It does
  // NOT generate — the user runs the generator node directly.

  // Inline parameters: compute collapse state and toggle handler
  const isParamsExpanded = nodeData.parametersExpanded ?? true; // default expanded

  const handleToggleParams = useCallback(() => {
    updateNodeData(id, { parametersExpanded: !isParamsExpanded });
  }, [id, isParamsExpanded, updateNodeData]);

  const { modelLists, refresh: handleRefreshModels } = useLlmModelLists();

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

  // ─── Conversation mode handlers ───────────────────────────────
  const conversation = nodeData.conversation ?? [];
  const rememberTurns = nodeData.rememberTurns === true;


  const handleSystemPromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      // Hand-editing detaches from the loaded skill (the text is now the user's).
      updateNodeData(id, { systemPrompt: e.target.value, promptSkillName: undefined });
    },
    [id, updateNodeData]
  );

  // ─── Prompt-skill library ─────────────────────────────────────
  const handleApplySkill = useCallback(
    (skill: { name: string; body: string }) => {
      updateNodeData(id, { systemPrompt: skill.body, promptSkillName: skill.name });
    },
    [id, updateNodeData]
  );

  const handleClearSkill = useCallback(() => {
    updateNodeData(id, { systemPrompt: "", promptSkillName: undefined });
  }, [id, updateNodeData]);

  const handleMaxHistoryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const n = parseInt(e.target.value, 10);
      updateNodeData(id, { maxHistoryTurns: Number.isFinite(n) && n >= 0 ? n : 0 });
    },
    [id, updateNodeData]
  );

  const handleClearConversation = useCallback(() => {
    if (conversation.length === 0) return;
    if (!confirm("Clear all conversation history? (System prompt is kept.)")) return;
    updateNodeData(id, { conversation: [], outputText: null });
  }, [id, conversation.length, updateNodeData]);

  const handleRemoveTurn = useCallback(
    (index: number) => {
      const next = conversation.slice(0, index).concat(conversation.slice(index + 1));
      // If we just removed the last assistant turn, also clear outputText so
      // downstream pins don't keep emitting it.
      const lastWasAssistant =
        index === conversation.length - 1 && conversation[index]?.role === "assistant";
      updateNodeData(id, {
        conversation: next,
        ...(lastWasAssistant ? { outputText: null } : {}),
      });
    },
    [id, conversation, updateNodeData]
  );

  // Auto-scroll the transcript to the bottom when new turns arrive.
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation.length, nodeData.status]);

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

  // Auto-fill the latest model when none is set. New nodes are created
  // with `model: ""` so this picks up the live list's freshest entry as
  // soon as the fetch resolves. Only fires while model is empty — a user
  // who explicitly picks an older model from the dropdown keeps it.
  useEffect(() => {
    if (!nodeData.model && baseModels.length > 0) {
      updateNodeData(id, { model: baseModels[0].value });
    }
  }, [id, nodeData.model, baseModels, updateNodeData]);

  // Reasoning support gating — hide the dial when the selected model
  // doesn't accept it. Mirrors the helpers in /api/llm/route.ts.
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
  const handleReasoningChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateNodeData(id, { reasoning: e.target.value as "off" | "low" | "medium" | "high" });
    },
    [id, updateNodeData],
  );

  return (
    <BaseNode
      id={id}
      selected={selected}
      hasError={nodeData.status === "error"}
      isExecuting={isExecuting}
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
                Max Tokens: {(nodeData.maxTokens || 8192).toLocaleString()}
              </label>
              <input
                type="range"
                min="256"
                max="32768"
                step="256"
                value={nodeData.maxTokens || 8192}
                onChange={handleMaxTokensChange}
                className="nodrag nopan w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>

            {/* Reasoning (only when the selected model supports it) */}
            {supportsReasoning && (
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-neutral-400 shrink-0">Reasoning</label>
                <select
                  value={reasoningLevel}
                  onChange={handleReasoningChange}
                  className="nodrag nopan flex-1 min-w-0 text-[11px] py-1 px-2 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white"
                  title="Higher = more thinking before reply. Costs more output tokens."
                >
                  <option value="off">Off (provider default)</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            )}

            {/* ─── System prompt + prompt skill (applies in both modes) ─── */}
            <div className="border-t border-neutral-800 pt-1.5 mt-1 flex flex-col gap-1">
              <label className="text-[10px] text-neutral-500">System prompt</label>
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
                className="nodrag nopan w-full text-[11px] py-1 px-2 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white resize-y min-h-[36px] max-h-[120px]"
              />
            </div>

            {/* ─── Conversation mode ───────────────────────── */}
            <div className="border-t border-neutral-800 pt-1.5 mt-1">
              <div className="flex items-center gap-2">
                <label className="nodrag nopan flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rememberTurns}
                    onChange={(e) => updateNodeData(id, { rememberTurns: e.target.checked })}
                    className="nodrag accent-indigo-600"
                  />
                  Remember previous turns
                </label>
                {conversation.length > 0 && (
                  <span className="text-[10px] text-neutral-500 ml-auto">
                    {conversation.filter(t => t.role === "user").length} turn{conversation.filter(t => t.role === "user").length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              {(
                <div className="mt-1.5 space-y-1.5">
                  {/* Max history + clear */}
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-neutral-500 shrink-0">Max turns</label>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={nodeData.maxHistoryTurns ?? 0}
                      onChange={handleMaxHistoryChange}
                      title="Most-recent N user+assistant pairs to send each request. 0 = unlimited."
                      className="nodrag nopan w-14 text-[11px] py-0.5 px-1 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white tabular-nums"
                    />
                    <button
                      onClick={handleClearConversation}
                      disabled={conversation.length === 0}
                      className="nodrag nopan ml-auto text-[10px] py-0.5 px-2 rounded bg-neutral-800 hover:bg-red-900/60 text-neutral-400 hover:text-white disabled:opacity-40 disabled:hover:bg-neutral-800 disabled:hover:text-neutral-400 transition-colors"
                    >
                      Clear history
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </InlineParameterPanel>
      ) : undefined}
    >
      {dynamicPinsOn ? (
        <DynamicInputHandles nodeId={id} />
      ) : (
        <>
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
        </>
      )}
      {/* Video input — Gemini models only (the route rejects other providers
          with a clear error). Rendered in BOTH pin modes (like image-feedback)
          so a video edge can never point at an unrendered handle. */}
      <Handle
        type="target"
        position={Position.Left}
        id="video"
        style={{ top: "85%" }}
        data-handletype="video"
        className="!bg-violet-500 !border-violet-700"
        title="Video input — analyzed by Gemini models (not supported by OpenAI/Claude)"
      />
      {/* Conversation / text output */}
      <Handle
        type="source"
        position={Position.Right}
        id="text"
        data-handletype="text"
      />

      <div className="relative w-full h-full min-h-0 overflow-hidden rounded-lg">
        <LLMChatPanel
          conversation={conversation}
          status={nodeData.status}
          error={nodeData.error}
          composeInput={nodeData.composeInput ?? ""}
          onComposeChange={(v) => updateNodeData(id, { composeInput: v })}
          onSend={handleRegenerate}
          onRemoveTurn={handleRemoveTurn}
          canRun={canRun}
          blockedReason={blockedReason}
          isExecuting={isExecuting}
        />
      </div>

    </BaseNode>
  );
}

// ─────────────────────────────────────────────────────────────────
