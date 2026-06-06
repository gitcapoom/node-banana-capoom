import { create } from "zustand";

/** Which input's transform the CompModal is currently editing. */
export type CompActiveInput = "fg" | "fgAlpha" | "matte";

interface CompStore {
  isModalOpen: boolean;
  sourceNodeId: string | null;
  activeInput: CompActiveInput;
  openModal: (nodeId: string) => void;
  closeModal: () => void;
  setActiveInput: (i: CompActiveInput) => void;
}

/**
 * Modal state only — the Comp node's data (images, transforms, op) is the
 * source of truth in the workflow store. This bridge just tracks which node's
 * editor is open and which input tab is active.
 */
export const useCompStore = create<CompStore>((set) => ({
  isModalOpen: false,
  sourceNodeId: null,
  activeInput: "fg",
  openModal: (nodeId) => set({ isModalOpen: true, sourceNodeId: nodeId, activeInput: "fg" }),
  closeModal: () => set({ isModalOpen: false, sourceNodeId: null }),
  setActiveInput: (activeInput) => set({ activeInput }),
}));
