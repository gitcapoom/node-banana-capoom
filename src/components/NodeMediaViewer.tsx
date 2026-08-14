"use client";

import { useEffect } from "react";
import { MediaOverlay } from "./MediaOverlay";
import { useWorkflowStore } from "@/store/workflowStore";
import { useNodeMediaViewer } from "@/store/nodeMediaViewerStore";
import { useFullResField } from "@/hooks/useFullResField";

const noop = () => {};

/**
 * Single host for the canvas-wide media viewer (see nodeMediaViewerStore).
 *
 * Mounted once next to the canvas. It reads the target node's field live, so a
 * preview opened on its thumbnail upgrades to full resolution as soon as the
 * on-demand load lands — and nothing at all is mounted while it's closed.
 */
export function NodeMediaViewer() {
  const target = useNodeMediaViewer((s) => s.target);
  const close = useNodeMediaViewer((s) => s.close);
  const { ensure, loading } = useFullResField();

  const content = useWorkflowStore((s) => {
    if (!target) return null;
    const node = s.nodes.find((n) => n.id === target.nodeId);
    if (!node) return null;
    const data = node.data as Record<string, unknown>;
    // Full-res if it's loaded, else the inline thumb so the overlay opens
    // instantly rather than waiting on disk.
    return (data[target.field] as string | null) ?? (data[`${target.field}Thumb`] as string | null) ?? null;
  });

  const refValue = useWorkflowStore((s) => {
    if (!target) return undefined;
    const node = s.nodes.find((n) => n.id === target.nodeId);
    const data = node?.data as Record<string, unknown> | undefined;
    return data?.[`${target.field}Ref`] as string | undefined;
  });

  const rawValue = useWorkflowStore((s) => {
    if (!target) return null;
    const node = s.nodes.find((n) => n.id === target.nodeId);
    const data = node?.data as Record<string, unknown> | undefined;
    return (data?.[target.field] as string | null) ?? null;
  });

  // Pull the full-res in behind the (already visible) thumbnail.
  useEffect(() => {
    if (!target) return;
    void ensure({
      id: target.nodeId,
      field: target.field,
      ref: refValue,
      current: rawValue,
      folder: target.folder,
    });
    // `ensure` no-ops when full-res is already present.
  }, [target, refValue, rawValue, ensure]);

  // The node may vanish (deleted while open) — don't strand the overlay.
  useEffect(() => {
    if (target && content === null && !loading) close();
  }, [target, content, loading, close]);

  if (!target || !content) return null;

  return (
    <MediaOverlay
      content={content}
      mediaType={target.mediaType}
      currentIndex={0}
      totalCount={1}
      isLoading={loading}
      onPrevious={noop}
      onNext={noop}
      onClose={close}
    />
  );
}
