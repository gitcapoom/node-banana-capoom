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
  startThumbnailProgress,
  advanceThumbnailProgress,
  endThumbnailProgress,
} from "@/lib/thumbnailSize";
import { createImageThumbnail } from "@/utils/createImageThumbnail";
import type { NodeType } from "@/types";

/**
 * Re-encode an existing thumb at `size`, but only when it genuinely has the
 * pixels to spare. Returns null when the thumb is already at or below the
 * target (nothing to gain) or too small to be a faithful source — those cases
 * must go back to the full-res original.
 */
async function shrinkFromThumb(
  thumb: string,
  size: number,
  format: "jpeg" | "png",
): Promise<string | null> {
  try {
    const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error("decode failed"));
      img.src = thumb;
    });
    const longest = Math.max(dims.w, dims.h);
    // Needs to be meaningfully larger than the target, or re-encoding it just
    // costs quality for nothing.
    if (longest <= size * 1.05) return null;
    return await createImageThumbnail(thumb, size, 0.72, format);
  } catch {
    return null;
  }
}

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
  /** Generation the in-flight sweep belongs to; a newer one supersedes it. */
  const activeGenRef = useRef(0);

  const generation = useSyncExternalStore(
    subscribeThumbnailSize,
    getThumbnailGeneration,
    () => 0,
  );

  useEffect(() => {
    // generation 0 is the initial load — nothing has changed yet.
    if (generation === 0) return;
    // A change arriving mid-sweep SUPERSEDES the one in flight rather than
    // being dropped. Dropping it meant picking 512 and then 1024 while the
    // first sweep ran left you with 512 thumbnails and a control that looked
    // like it had ignored you.
    activeGenRef.current = generation;

    const nodes = useWorkflowStore.getState().nodes;
    const work: Array<{ nodeId: string; field: string; thumbKey: string; ref?: string; raw?: string; thumb?: string; folder: "inputs" | "generations"; format: "jpeg" | "png" }> = [];

    for (const node of nodes) {
      const data = node.data as Record<string, unknown>;

      // Video posters are node thumbnails too, but they are not in
      // THUMB_DISPLAY_FIELDS because they have no full-res companion field —
      // their source is a video, not an image. Without this they kept whatever
      // size they were captured at while every other preview changed.
      // Shrink-only by design: growing one means re-decoding the video and
      // re-capturing four frames, which is not what a settings change should
      // trigger.
      const poster = data.thumbnailImage;
      if (typeof poster === "string" && poster) {
        work.push({
          nodeId: node.id, field: "thumbnail", thumbKey: "thumbnailImage",
          thumb: poster, folder: "generations", format: "jpeg",
        });
      }

      const fields = THUMB_DISPLAY_FIELDS[node.type as NodeType];
      if (!fields) continue;
      for (const f of fields) {
        const raw = data[f.raw] as string | undefined;
        const ref = data[f.ref] as string | undefined;
        const thumb = data[f.thumb] as string | undefined;
        // Only nodes that actually show a thumbnail today have anything to redo.
        if (!thumb && !raw) continue;
        work.push({
          nodeId: node.id, field: f.raw, thumbKey: f.thumb,
          ref, raw, thumb, folder: f.folder, format: f.format ?? "jpeg",
        });
      }
    }

    if (work.length === 0) return;
    markAllThumbnailsPending(work.map((w) => w.nodeId));
    startThumbnailProgress(work.length);

    void (async () => {
      const size = thumbMaxDim();
      for (const w of work) {
        if (activeGenRef.current !== generation) return; // superseded — drop this sweep
        try {
          // GOING SMALLER: re-encode from the thumb we already have. It has
          // more than enough pixels, and this is the common case — hauling a
          // 24-55MB source back off disk for every node to make a smaller
          // preview turned a quick setting change into minutes of waiting.
          //
          // Deliberately does NOT write `<field>Dims`: those are the SOURCE
          // dimensions (they drive the resolution badge), and a thumb only
          // knows its own size.
          const fromThumb = w.thumb ? await shrinkFromThumb(w.thumb, size, w.format) : null;
          if (fromThumb) {
            updateNodeData(w.nodeId, { [w.thumbKey]: fromThumb });
            continue;
          }

          // GOING LARGER (or no usable thumb): the source is the only place
          // the missing detail exists.
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
          advanceThumbnailProgress();
          // Yield between items so the canvas stays responsive: this is a
          // decode + re-encode per image, and a tight loop over a large graph
          // would hold the main thread for the whole sweep.
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      if (activeGenRef.current === generation) endThumbnailProgress();
    })();
  }, [generation, saveDirectoryPath, updateNodeData]);
}
