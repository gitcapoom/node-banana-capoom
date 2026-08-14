"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// ─── Docked viewer (full-screen editors) ──────────────────────────

type DockCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

const DOCK_KEY = "node-banana-docked-viewer";
const CORNERS: Array<{ id: DockCorner; label: string; cls: string }> = [
  { id: "top-left", label: "top left", cls: "top-4 left-4" },
  { id: "top-right", label: "top right", cls: "top-4 right-4" },
  { id: "bottom-left", label: "bottom left", cls: "bottom-4 left-4" },
  { id: "bottom-right", label: "bottom right", cls: "bottom-4 right-4" },
];

const MIN_W = 220;
const MAX_W = 900;

interface DockPrefs {
  corner: DockCorner;
  width: number;
}

function readPrefs(): DockPrefs {
  const fallback: DockPrefs = { corner: "bottom-right", width: 340 };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(DOCK_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<DockPrefs>;
    return {
      corner: CORNERS.some((c) => c.id === p.corner) ? (p.corner as DockCorner) : fallback.corner,
      width: typeof p.width === "number" ? Math.min(MAX_W, Math.max(MIN_W, p.width)) : fallback.width,
    };
  } catch {
    return fallback;
  }
}

/**
 * Live Viewer pane for the full-screen editors.
 *
 * The editors own the whole screen, so the full-screen viewer can't also be up
 * — but the thing you usually want while retouching a matte is the composite
 * three nodes downstream. This docks that feed in a corner: pick a Viewer, keep
 * working, watch it update (the editors publish their output on a debounced
 * settle, so the chain follows along).
 *
 * Corner and width persist: where the pane belongs depends on where each editor
 * floats its own controls, and that preference is stable per user, not per
 * session.
 */
export function DockedViewer() {
  const viewers = useViewerNodes();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<DockPrefs>(readPrefs);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number; dir: 1 | -1 } | null>(null);

  const persist = useCallback((next: DockPrefs) => {
    setPrefs(next);
    try {
      window.localStorage.setItem(DOCK_KEY, JSON.stringify(next));
    } catch {
      /* localStorage unavailable — keep the in-memory value */
    }
  }, []);

  // Drag-to-resize, tracked on window so the pointer may leave the grip.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = (e.clientX - d.startX) * d.dir;
      setPrefs((p) => ({ ...p, width: Math.min(MAX_W, Math.max(MIN_W, d.startW + delta)) }));
    };
    const onUp = () => {
      setResizing(false);
      dragRef.current = null;
      setPrefs((p) => {
        try {
          window.localStorage.setItem(DOCK_KEY, JSON.stringify(p));
        } catch { /* ignore */ }
        return p;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [resizing]);

  if (viewers.length === 0) return null;

  const corner = CORNERS.find((c) => c.id === prefs.corner) ?? CORNERS[3];
  const selected = viewers.find((v) => v.id === selectedId) ?? viewers[0];
  const anchoredRight = corner.id.endsWith("right");

  if (!open) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
          setSelectedId(selected.id);
        }}
        className={`absolute z-30 flex items-center gap-2 px-4 py-2.5 rounded-lg bg-cyan-600/90 hover:bg-cyan-500 text-white text-sm font-medium shadow-lg transition-colors ${corner.cls}`}
        title="Show a live Viewer feed while you edit"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        Viewer
      </button>
    );
  }

  return (
    <div
      className={`absolute z-30 rounded-lg overflow-hidden border border-neutral-700 bg-neutral-900/95 backdrop-blur shadow-2xl ${corner.cls}`}
      style={{ width: prefs.width }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-neutral-800">
        <select
          value={selected.id}
          onChange={(e) => setSelectedId(e.target.value)}
          className="nodrag flex-1 min-w-0 bg-transparent text-[11px] text-cyan-300 outline-none"
        >
          {viewers.map((v) => (
            <option key={v.id} value={v.id} className="bg-neutral-900">
              {v.title}
            </option>
          ))}
        </select>

        {/* Dock corner — so the pane can move clear of whatever controls the
            current editor floats. */}
        <div className="flex items-center gap-0.5 shrink-0">
          {CORNERS.map((c) => (
            <button
              key={c.id}
              onClick={() => persist({ ...prefs, corner: c.id })}
              className={`w-4 h-4 rounded-sm border flex transition-colors ${
                c.id === corner.id
                  ? "border-cyan-400 bg-cyan-400/20"
                  : "border-neutral-600 hover:border-neutral-400"
              } ${c.id.startsWith("top") ? "items-start" : "items-end"} ${
                c.id.endsWith("left") ? "justify-start" : "justify-end"
              }`}
              title={`Dock ${c.label}`}
            >
              <span
                className={`block w-1.5 h-1.5 rounded-[1px] ${
                  c.id === corner.id ? "bg-cyan-300" : "bg-neutral-500"
                }`}
              />
            </button>
          ))}
        </div>

        <button
          onClick={() => setOpen(false)}
          className="text-neutral-500 hover:text-white text-xs leading-none px-1 shrink-0"
          title="Hide viewer"
        >
          ✕
        </button>
      </div>

      <div className="relative w-full bg-black" style={{ height: Math.round(prefs.width * 0.5625) }}>
        {selected.image ? (
          <img
            src={selected.image}
            alt={selected.title}
            className="w-full h-full object-contain"
            draggable={false}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-neutral-600">
            Viewer has no input
          </div>
        )}

        {/* Resize grip on the free side — width drags, height follows at 16:9. */}
        <div
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dragRef.current = { startX: e.clientX, startW: prefs.width, dir: anchoredRight ? -1 : 1 };
            setResizing(true);
          }}
          className={`absolute bottom-0 ${anchoredRight ? "left-0" : "right-0"} w-5 h-5 cursor-ew-resize group`}
          title="Drag to resize"
        >
          <div
            className={`absolute inset-1 border-b-2 border-neutral-600 group-hover:border-cyan-400 transition-colors ${
              anchoredRight ? "border-l-2" : "border-r-2"
            }`}
          />
        </div>
      </div>
    </div>
  );
}
