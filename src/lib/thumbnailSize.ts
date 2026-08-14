/**
 * User setting: thumbnail resolution.
 *
 * Every node preview on the canvas is a thumbnail, so this single number sets
 * how heavy the canvas is: how much decodes when a workflow opens, how much
 * repaints while panning, and how much weight lands in the saved JSON. 256 is
 * the default because node previews render at ~200-300 CSS px; 512 and 1024
 * buy sharpness on a large monitor at a steep cost, and 128 keeps very large
 * graphs light.
 *
 * The value applies to thumbnails written from now on — existing thumbs keep
 * whatever size they were saved at until their node next re-saves.
 *
 * Same shape as the dynamic-pins flag: one localStorage key, no store coupling,
 * usable from both React (`useThumbnailMaxDim`) and plain logic
 * (`getThumbnailMaxDim`, which the save path calls).
 */

"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "node-banana-thumbnail-size";

export const THUMBNAIL_SIZE_OPTIONS = [128, 256, 512, 1024] as const;
export type ThumbnailSize = (typeof THUMBNAIL_SIZE_OPTIONS)[number];

export const DEFAULT_THUMBNAIL_SIZE: ThumbnailSize = 256;

function isValid(n: number): n is ThumbnailSize {
  return (THUMBNAIL_SIZE_OPTIONS as readonly number[]).includes(n);
}

function readInitial(): ThumbnailSize {
  if (typeof window === "undefined") return DEFAULT_THUMBNAIL_SIZE;
  try {
    const raw = Number(window.localStorage.getItem(STORAGE_KEY));
    return isValid(raw) ? raw : DEFAULT_THUMBNAIL_SIZE;
  } catch {
    return DEFAULT_THUMBNAIL_SIZE;
  }
}

let current: ThumbnailSize = readInitial();
const listeners = new Set<() => void>();

/**
 * Bumped each time the size changes. Node previews watch it so they can show
 * "rendering" while their thumbnail is still the old size — changing the
 * setting doesn't rewrite existing thumbs on the spot, and a preview silently
 * showing stale pixels reads as the setting having done nothing.
 */
let generation = 0;
const pendingNodes = new Set<string>();

export function getThumbnailGeneration(): number {
  return generation;
}

/** True while `nodeId` has not yet re-rendered its thumb at the current size. */
export function isThumbnailPending(nodeId: string): boolean {
  return pendingNodes.has(nodeId);
}

/** Called by a node once it has written a thumb at the current size. */
export function markThumbnailRendered(nodeId: string): void {
  if (!pendingNodes.delete(nodeId)) return;
  listeners.forEach((l) => l());
}

/** Called on a size change with every node that displays a thumbnail. */
export function markAllThumbnailsPending(nodeIds: string[]): void {
  pendingNodes.clear();
  nodeIds.forEach((id) => pendingNodes.add(id));
  listeners.forEach((l) => l());
}

/** Non-React getter — used by the save path and the GPU commit paths. */
export function getThumbnailMaxDim(): ThumbnailSize {
  return current;
}

export function setThumbnailMaxDim(value: ThumbnailSize): void {
  if (value === current || !isValid(value)) return;
  current = value;
  generation++;
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, String(value));
    }
  } catch {
    /* localStorage unavailable — keep the in-memory value */
  }
  listeners.forEach((l) => l());
}

export function subscribeThumbnailSize(cb: () => void): () => void {
  return subscribe(cb);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook — components re-render when the size changes. */
export function useThumbnailMaxDim(): ThumbnailSize {
  return useSyncExternalStore(subscribe, getThumbnailMaxDim, () => DEFAULT_THUMBNAIL_SIZE);
}

/** React hook — true while this node's thumbnail is still at the old size. */
export function useThumbnailPending(nodeId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isThumbnailPending(nodeId),
    () => false,
  );
}
