import { create } from "zustand";
import type { ImageCropAspectLock } from "@/types";

export interface CropRegion {
  x: number;      // relative 0..1
  y: number;      // relative 0..1
  width: number;  // relative 0..1
  height: number; // relative 0..1
}

interface ImageCropStore {
  // Modal state
  isModalOpen: boolean;
  sourceNodeId: string | null;
  sourceImage: string | null;

  // Crop editing state
  cropRegion: CropRegion | null;
  aspectLock: ImageCropAspectLock;

  // History for undo/redo (each snapshot: { region, aspect })
  history: Array<{ region: CropRegion | null; aspectLock: ImageCropAspectLock }>;
  historyIndex: number;

  // Modal actions
  openModal: (
    nodeId: string,
    image: string,
    existingCrop: CropRegion | null,
    aspectLock: ImageCropAspectLock
  ) => void;
  closeModal: () => void;

  // Crop actions
  setCropRegion: (region: CropRegion | null) => void;
  setAspectLock: (lock: ImageCropAspectLock) => void;
  reset: () => void;

  // History actions
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
}

export const useImageCropStore = create<ImageCropStore>((set, get) => ({
  isModalOpen: false,
  sourceNodeId: null,
  sourceImage: null,
  cropRegion: null,
  aspectLock: "free",
  history: [{ region: null, aspectLock: "free" }],
  historyIndex: 0,

  openModal: (nodeId, image, existingCrop, aspectLock) => {
    set({
      isModalOpen: true,
      sourceNodeId: nodeId,
      sourceImage: image,
      cropRegion: existingCrop,
      aspectLock,
      history: [{ region: existingCrop, aspectLock }],
      historyIndex: 0,
    });
  },

  closeModal: () => {
    set({
      isModalOpen: false,
      sourceNodeId: null,
      sourceImage: null,
      cropRegion: null,
      aspectLock: "free",
      history: [{ region: null, aspectLock: "free" }],
      historyIndex: 0,
    });
  },

  setCropRegion: (region) => {
    const { pushHistory } = get();
    pushHistory();
    set({ cropRegion: region });
  },

  setAspectLock: (lock) => {
    set({ aspectLock: lock });
  },

  reset: () => {
    const { pushHistory } = get();
    pushHistory();
    set({ cropRegion: null });
  },

  pushHistory: () => {
    set((state) => {
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push({ region: state.cropRegion, aspectLock: state.aspectLock });
      return {
        history: newHistory,
        historyIndex: newHistory.length - 1,
      };
    });
  },

  undo: () => {
    set((state) => {
      if (state.historyIndex > 0) {
        const newIndex = state.historyIndex - 1;
        const snap = state.history[newIndex];
        return {
          historyIndex: newIndex,
          cropRegion: snap.region,
          aspectLock: snap.aspectLock,
        };
      }
      return state;
    });
  },

  redo: () => {
    set((state) => {
      if (state.historyIndex < state.history.length - 1) {
        const newIndex = state.historyIndex + 1;
        const snap = state.history[newIndex];
        return {
          historyIndex: newIndex,
          cropRegion: snap.region,
          aspectLock: snap.aspectLock,
        };
      }
      return state;
    });
  },
}));
