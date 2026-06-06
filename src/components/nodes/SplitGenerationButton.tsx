"use client";

import { useCallback, useState } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { splitGeneration, splitCurrentGeneration } from "@/utils/splitGeneration";

/**
 * On-node "Split Generation" controls for a generation node with a carousel
 * history. Two actions:
 *   • Split current — one input node from the generation currently shown.
 *   • Split all N   — one input node per generation in the node's history.
 *
 * "Split current" appears whenever there is at least one generation (it can use
 * the inline output, so it works even unsaved). "Split all" appears only with
 * 2+ generations AND a generations directory configured (the other generations
 * are read from disk by id). Pass `className` to control the wrapper position —
 * defaults to a top-left overlay.
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
  const [busy, setBusy] = useState<null | "current" | "all">(null);

  const run = useCallback(
    async (mode: "current" | "all", e: React.MouseEvent) => {
      e.stopPropagation();
      if (busy) return;
      const node = useWorkflowStore.getState().nodes.find((n) => n.id === id);
      if (!node) return;
      const arg = { id: node.id, type: node.type, position: node.position, data: node.data as Record<string, unknown> };
      setBusy(mode);
      try {
        if (mode === "current") await splitCurrentGeneration(arg, { generationsPath, addNode });
        else await splitGeneration(arg, { generationsPath, addNode });
      } finally {
        setBusy(null);
      }
    },
    [id, busy, generationsPath, addNode],
  );

  if (count < 1) return null;
  const showAll = count >= 2 && !!generationsPath;

  const btn =
    "nodrag nopan h-5 px-1.5 flex items-center gap-1 rounded bg-neutral-900/80 hover:bg-sky-600/90 text-white text-[10px] font-medium transition-colors disabled:opacity-60";

  return (
    <div className={`z-10 flex gap-1 ${className ?? "absolute top-1 left-1"}`}>
      <button
        onClick={(e) => run("current", e)}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={!!busy}
        title="Split the current generation into an input node"
        className={btn}
      >
        <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M5 3v10M5 8l7-4M5 8l7 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {busy === "current" ? "…" : "Split current"}
      </button>
      {showAll && (
        <button
          onClick={(e) => run("all", e)}
          onMouseDown={(e) => e.stopPropagation()}
          disabled={!!busy}
          title={`Split all ${count} generations into separate input nodes`}
          className={btn}
        >
          {busy === "all" ? "…" : `Split all ${count}`}
        </button>
      )}
    </div>
  );
}
