"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { loadMediaById } from "@/utils/mediaStorage";
import { LOD_DISPLAY_FIELD } from "@/utils/imageFieldMap";
import type { NodeType } from "@/types";

/**
 * Zoom LOD: keep node previews sharp when the canvas is zoomed in.
 *
 * Each plain-<img> preview shows a 384px thumbnail by default. When a node is
 * zoomed in far enough that the thumb would be upscaled (and the node is on
 * screen), this loads that node's full-res from its file ref so the preview is
 * crisp; when zoomed back out (or panned off screen) it releases the full-res
 * back to the thumb to keep memory bounded.
 *
 * Renders null and reads nodes via getState() inside a debounced effect, so it
 * never re-renders the canvas — only itself, on viewport change.
 *
 * Safety: only ever swaps fields that have a file ref (so the release is always
 * recoverable) — never touches freshly-run / unsaved full-res (whose ref is
 * cleared), and uses a silent store write so panning/zooming never marks the
 * workflow dirty.
 */

// Longest-side thumb dimension (see createImageThumbnail). Load full-res once a
// node's on-screen CSS size exceeds this by a margin — i.e. the user has clearly
// zoomed in to inspect (~1.8x for a 300px node). Deliberately ignores
// devicePixelRatio so retina displays don't eagerly load full-res at base zoom;
// a preview can be mildly soft until you actually zoom in.
const THUMB_DIM = 384;
const MARGIN = 1.4;

export function ZoomLodController() {
  // Subscribe to the viewport transform + pane size. Re-renders this (null)
  // component on pan/zoom; the heavy work is debounced below.
  const transform = useStore((s) => s.transform);
  const paneWidth = useStore((s) => s.width);
  const paneHeight = useStore((s) => s.height);
  const loadingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const [tx, ty, zoom] = transform;

    const timer = setTimeout(() => {
      const { nodes, saveDirectoryPath, setNodeFullResField } = useWorkflowStore.getState();
      if (!saveDirectoryPath) return;

      for (const node of nodes) {
        const lod = LOD_DISPLAY_FIELD[node.type as NodeType];
        if (!lod) continue;

        const data = node.data as Record<string, unknown>;
        const ref = data[lod.ref] as string | undefined;
        if (!ref) continue; // no recoverable source → leave alone (protects unsaved full-res)
        const raw = data[lod.raw] as string | null | undefined;

        const nw = (node.measured?.width ?? (node.width as number | undefined) ?? 300);
        const nh = (node.measured?.height ?? (node.height as number | undefined) ?? 200);

        // On-screen rect (device px) for the in-view test.
        const left = node.position.x * zoom + tx;
        const top = node.position.y * zoom + ty;
        const right = left + nw * zoom;
        const bottom = top + nh * zoom;
        const inView = right > 0 && left < paneWidth && bottom > 0 && top < paneHeight;

        // On-screen CSS px across the node — thumb looks soft above THUMB_DIM.
        const onScreenPx = nw * zoom;
        const wantHiRes = inView && onScreenPx > THUMB_DIM * MARGIN;

        if (wantHiRes && !raw) {
          if (loadingRef.current.has(node.id)) continue;
          loadingRef.current.add(node.id);
          loadMediaById(ref, saveDirectoryPath, lod.folder)
            .then((url) => {
              // Re-check it's still wanted and still empty before committing.
              const fresh = useWorkflowStore.getState().nodes.find((n) => n.id === node.id);
              const cur = (fresh?.data as Record<string, unknown> | undefined)?.[lod.raw];
              if (url && !cur) setNodeFullResField(node.id, lod.raw, url);
            })
            .finally(() => loadingRef.current.delete(node.id));
        } else if (!wantHiRes && raw) {
          setNodeFullResField(node.id, lod.raw, null);
        }
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [transform, paneWidth, paneHeight]);

  return null;
}
