/**
 * Feature flag: "dynamic input pins".
 *
 * When ON, multi-value node inputs render as one labeled pin per connection
 * (with a trailing empty pin to add the next) instead of a single pin that
 * silently accepts many edges. When OFF, the app behaves exactly as before.
 *
 * This module is intentionally self-contained (one localStorage key, no store
 * coupling) so the whole experiment can be rolled back by flipping the toggle
 * at runtime — or removed entirely by deleting this file and its references.
 *
 * Defaults to OFF: nothing changes until the user opts in from the header.
 *
 * Usable from two worlds:
 *   - React components → `useDynamicPinsEnabled()` (re-renders on toggle)
 *   - Plain logic (e.g. the Zustand store's getConnectedInputs, which runs
 *     client-side) → `getDynamicPinsEnabled()`
 */

"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "node-banana-dynamic-pins";

function readInitial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = readInitial();
const listeners = new Set<() => void>();

/** Non-React getter — safe from the store / pure helpers. */
export function getDynamicPinsEnabled(): boolean {
  return enabled;
}

export function setDynamicPinsEnabled(value: boolean): void {
  if (value === enabled) return;
  enabled = value;
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
    }
  } catch {
    /* localStorage unavailable — keep the in-memory value */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook — components re-render when the flag flips. */
export function useDynamicPinsEnabled(): boolean {
  return useSyncExternalStore(subscribe, getDynamicPinsEnabled, () => false);
}
