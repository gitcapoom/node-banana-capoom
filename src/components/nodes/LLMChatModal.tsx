"use client";

import { useCallback, useEffect } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useCanRun } from "@/hooks/useCanRun";
import type { LLMGenerateNodeData } from "@/types";
import { LLMChatPanel } from "./LLMChatPanel";
import { useEditorFontSize, EDITOR_FONT_SIZES } from "@/hooks/useEditorFontSize";

interface LLMChatModalProps {
  nodeId: string;
  onClose: () => void;
}

/**
 * The LLM node's chat, full screen.
 *
 * Replies run long and the node body is a few hundred pixels tall, so reading
 * one meant scrolling a thumbnail-sized box. This is the same conversation and
 * the same controls, with room to read.
 *
 * It renders LLMChatPanel — the very component the node renders — so the two
 * views cannot drift apart. Nothing about the conversation lives here; the node
 * data is the single source of truth, and edits made in the modal are the same
 * store writes the node makes.
 */
export function LLMChatModal({ nodeId, onClose }: LLMChatModalProps) {
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === nodeId));
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const regenerateNode = useWorkflowStore((s) => s.regenerateNode);
  const { canRun, blockedReason, isExecuting } = useCanRun(nodeId);
  const [fontSize, setFontSize] = useEditorFontSize("llm-chat-font-size");

  // Escape closes, matching every other modal on the canvas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleRemoveTurn = useCallback(
    (index: number) => {
      const data = node?.data as LLMGenerateNodeData | undefined;
      const conversation = data?.conversation ?? [];
      updateNodeData(nodeId, {
        conversation: conversation.filter((_, i) => i !== index),
      });
    },
    [node, nodeId, updateNodeData],
  );

  // The node can be deleted while its modal is open.
  if (!node) return null;
  const data = node.data as LLMGenerateNodeData;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl h-[80vh] bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-neutral-800">
          <span className="text-sm font-medium text-neutral-200">
            {data.customTitle || "LLM Generate"}
          </span>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
              Size
              <select
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
                title="Text size in this window"
                className="bg-neutral-800 border border-neutral-700 rounded px-1 py-0.5 text-neutral-200 text-[11px] focus:outline-none focus:ring-1 focus:ring-indigo-600"
              >
                {EDITOR_FONT_SIZES.map((s) => (
                  <option key={s} value={s}>{s}px</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-neutral-400 cursor-pointer">
              <input
                type="checkbox"
                checked={data.rememberTurns === true}
                onChange={(e) => updateNodeData(nodeId, { rememberTurns: e.target.checked })}
                className="accent-indigo-600"
              />
              Remember previous turns
            </label>
            <button
              onClick={onClose}
              title="Close"
              className="w-6 h-6 rounded flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0">
          <LLMChatPanel
            conversation={data.conversation ?? []}
            status={data.status}
            error={data.error}
            composeInput={data.composeInput ?? ""}
            onComposeChange={(v) => updateNodeData(nodeId, { composeInput: v })}
            onSend={() => regenerateNode(nodeId)}
            onRemoveTurn={handleRemoveTurn}
            canRun={canRun}
            blockedReason={blockedReason}
            isExecuting={isExecuting}
            size="modal"
            fontSize={fontSize}
          />
        </div>
      </div>
    </div>
  );
}
