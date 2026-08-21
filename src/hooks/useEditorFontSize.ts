"use client";

import { useEffect, useState } from "react";

export const EDITOR_FONT_SIZES = [10, 12, 14, 16, 18, 20, 24];
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;

/**
 * A persisted font size for a full-screen editor, matching PromptEditorModal's
 * long-standing behaviour (same default, same range, same options).
 *
 * Keyed per editor so the chat and the prompt editor can be set independently —
 * they are read at very different sizes. An out-of-range or unparseable stored
 * value falls back to the default rather than being clamped, so a corrupted key
 * cannot leave someone stuck at an unreadable size.
 */
export function useEditorFontSize(storageKey: string): [number, (size: number) => void] {
  const [fontSize, setFontSize] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_FONT_SIZE;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= MIN_FONT_SIZE && parsed <= MAX_FONT_SIZE) return parsed;
      }
    } catch {
      /* localStorage unavailable (private mode / SSR) — use the default */
    }
    return DEFAULT_FONT_SIZE;
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(fontSize));
    } catch {
      /* not persisting is not worth failing the render for */
    }
  }, [storageKey, fontSize]);

  return [fontSize, setFontSize];
}

export type EditorThumbSize = "small" | "medium" | "large" | "xl";

/** px edge for each step. "small" is what the transcript always used. */
export const EDITOR_THUMB_PX: Record<EditorThumbSize, number> = {
  small: 32,
  medium: 64,
  large: 112,
  xl: 192,
};

export const EDITOR_THUMB_LABELS: Record<EditorThumbSize, string> = {
  small: "S",
  medium: "M",
  large: "L",
  xl: "XL",
};

const THUMB_ORDER: EditorThumbSize[] = ["small", "medium", "large", "xl"];
export const EDITOR_THUMB_SIZES = THUMB_ORDER;

/**
 * A persisted image-thumbnail size for a full-screen editor.
 *
 * Same shape as useEditorFontSize and for the same reason: a reading
 * preference belongs to the person, not the document, so it lives in
 * localStorage rather than node data and never travels with a saved workflow.
 */
export function useEditorThumbSize(
  storageKey: string,
): [EditorThumbSize, (size: EditorThumbSize) => void] {
  const [size, setSize] = useState<EditorThumbSize>(() => {
    if (typeof window === "undefined") return "small";
    try {
      const saved = localStorage.getItem(storageKey) as EditorThumbSize | null;
      if (saved && THUMB_ORDER.includes(saved)) return saved;
    } catch {
      /* localStorage unavailable — use the default */
    }
    return "small";
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, size);
    } catch {
      /* not persisting is not worth failing the render for */
    }
  }, [storageKey, size]);

  return [size, setSize];
}
