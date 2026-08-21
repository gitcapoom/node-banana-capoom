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
