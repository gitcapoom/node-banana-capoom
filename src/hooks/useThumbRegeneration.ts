"use client";

import { useEffect, useRef } from "react";
import { useSyncExternalStore } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { loadMediaById } from "@/utils/mediaStorage";
import { createImageThumbnailWithMeta, thumbMaxDim } from "@/utils/createImageThumbnail";
import { THUMB_DISPLAY_FIELDS } from "@/utils/imageFieldMap";
import {
  getThumbnailGeneration,
  markAllThumbnailsPending,
  markThumbnailRendered,
  subscribeThumbnailSize,
} from "@/lib/thumbnailSize";
import type { NodeType } from "@/types";

/**
 * Re-render every node thumbnail after the thumbnail-resolution setting changes.
 *
 * Without this the setting only affects thumbs written from then on, so nothing
 * visibly happens until each node next re-saves — which reads as the control
 * being broken. Each node is re-rendered from its full-res source (in memory if
 * loaded, otherwise from its file ref) and marked done, so the previews report
 * "rendering" only while there is genuinely work outstanding.
 *
 * Sequential on purpose: this decodes and re-encodes every image on the canvas,
 * and doing that in parallel would lock the UI for exactly the audience most
 * likely to change the setting (large graphs).
 */
export function useThumbRegeneration() {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const saveDirectoryPath = useWorkflowStore((s) => s.saveDirectoryPath);
  const runningRef = useRef(false);

  const generation = useSyncExternalStore(
    subscribeThumbnailSize,
    getThumbnailGeneration,
    () => 0,
  );

  useEffect(() => {
    // generation 0 is the initial load — nothing has changed yet.
    if (generation === 0 || runningRef.current) return;

    const nodes = useWorkflowStore.getState().nodes;
    const work: Array<{ nodeId: string; field: string; thumbKey: string; ref?: string; raw?: string; folder: "inputs" | "generations"; format: "jpeg" | "png" }> = [];

    for (const node of nodes) {
      const fields = THUMB_DISPLAY_FIELDS[node.type as NodeType];
      if (!fields) continue;
      const data = node.data as Record<string, unknown>;
      for (const f of fields) {
        const raw = data[f.raw] as string | undefined;
        const ref = data[f.ref] as string | undefined;
        const thumb = data[f.thumb] as string | undefined;
        // Only nodes that actually show a thumbnail today have anything to redo.
        if (!thumb && !raw) continue;
        work.push({
          nodeId: node.id, field: f.raw, thumbKey: f.thumb,
          ref, raw, folder: f.folder, format: f.format ?? "jpeg",
        });
      }
    }

    if (work.length === 0) return;
    markAllThumbnailsPending(work.map((w) => w.nodeId));

    runningRef.current = true;
    void (async () => {
      const size = thumbMaxDim();
      for (const w of work) {
        try {
          const source =
            w.raw ??
            (w.ref && saveDirectoryPath
              ? await loadMediaById(w.ref, saveDirectoryPath, w.folder)
              : null);
          if (source) {
            const meta = await createImageThumbnailWithMeta(source, size, 0.72, w.format);
            updateNodeData(w.nodeId, {
              [w.thumbKey]: meta.thumb,
              [`${w.field}Dims`]: { width: meta.width, height: meta.height },
            });
          }
        } catch {
          /* leave the old thumb in place — better than a blank preview */
        } finally {
          markThumbnailRendered(w.nodeId);
        }
      }
      runningRef.current = false;
    })();
  }, [generation, saveDirectoryPath, updateNodeData]);
}
