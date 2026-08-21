"use client";

import React from "react";
import type { ConversationTurn } from "@/types";
import type { NodeStatus } from "@/types";

// Conversation transcript view
// ─────────────────────────────────────────────────────────────────

interface ConversationTranscriptProps {
  conversation: ConversationTurn[];
  status: NodeStatus;
  error: string | null;
  onRemoveTurn: (index: number) => void;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
}

export function ConversationTranscript({
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
          <span className="text-neutral-400 text-[11px]">No messages yet</span>
          <span className="text-neutral-600 text-[10px]">
            Type below and press Send — or wire a text input and Run.
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

      {isError && (
        <div className="absolute bottom-1 left-1 right-1 bg-red-900/80 text-red-100 text-[10px] px-2 py-1 rounded shadow-lg">
          {error || "Generation failed"}
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
  // After a save the transcript keeps refs + thumbs instead of inline full-res
  // images (see imageStorage), so prefer whichever is present.
  const turnPreviews = (turn.images?.length ? turn.images : turn.imageThumbs ?? []).filter(Boolean);
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
        {turnPreviews.length > 0 && (
          <div className="flex gap-1 mb-0.5">
            {turnPreviews.slice(0, 3).map((img, i) => (
              <img
                key={i}
                src={img}
                alt=""
                className="w-8 h-8 object-cover rounded border border-neutral-700"
              />
            ))}
            {turnPreviews.length > 3 && (
              <span className="text-[9px] text-neutral-500 self-end">
                +{turnPreviews.length - 3}
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

/**
 * The chat body of an LLM node: transcript, compose box, Send.
 *
 * Extracted so the node and the expanded modal render the SAME component
 * rather than two copies of the same JSX. Two copies of one thing is exactly
 * how the comp-signature bug happened: they drift, and the drift is invisible
 * until behaviour diverges.
 *
 * Purely presentational — every piece of state and every action is passed in,
 * so the modal and the node can own their own wiring.
 */
export interface LLMChatPanelProps {
  conversation: ConversationTurn[];
  status: NodeStatus;
  error: string | null;
  composeInput: string;
  onComposeChange: (value: string) => void;
  onSend: () => void;
  onRemoveTurn: (index: number) => void;
  canRun: boolean;
  blockedReason?: string;
  isExecuting: boolean;
  /** Bigger type and a roomier compose box in the expanded modal. */
  size?: "node" | "modal";
}

export function LLMChatPanel({
  conversation,
  status,
  error,
  composeInput,
  onComposeChange,
  onSend,
  onRemoveTurn,
  canRun,
  blockedReason,
  isExecuting,
  size = "node",
}: LLMChatPanelProps) {
  const transcriptRef = React.useRef<HTMLDivElement>(null);
  const big = size === "modal";

  // Follow new turns to the bottom.
  React.useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation.length, status]);

  return (
    <div className="w-full h-full flex flex-col min-h-0">
      <div className="flex-1 min-h-0">
        <ConversationTranscript
          conversation={conversation}
          status={status}
          error={error}
          onRemoveTurn={onRemoveTurn}
          transcriptRef={transcriptRef}
        />
      </div>
      <div className={`shrink-0 border-t border-neutral-800 bg-neutral-900/70 ${big ? "px-4 py-3 space-y-2" : "px-2 py-1.5 space-y-1.5"}`}>
        <textarea
          value={composeInput}
          onChange={(e) => onComposeChange(e.target.value)}
          placeholder="Type a message… (clears after sending)"
          rows={big ? 4 : 2}
          className={`nodrag nopan nowheel select-text cursor-text w-full resize-none text-neutral-200 bg-neutral-950/50 rounded focus:outline-none focus:ring-1 focus:ring-indigo-600/60 placeholder:text-neutral-600 ${big ? "text-sm px-3 py-2" : "text-[10px] px-1.5 py-1"}`}
        />
        <button
          onClick={onSend}
          disabled={!canRun}
          title={blockedReason || "Send"}
          className={`nodrag nopan w-full rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors flex items-center justify-center gap-1 ${big ? "text-sm py-2" : "text-[10px] py-1"}`}
        >
          <svg className={big ? "w-3.5 h-3.5" : "w-2.5 h-2.5"} fill="currentColor" viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z" /></svg>
          {isExecuting ? "Running…" : "Send"}
        </button>
      </div>
    </div>
  );
}
