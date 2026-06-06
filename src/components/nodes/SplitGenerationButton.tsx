"use client";

import { useCallback, useState } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { splitGeneration } from "@/utils/splitGeneration";

/**
 * On-node "Split Generation" button. For a generation node with a carousel
 * history, spawns one populated input node per past generation.
 *
 * Renders nothing unless there is at least one generation AND a generations
 * directory is configured (the media is loaded from disk by id). Pass
 * `className` to control positioning — defaults to a top-left overlay pill.
 */
export function SplitGenerationButton({
  id,
  count,
  className,
}: {
  id: string;
  count: number;
  className?: string;
}) {
  const addNode = useWorkflowStore((s) => s.addNode);
  const generationsPath = useWorkflowStore((s) => s.generationsPath);
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (busy) return;
      const node = useWorkflowStore.getState().nodes.find((n) => n.id === id);
      if (!node) return;
      setBusy(true);
      try {
        await splitGeneration(
          { id: node.id, type: node.type, position: node.position, data: node.data as Record<string, unknown> },
          { generationsPath, addNode },
        );
      } finally {
        setBusy(false);
      }
    },
    [id, busy, generationsPath, addNode],
  );

  if (count < 1 || !generationsPath) return null;

  return (
    <button
      onClick={handle}
      onMouseDown={(e) => e.stopPropagation()}
      disabled={busy}
      title={`Split ${count} generation${count === 1 ? "" : "s"} into separate input nodes`}
      className={`nodrag nopan z-10 h-5 px-1.5 flex items-center gap-1 rounded bg-neutral-900/80 hover:bg-sky-600/90 text-white text-[10px] font-medium transition-colors disabled:opacity-60 ${className ?? "absolute top-1 left-1"}`}
    >
      <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M5 3v10M5 8l7-4M5 8l7 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {busy ? "…" : `Split ${count}`}
    </button>
  );
}
