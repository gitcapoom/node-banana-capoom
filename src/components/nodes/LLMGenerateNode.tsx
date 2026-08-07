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
import { LOOPBACK_SKILL, LOOPBACK_SKILL_NAME } from "@/store/execution/loopbackSkill";
import { PromptSkillPicker } from "./PromptSkillPicker";

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

  // Loopback: a single "Send" action (= handleRegenerate). It shows the model
  // the latest render (if any) + references, folds in the compose-box direction,
  // assesses the render when there is one, and returns a refined prompt. It does
  // NOT generate — the user runs the generator node directly.

  // Loopback wiring status — the assess step only works when the image
  // generator's output is fed back into the fuchsia feedback input, and the
  // Loop's auto-regenerate only works when the emerald prompt output drives an
  // image node. Surface a hint when either is missing (explains "no assess loop").
  const feedbackConnected = useWorkflowStore((state) =>
    state.edges.some((e) => e.target === id && e.targetHandle === "image-feedback")
  );
  const promptConnected = useWorkflowStore((state) =>
    state.edges.some((e) => e.source === id && e.sourceHandle === "prompt")
  );

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
  const conversationMode = nodeData.conversationMode === true;
  const loopbackMode = nodeData.loopbackMode === true;
  // 3-way mode derived from the two booleans (loopback implies conversation).
  const chatMode: "off" | "conversation" | "loopback" =
    loopbackMode ? "loopback" : conversationMode ? "conversation" : "off";

  const handleSetMode = useCallback(
    (mode: "off" | "conversation" | "loopback") => {
      if (mode === "loopback") {
        // Loopback relies on the built-in skill's two-output protocol, so
        // auto-apply it as the (editable) system prompt. Also ensure a generous
        // output cap — the assessment + <image_prompt> block truncates at low
        // limits (and maxTokens is a ceiling, not a cost, so raising it is free
        // for normal replies). Never lowers a higher value the user chose.
        updateNodeData(id, {
          conversationMode: true,
          loopbackMode: true,
          systemPrompt: LOOPBACK_SKILL,
          promptSkillName: LOOPBACK_SKILL_NAME,
          maxTokens: Math.max(nodeData.maxTokens ?? 0, 16384),
        });
      } else if (mode === "conversation") {
        updateNodeData(id, { conversationMode: true, loopbackMode: false });
      } else {
        updateNodeData(id, { conversationMode: false, loopbackMode: false });
      }
    },
    [id, updateNodeData, nodeData.maxTokens]
  );

  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const handleCopyPrompt = useCallback(async () => {
    if (!nodeData.outputPrompt) return;
    try {
      await navigator.clipboard.writeText(nodeData.outputPrompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 1500);
    } catch (err) {
      console.error("Failed to copy prompt:", err);
    }
  }, [nodeData.outputPrompt]);

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
                <span className="text-[11px] text-neutral-300 shrink-0">Mode</span>
                <div className="nodrag nopan flex rounded-md overflow-hidden border border-neutral-700">
                  {([["off", "One-shot"], ["conversation", "Chat"], ["loopback", "Loopback"]] as const).map(([m, label]) => (
                    <button
                      key={m}
                      onClick={() => handleSetMode(m)}
                      title={m === "loopback" ? "Conversation + image feedback loop (2 outputs: chat + clean prompt)" : undefined}
                      className={`text-[10px] px-2 py-0.5 transition-colors ${chatMode === m ? "bg-indigo-600 text-white" : "bg-neutral-800 text-neutral-400 hover:text-white"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {conversationMode && conversation.length > 0 && (
                  <span className="text-[10px] text-neutral-500 ml-auto">
                    {conversation.filter(t => t.role === "user").length} turn{conversation.filter(t => t.role === "user").length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              {conversationMode && (
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
      {/* Feedback image input (loopback only) — the previous generation = Image 1 */}
      {loopbackMode && (
        <Handle
          type="target"
          position={Position.Left}
          id="image-feedback"
          style={{ top: "15%" }}
          data-handletype="image"
          className="!bg-fuchsia-500 !border-fuchsia-700"
          title="Feedback image — the previous generation (Image 1)"
        />
      )}
      {/* Conversation / text output */}
      <Handle
        type="source"
        position={Position.Right}
        id="text"
        data-handletype="text"
        style={loopbackMode ? { top: "35%" } : undefined}
        title={loopbackMode ? "Conversation text" : undefined}
      />
      {/* Clean image-prompt output (loopback only) → image node */}
      {loopbackMode && (
        <Handle
          type="source"
          position={Position.Right}
          id="prompt"
          data-handletype="text"
          style={{ top: "65%" }}
          className="!bg-emerald-500 !border-emerald-700"
          title="Clean image prompt → image generator"
        />
      )}
      {/* References passthrough output (loopback only): the ordered image list
          the LLM saw (feedback first, then references) → the image generator,
          in ONE edge. Keeps the prompt's "Image 1 / Image 2 / …" aligned with
          what the generator actually receives. */}
      {loopbackMode && (
        <Handle
          type="source"
          position={Position.Right}
          id="images"
          data-handletype="image"
          style={{ top: "15%" }}
          className="!bg-blue-500 !border-blue-700"
          title="References passthrough — the same ordered images the LLM saw (feedback first, then references) → wire to the image generator's image input"
        />
      )}
      {/* Loopback handle labels — make the loop wiring obvious at a glance.
          (Dynamic pins render their own input labels, so only add the
          input labels here in the static case to avoid duplicates.) */}
      {loopbackMode && (
        <>
          <div className="absolute text-[9px] font-semibold whitespace-nowrap pointer-events-none text-fuchsia-400" style={{ right: "calc(100% + 9px)", top: "15%", transform: "translateY(-50%)" }}>
            ⟳ Feedback
          </div>
          {!dynamicPinsOn && (
            <>
              <div className="absolute text-[9px] font-medium whitespace-nowrap pointer-events-none text-blue-400" style={{ right: "calc(100% + 9px)", top: "35%", transform: "translateY(-50%)" }}>
                References
              </div>
              <div className="absolute text-[9px] font-medium whitespace-nowrap pointer-events-none text-amber-400" style={{ right: "calc(100% + 9px)", top: "65%", transform: "translateY(-50%)" }}>
                Goal
              </div>
            </>
          )}
          <div className="absolute text-[9px] font-medium whitespace-nowrap pointer-events-none text-amber-400" style={{ left: "calc(100% + 9px)", top: "35%", transform: "translateY(-50%)" }}>
            Chat
          </div>
          <div className="absolute text-[9px] font-semibold whitespace-nowrap pointer-events-none text-emerald-400" style={{ left: "calc(100% + 9px)", top: "65%", transform: "translateY(-50%)" }}>
            Image prompt →
          </div>
          <div className="absolute text-[9px] font-medium whitespace-nowrap pointer-events-none text-blue-400" style={{ left: "calc(100% + 9px)", top: "15%", transform: "translateY(-50%)" }}>
            Images →
          </div>
        </>
      )}

      <div className="relative w-full h-full min-h-0 overflow-hidden rounded-lg">
        {conversationMode ? (
          // ─── Conversation transcript (loopback adds a standalone prompt panel) ───
          loopbackMode ? (
            <div className="w-full h-full flex flex-col min-h-0">
              {(!feedbackConnected || !promptConnected) && (
                <div className="shrink-0 px-2 py-1 bg-amber-900/40 border-b border-amber-800/50 text-[9px] text-amber-300/90 leading-tight">
                  {!feedbackConnected
                    ? "⟳ Wire the generator's output back into the fuchsia Feedback input (top-left) so Assess can see the latest image."
                    : "Wire the emerald Image prompt output into the generator so it uses the refined prompt (you run the generator yourself)."}
                </div>
              )}
              <div className="flex-1 min-h-0">
                <ConversationTranscript
                  conversation={conversation}
                  status={nodeData.status}
                  error={nodeData.error}
                  onRemoveTurn={handleRemoveTurn}
                  transcriptRef={transcriptRef}
                />
              </div>
              {/* Standalone image-prompt panel — editable; feeds the `prompt`
                  output to the generator. Edits persist until the next Assess /
                  Converse run overwrites the prompt. */}
              <div className="shrink-0 border-t border-neutral-800 bg-neutral-900/60 flex flex-col">
                <div className="flex items-center justify-between px-2 pt-1">
                  <span className="text-[9px] uppercase tracking-wide text-emerald-400/80">Image prompt (editable)</span>
                  <button
                    onClick={handleCopyPrompt}
                    disabled={!nodeData.outputPrompt}
                    className="nodrag nopan text-[9px] px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white disabled:opacity-40 transition-colors"
                    title="Copy prompt"
                  >
                    {copiedPrompt ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="px-2 pb-1.5">
                  <textarea
                    value={nodeData.outputPrompt ?? ""}
                    onChange={(e) => updateNodeData(id, { outputPrompt: e.target.value })}
                    placeholder="Send to generate the image prompt — or type / edit it here…"
                    rows={3}
                    className="nodrag nopan nowheel select-text cursor-text w-full resize-y min-h-[44px] max-h-[70vh] text-[10px] text-neutral-200 bg-neutral-950/50 rounded px-1.5 py-1 whitespace-pre-wrap break-words focus:outline-none focus:ring-1 focus:ring-emerald-700/60"
                  />
                </div>
              </div>
              {/* Chatbot compose box + a single Send action (handleRegenerate).
                  The box clears after each successful send so the previous
                  direction can't be silently re-sent. Send does NOT generate —
                  the user runs the generator node directly. */}
              <div className="shrink-0 border-t border-neutral-800 bg-neutral-900/70 px-2 py-1.5 space-y-1.5">
                <textarea
                  value={nodeData.composeInput ?? ""}
                  onChange={(e) => updateNodeData(id, { composeInput: e.target.value })}
                  placeholder="Type a direction for the next Assess / Converse… (clears after sending)"
                  rows={2}
                  className="nodrag nopan nowheel select-text cursor-text w-full resize-none text-[10px] text-neutral-200 bg-neutral-950/50 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-600/60 placeholder:text-neutral-600"
                />
                <button
                  onClick={handleRegenerate}
                  disabled={!canRun}
                  title={blockedReason || "Send — assess the latest generated image (if any) against the goal + references, fold in your direction, and refine the prompt. Does not generate — run the generator node yourself."}
                  className="nodrag nopan w-full text-[10px] py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors flex items-center justify-center gap-1"
                >
                  <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z" /></svg>
                  {isExecuting ? "Running…" : "Send"}
                </button>
              </div>
            </div>
          ) : (
            <ConversationTranscript
              conversation={conversation}
              status={nodeData.status}
              error={nodeData.error}
              onRemoveTurn={handleRemoveTurn}
              transcriptRef={transcriptRef}
            />
          )
        ) : nodeData.status === "loading" ? (
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
          <div className="group/text relative w-full h-full bg-neutral-900/40 p-2 overflow-auto nowheel nodrag nopan select-text cursor-text">
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
                disabled={!canRun}
                className="nodrag nopan w-5 h-5 bg-neutral-900/80 hover:bg-blue-600/80 disabled:opacity-50 disabled:cursor-not-allowed rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title={blockedReason || "Regenerate"}
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

// ─────────────────────────────────────────────────────────────────
// Conversation transcript view
// ─────────────────────────────────────────────────────────────────

interface ConversationTranscriptProps {
  conversation: ConversationTurn[];
  status: LLMGenerateNodeData["status"];
  error: string | null;
  onRemoveTurn: (index: number) => void;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
}

function ConversationTranscript({
  conversation,
  status,
  error,
  onRemoveTurn,
  transcriptRef,
}: ConversationTranscriptProps) {
  const isLoading = status === "loading";
  const isError = status === "error";

  return (
    <div className="relative w-full h-full bg-neutral-900/40">
      {conversation.length === 0 && !isLoading ? (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1 px-3 text-center">
          <span className="text-neutral-400 text-[11px]">Conversation mode</span>
          <span className="text-neutral-600 text-[10px]">
            Connect text input and Run to start. Each Run sends the full transcript.
          </span>
        </div>
      ) : (
        <div
          ref={transcriptRef}
          className="w-full h-full overflow-auto nowheel nodrag nopan select-text cursor-text py-1 px-1.5 space-y-1"
        >
          {conversation.map((turn, i) => (
            <ConversationRow
              key={`${turn.timestamp ?? i}-${i}`}
              turn={turn}
              onRemove={() => onRemoveTurn(i)}
            />
          ))}
          {isLoading && (
            // Inline thinking indicator at the bottom while the assistant
            // turn is in flight.
            <div className="flex items-center gap-1 px-1 py-0.5">
              <span className="text-[9px] uppercase tracking-wide text-blue-400/80 w-3 shrink-0">A</span>
              <span className="text-neutral-500 text-[10px] italic">
                <span className="inline-block animate-pulse">…thinking</span>
              </span>
            </div>
          )}
        </div>
      )}

      {isError && error && (
        <div className="absolute bottom-1 left-1 right-1 bg-red-900/80 text-red-100 text-[10px] px-2 py-1 rounded shadow-lg">
          {error}
        </div>
      )}
    </div>
  );
}

interface ConversationRowProps {
  turn: ConversationTurn;
  onRemove: () => void;
}

function ConversationRow({ turn, onRemove }: ConversationRowProps) {
  const isUser = turn.role === "user";
  return (
    <div className="group/row flex items-start gap-1 px-1 py-0.5 rounded hover:bg-neutral-800/40 transition-colors">
      <span
        className={`text-[9px] uppercase tracking-wide w-3 shrink-0 mt-[1px] ${
          isUser ? "text-neutral-500" : "text-blue-400/80"
        }`}
        title={isUser ? "User" : "Assistant"}
      >
        {isUser ? "U" : "A"}
      </span>
      <div className="flex-1 min-w-0">
        {turn.images && turn.images.length > 0 && (
          <div className="flex gap-1 mb-0.5">
            {turn.images.slice(0, 3).map((img, i) => (
              <img
                key={i}
                src={img}
                alt=""
                className="w-8 h-8 object-cover rounded border border-neutral-700"
              />
            ))}
            {turn.images.length > 3 && (
              <span className="text-[9px] text-neutral-500 self-end">
                +{turn.images.length - 3}
              </span>
            )}
          </div>
        )}
        <p className="text-[10px] text-neutral-300 whitespace-pre-wrap break-words leading-[1.35]">
          {turn.text}
        </p>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="nodrag nopan w-3 h-3 mt-[1px] shrink-0 rounded text-neutral-600 opacity-0 group-hover/row:opacity-100 hover:text-red-400 transition-all flex items-center justify-center"
        title="Drop this turn"
      >
        <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
