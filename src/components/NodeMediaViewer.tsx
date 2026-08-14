"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
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
  const origin = useNodeMediaViewer((s) => s.origin);
  const showSource = useNodeMediaViewer((s) => s.showSource);
  const { ensure, loading } = useFullResField();

  // Every Viewer node on the canvas is offered as an alternative feed, so a
  // full-screen view opened from ANY node can be switched to the live tap at
  // the end of the chain — and stays live while an editor is worked on.
  const viewerNodes = useWorkflowStore(
    useShallow((s) =>
      s.nodes
        .filter((n) => n.type === "viewer")
        .map((n) => ({ id: n.id, title: (n.data as { customTitle?: string })?.customTitle || "Viewer" })),
    ),
  );

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

  const showSwitcher = viewerNodes.length > 0;

  return (
    <>
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
      {/* Source switcher, portalled ABOVE the overlay (which is z-200). */}
      {showSwitcher &&
        createPortal(
          <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[210] flex items-center gap-1 bg-black/70 backdrop-blur rounded-full px-2 py-1 text-[11px]">
            <span className="text-white/40 pr-1">Source</span>
            <button
              onClick={() => origin && showSource(origin)}
              className={`px-2 py-0.5 rounded-full transition-colors ${
                origin && target.nodeId === origin.nodeId && target.field === origin.field
                  ? "bg-white/90 text-neutral-900"
                  : "text-white/70 hover:text-white"
              }`}
            >
              This node
            </button>
            {viewerNodes.map((v) => (
              <button
                key={v.id}
                onClick={() =>
                  showSource({ nodeId: v.id, field: "image", mediaType: "image", folder: "inputs" })
                }
                className={`px-2 py-0.5 rounded-full transition-colors ${
                  target.nodeId === v.id ? "bg-cyan-400 text-neutral-900" : "text-white/70 hover:text-white"
                }`}
                title="Live tap — updates as upstream nodes change"
              >
                {v.title}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
