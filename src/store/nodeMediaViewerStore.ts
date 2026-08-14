import { create } from "zustand";
import type { MediaType } from "@/components/MediaOverlay";

/**
 * Which node field the full-screen viewer is currently showing.
 *
 * The viewer stores a *reference* (node id + data field) rather than a URL, so
 * that when the lazily-loaded full-res image lands in node data the overlay
 * upgrades from thumbnail to full resolution on its own.
 */
export interface NodeMediaTarget {
  nodeId: string;
  /** Node data key holding the media, e.g. "outputImage" / "outputVideo". */
  field: string;
  mediaType: MediaType;
  /** Where the full-res file lives, when it has to be loaded on demand. */
  folder: "inputs" | "generations";
}

interface NodeMediaViewerState {
  target: NodeMediaTarget | null;
  open: (target: NodeMediaTarget) => void;
  close: () => void;
}

/**
 * Canvas-wide "double-click a node's preview to view it full screen".
 *
 * One store + one overlay host for every node, instead of per-node overlay
 * state. Nodes opt in by marking their preview element with `data-node-media`
 * (see BaseNode); nodes that own a richer editor keep their own double-click.
 */
export const useNodeMediaViewer = create<NodeMediaViewerState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
