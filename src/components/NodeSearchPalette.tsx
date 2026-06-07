"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NodeType } from "@/types";
import { ALL_NODES_CATEGORIES } from "./nodeCatalog";

interface NodeSearchPaletteProps {
  /** Anchor point in screen coordinates (top-left of the panel, clamped to the viewport). */
  position: { x: number; y: number };
  /** Called with the chosen node type. */
  onSelect: (type: NodeType) => void;
  /** Called when the palette should close (Escape / outside click). */
  onClose: () => void;
  /** Placeholder / heading shown in the search box. */
  title?: string;
}

const PALETTE_WIDTH = 240;
const PALETTE_MAX_HEIGHT = 380;

/**
 * Floating, searchable list of every addable node. Opened by pressing Tab on the
 * canvas, and shown when an edge is dragged out and released on empty canvas.
 * Typing filters the list by substring match anywhere within a node's name.
 */
export function NodeSearchPalette({
  position,
  onSelect,
  onClose,
  title = "Search nodes",
}: NodeSearchPaletteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  // Filter categories by substring match anywhere within the node label.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ALL_NODES_CATEGORIES;
    return ALL_NODES_CATEGORIES.map((cat) => ({
      label: cat.label,
      nodes: cat.nodes.filter((n) => n.label.toLowerCase().includes(q)),
    })).filter((cat) => cat.nodes.length > 0);
  }, [query]);

  // Flat list of the currently-visible nodes, in render order, for keyboard nav.
  const flatNodes = useMemo(() => groups.flatMap((g) => g.nodes), [groups]);

  // Map node type -> flat index so render can highlight without a mutable counter.
  const indexByType = useMemo(() => {
    const m = new Map<string, number>();
    flatNodes.forEach((n, i) => m.set(n.type, i));
    return m;
  }, [flatNodes]);

  // Keep the highlight within range when the filtered set changes.
  useEffect(() => {
    setHighlight((h) => (flatNodes.length === 0 ? 0 : Math.min(h, flatNodes.length - 1)));
  }, [flatNodes.length]);

  // Focus the search box on open.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll the highlighted item into view (no-op if already visible).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  // Close on outside click.
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (flatNodes.length) setHighlight((h) => (h + 1) % flatNodes.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          if (flatNodes.length) setHighlight((h) => (h - 1 + flatNodes.length) % flatNodes.length);
          break;
        case "Enter":
          e.preventDefault();
          if (flatNodes[highlight]) onSelect(flatNodes[highlight].type);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "Tab":
          // Keep focus inside the palette instead of letting the browser move it.
          e.preventDefault();
          break;
      }
    },
    [flatNodes, highlight, onSelect, onClose]
  );

  // Clamp the panel to the viewport so it never spills off-screen.
  const vw = typeof window !== "undefined" ? window.innerWidth : 9999;
  const vh = typeof window !== "undefined" ? window.innerHeight : 9999;
  const left = Math.max(12, Math.min(position.x, vw - PALETTE_WIDTH - 12));
  const top = Math.max(12, Math.min(position.y, vh - PALETTE_MAX_HEIGHT - 12));

  return (
    <div
      ref={containerRef}
      onKeyDown={handleKeyDown}
      className="fixed z-100 bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl overflow-hidden flex flex-col outline-none"
      style={{ left, top, width: PALETTE_WIDTH, maxHeight: PALETTE_MAX_HEIGHT }}
    >
      {/* Search box */}
      <div className="p-1.5 border-b border-neutral-700">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          placeholder={title}
          spellCheck={false}
          autoComplete="off"
          className="w-full px-2 py-1.5 text-[12px] bg-neutral-900 text-neutral-100 placeholder-neutral-500 rounded border border-neutral-700 focus:border-neutral-500 outline-none"
        />
      </div>

      {/* Results */}
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {flatNodes.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-neutral-500 text-center">No matching nodes</div>
        ) : (
          groups.map((category, catIndex) => (
            <div key={category.label}>
              <div
                className={`px-3 py-1 text-[10px] text-neutral-500 uppercase tracking-wide${
                  catIndex > 0 ? " border-t border-neutral-700 mt-1" : ""
                }`}
              >
                {category.label}
              </div>
              {category.nodes.map((node) => {
                const idx = indexByType.get(node.type) ?? -1;
                const isActive = idx === highlight;
                return (
                  <button
                    key={node.type}
                    ref={isActive ? activeRef : undefined}
                    onClick={() => onSelect(node.type)}
                    onMouseEnter={() => setHighlight(idx)}
                    className={`w-full px-3 py-1.5 text-left text-[11px] font-medium transition-colors ${
                      isActive
                        ? "bg-neutral-700 text-neutral-100"
                        : "text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100"
                    }`}
                  >
                    {node.label}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>

      {/* Footer hint */}
      <div className="px-2 py-1.5 border-t border-neutral-700 flex items-center gap-3">
        <span className="text-[9px] text-neutral-500">
          <kbd className="px-1 py-0.5 bg-neutral-700 rounded text-[8px]">↑↓</kbd> navigate
        </span>
        <span className="text-[9px] text-neutral-500">
          <kbd className="px-1 py-0.5 bg-neutral-700 rounded text-[8px]">↵</kbd> add
        </span>
        <span className="text-[9px] text-neutral-500">
          <kbd className="px-1 py-0.5 bg-neutral-700 rounded text-[8px]">esc</kbd> close
        </span>
      </div>
    </div>
  );
}
