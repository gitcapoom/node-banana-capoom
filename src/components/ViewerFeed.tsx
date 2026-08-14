"use client";

import { useMemo, useState } from "react";
import { useWorkflowStore } from "@/store/workflowStore";

export interface ViewerNodeRef {
  id: string;
  title: string;
  /** Current image on that Viewer — live, updates as upstream changes. */
  image: string | null;
}

/**
 * Every Viewer node on the canvas, with its live image.
 *
 * Shared by the full-screen overlay's source switcher and the editors' docked
 * pane, so "watch the end of the chain" is the same feed wherever you ask for it.
 */
export function useViewerNodes(): ViewerNodeRef[] {
  const nodes = useWorkflowStore((s) => s.nodes);
  return useMemo(
    () =>
      nodes
        .filter((n) => n.type === "viewer")
        .map((n) => {
          const d = n.data as { customTitle?: string; image?: string | null; imageThumb?: string | null };
          return {
            id: n.id,
            title: d.customTitle || "Viewer",
            image: d.image ?? d.imageThumb ?? null,
          };
        }),
    [nodes],
  );
}

interface ViewerSourceSwitcherProps {
  viewers: ViewerNodeRef[];
  /** null = show the surface's own content. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  ownLabel?: string;
  className?: string;
}

/** Pill row: this surface's own media, or any Viewer node's live feed. */
export function ViewerSourceSwitcher({
  viewers,
  selectedId,
  onSelect,
  ownLabel = "This node",
  className = "",
}: ViewerSourceSwitcherProps) {
  if (viewers.length === 0) return null;
  return (
    <div
      className={`flex items-center gap-1 bg-black/70 backdrop-blur rounded-full px-2 py-1 text-[11px] ${className}`}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-white/40 pr-1">Source</span>
      <button
        onClick={() => onSelect(null)}
        className={`px-2 py-0.5 rounded-full transition-colors ${
          selectedId === null ? "bg-white/90 text-neutral-900" : "text-white/70 hover:text-white"
        }`}
      >
        {ownLabel}
      </button>
      {viewers.map((v) => (
        <button
          key={v.id}
          onClick={() => onSelect(v.id)}
          className={`px-2 py-0.5 rounded-full transition-colors ${
            selectedId === v.id ? "bg-cyan-400 text-neutral-900" : "text-white/70 hover:text-white"
          }`}
          title="Live tap — follows upstream edits as you make them"
        >
          {v.title}
        </button>
      ))}
    </div>
  );
}

interface DockedViewerProps {
  /** Where to anchor the pane inside its (relatively positioned) parent. */
  className?: string;
}

/**
 * Small live Viewer pane for the full-screen editors.
 *
 * The editors already own the whole screen, so the full-screen viewer can't
 * also be up — but the thing you usually want while retouching a matte is the
 * composite three nodes downstream. This docks that feed in a corner: pick a
 * Viewer, keep working, watch it update (the editors publish their output on a
 * debounced settle, so the chain follows along).
 *
 * Collapsed to a single button until asked for, so it costs nothing by default.
 */
export function DockedViewer({ className = "" }: DockedViewerProps) {
  const viewers = useViewerNodes();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  if (viewers.length === 0) return null;

  const selected = viewers.find((v) => v.id === selectedId) ?? viewers[0];

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); setSelectedId(selected.id); }}
        className={`absolute z-30 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/70 backdrop-blur text-[11px] text-white/80 hover:text-white transition-colors ${className}`}
        title="Show a live Viewer feed while you edit"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        Viewer
      </button>
    );
  }

  return (
    <div className={`absolute z-30 w-64 rounded-lg overflow-hidden border border-neutral-700 bg-neutral-900/95 backdrop-blur shadow-xl ${className}`}>
      <div className="flex items-center justify-between px-2 py-1 border-b border-neutral-800">
        <select
          value={selected.id}
          onChange={(e) => setSelectedId(e.target.value)}
          className="nodrag bg-transparent text-[10px] text-cyan-300 outline-none max-w-[9rem]"
        >
          {viewers.map((v) => (
            <option key={v.id} value={v.id} className="bg-neutral-900">
              {v.title}
            </option>
          ))}
        </select>
        <button
          onClick={() => setOpen(false)}
          className="text-neutral-500 hover:text-white text-[11px] leading-none px-1"
          title="Hide viewer"
        >
          ✕
        </button>
      </div>
      <div className="relative w-full aspect-video bg-black">
        {selected.image ? (
          <img src={selected.image} alt={selected.title} className="w-full h-full object-contain" draggable={false} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-neutral-600">
            Viewer has no input
          </div>
        )}
      </div>
    </div>
  );
}
