"use client";

import { useCallback } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import type { LLMGenerateNodeData } from "@/types";

/** Prompt nodes are created at this size (defaultNodeDimensions.prompt). */
const PROMPT_W = 320;
const PROMPT_H = 220;
/** Breathing room so boxes are clear of each other, not merely not-overlapping. */
const GAP = 24;

/**
 * The generator-ready controls: the two checkboxes, the character budget, the
 * warning badge, and the two prompt-node buttons.
 *
 * Rendered by BOTH the node's inline panel and the side ControlPanel. The
 * inline panel is behind a global toggle, so controls that live only there are
 * invisible to anyone who has it switched off — which is exactly how these went
 * missing the first time. One component, two hosts, no second copy to drift.
 *
 * Self-contained by nodeId: it reads and writes the store itself, so a host
 * only has to place it.
 */
export function LLMGeneratorControls({ nodeId, compact = false }: { nodeId: string; compact?: boolean }) {
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === nodeId));
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const addNode = useWorkflowStore((s) => s.addNode);
  const getNodeById = useWorkflowStore((s) => s.getNodeById);

  const data = node?.data as LLMGenerateNodeData | undefined;

  // What the buttons write. With generator-friendly off there is no derived
  // prompt, so the raw reply is the only sensible payload.
  const promptText = data?.generatorFriendly ? data?.derivedPrompt ?? "" : data?.outputText ?? "";
  const negativeText = data?.derivedNegativePrompt ?? "";
  const wantNegativeNode = data?.generatorFriendly === true && data?.generateNegativePrompt === true;

  /** A tracked id is usable only while it still points at a live prompt node —
   *  the user can delete it, and ids outlive workflow swaps. */
  const liveTarget = useCallback(
    (targetId: string | null | undefined): boolean => {
      if (!targetId) return false;
      const n = getNodeById(targetId);
      return !!n && n.type === "prompt";
    },
    [getNodeById],
  );

  const canUpdate =
    liveTarget(data?.promptNodeId) || (wantNegativeNode && liveTarget(data?.negativePromptNodeId));

  const handleSend = useCallback(() => {
    const self = getNodeById(nodeId);
    if (!self) return;

    const all = useWorkflowStore.getState().nodes;
    const x = self.position.x + (self.width ?? 320) + 40;

    /**
     * First vertical slot at `x` whose 320x220 box touches nothing.
     *
     * Offsetting each new node by a fixed amount was not enough: a prompt node
     * is 220px tall, so a 30px step buried each one under the last, and the
     * negative landed on the next positive. This walks down until the box is
     * genuinely clear, so nothing ever covers anything — including nodes this
     * LLM node did not create.
     */
    const freeSlot = (startY: number, taken: Array<{ x: number; y: number }>): number => {
      let y = startY;
      for (let guard = 0; guard < 200; guard++) {
        const clash =
          all.some((n) => {
            const nw = n.width ?? 320;
            const nh = n.height ?? 220;
            return (
              n.position.x < x + PROMPT_W + GAP &&
              n.position.x + nw + GAP > x &&
              n.position.y < y + PROMPT_H + GAP &&
              n.position.y + nh + GAP > y
            );
          }) || taken.some((t) => Math.abs(t.x - x) < PROMPT_W + GAP && Math.abs(t.y - y) < PROMPT_H + GAP);
        if (!clash) return y;
        y += PROMPT_H + GAP;
      }
      return y;
    };

    // Nodes created in this same press are not in the store yet, so they are
    // tracked here to stop the negative landing on the positive.
    const placed: Array<{ x: number; y: number }> = [];

    const seq = (data?.promptNodeSeq ?? 0) + 1;
    const kind = data?.generatorFriendly ? "positive prompt" : "positive raw prompt";

    const py = freeSlot(self.position.y, placed);
    placed.push({ x, y: py });
    const updates: Partial<LLMGenerateNodeData> = {
      promptNodeSeq: seq,
      promptNodeId: addNode(
        "prompt",
        { x, y: py },
        { prompt: promptText, customTitle: `${kind}_${seq}` } as Partial<LLMGenerateNodeData>,
      ),
    };

    if (wantNegativeNode) {
      const ny = freeSlot(py + PROMPT_H + GAP, placed);
      placed.push({ x, y: ny });
      updates.negativePromptNodeId = addNode(
        "prompt",
        { x, y: ny },
        { prompt: negativeText, customTitle: `negative prompt_${seq}` } as Partial<LLMGenerateNodeData>,
      );
    }
    updateNodeData(nodeId, updates);
  }, [nodeId, addNode, getNodeById, data?.promptNodeSeq, data?.generatorFriendly, promptText, negativeText, wantNegativeNode, updateNodeData]);

  const handleUpdate = useCallback(() => {
    if (liveTarget(data?.promptNodeId)) {
      updateNodeData(data!.promptNodeId!, { prompt: promptText });
    }
    // A missing negative must never blank a node already wired to a generator.
    if (wantNegativeNode && liveTarget(data?.negativePromptNodeId) && negativeText) {
      updateNodeData(data!.negativePromptNodeId!, { prompt: negativeText });
    }
  }, [liveTarget, data, promptText, negativeText, wantNegativeNode, updateNodeData]);

  if (!data) return null;

  const label = compact ? "text-[11px]" : "text-xs";
  const small = compact ? "text-[10px]" : "text-[11px]";
  const field = compact
    ? "w-16 text-[11px] py-0.5 px-1 bg-[#1a1a1a] rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white tabular-nums"
    : "w-16 text-xs py-0.5 px-1 bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500 tabular-nums";
  const button = compact
    ? "flex-1 text-[10px] py-1 rounded bg-neutral-800 hover:bg-emerald-800 text-neutral-300 hover:text-white disabled:opacity-40 disabled:hover:bg-neutral-800 transition-colors"
    : "flex-1 text-[11px] py-1 rounded bg-neutral-700 hover:bg-emerald-700 text-neutral-300 hover:text-white disabled:opacity-40 disabled:hover:bg-neutral-700 transition-colors";

  return (
    <div className="space-y-1.5">
      <label className={`nodrag nopan flex items-center gap-1.5 ${label} text-neutral-300 cursor-pointer`}>
        <input
          type="checkbox"
          checked={data.generatorFriendly === true}
          onChange={(e) => updateNodeData(nodeId, { generatorFriendly: e.target.checked })}
          className="nodrag accent-emerald-600"
        />
        Generator friendly
      </label>

      {data.generatorFriendly === true && (
        <>
          <label className={`nodrag nopan flex items-center gap-1.5 ${label} text-neutral-300 cursor-pointer pl-4`}>
            <input
              type="checkbox"
              checked={data.generateNegativePrompt === true}
              onChange={(e) => updateNodeData(nodeId, { generateNegativePrompt: e.target.checked })}
              className="nodrag accent-emerald-600"
            />
            Generate negative prompt
          </label>
          <div className="flex items-center gap-2 pl-4">
            <label className={`${small} text-neutral-500 shrink-0`}>Max characters</label>
            <input
              type="number"
              min={0}
              step={50}
              value={data.maxPromptChars ?? 0}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                updateNodeData(nodeId, { maxPromptChars: isNaN(n) || n <= 0 ? null : n });
              }}
              title="Shrink the generated prompt to fit. 0 = no limit."
              className={`nodrag nopan ${field}`}
            />
          </div>
        </>
      )}

      <div className="flex gap-1.5 pt-0.5">
        <button
          onClick={handleSend}
          disabled={!promptText}
          title={promptText ? "Create a new prompt node holding this reply" : "Nothing to send yet — run the node first"}
          className={`nodrag nopan ${button}`}
        >
          Send to prompt node
        </button>
        <button
          onClick={handleUpdate}
          disabled={!promptText || !canUpdate}
          title={canUpdate ? "Overwrite the prompt node this one created" : "No prompt node yet — press Send to prompt node first"}
          className={`nodrag nopan ${button}`}
        >
          Update prompt node
        </button>
      </div>

      {data.derivedWarning && (
        <div className={`${small} text-amber-400/90 bg-amber-900/25 border border-amber-800/40 rounded px-1.5 py-1 leading-tight`}>
          ⚠ {data.derivedWarning}
        </div>
      )}
    </div>
  );
}
