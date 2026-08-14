"use client";

import { useEffect, useRef } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { loadMediaById } from "@/utils/mediaStorage";
import { createImageThumbnailWithMeta, thumbMaxDim } from "@/utils/createImageThumbnail";
import { THUMB_DISPLAY_FIELDS } from "@/utils/imageFieldMap";
import type { WorkflowNode, NodeType } from "@/types";

/**
 * One-time migration for workflows saved before inline thumbnails existed.
 *
 * For each displayed image field that has a file ref but NO inline thumb, load
 * the full-res from disk once, downscale to a thumb, and store ONLY the thumb
 * (never the full-res — keeps memory at the lazy baseline). The next save
 * persists the thumb inline, so subsequent opens are instant with no fetch.
 *
 * Runs at the canvas level (so no per-node wiring) and guards each (node,field)
 * so it fires at most once per session. Fire-and-forget / non-blocking — the UI
 * stays responsive while previews fill in progressively.
 */
export function useThumbBackfill(nodes: WorkflowNode[]) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const saveDirectoryPath = useWorkflowStore((s) => s.saveDirectoryPath);
  const doneRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!saveDirectoryPath) return;
    for (const node of nodes) {
      const fields = THUMB_DISPLAY_FIELDS[node.type as NodeType];
      if (!fields) continue;
      const data = node.data as Record<string, unknown>;
      for (const f of fields) {
        const raw = data[f.raw] as string | null | undefined;
        const ref = data[f.ref] as string | undefined;
        const thumb = data[f.thumb] as string | undefined;
        // Only backfill when: full-res not loaded, a ref exists, and no thumb yet.
        if (raw || !ref || thumb) continue;
        const key = `${node.id}:${f.thumb}`;
        if (doneRef.current.has(key)) continue;
        doneRef.current.add(key);
        void (async () => {
          try {
            const full = await loadMediaById(ref, saveDirectoryPath, f.folder);
            if (!full) return;
            const meta = await createImageThumbnailWithMeta(full, thumbMaxDim(), 0.72, f.format ?? "jpeg");
            const t = meta.thumb;
            // Store ONLY the thumb — do not retain the full-res in node data.
            updateNodeData(node.id, { [f.thumb]: t });
          } catch {
            /* leave un-backfilled; preview just stays blank until run/save */
          }
        })();
      }
    }
  }, [nodes, saveDirectoryPath, updateNodeData]);
}
