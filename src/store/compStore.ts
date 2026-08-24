import { create } from "zustand";
import type { CompNodeData } from "@/types";

/** Which input's transform the CompModal is currently editing. */
export type CompActiveInput = "bg" | "bgAlpha" | "fg" | "fgAlpha" | "matte";

/**
 * The parameters the editor has changed but not yet applied.
 *
 * Deliberately a sparse patch over the node's data rather than a full copy: the
 * five image mirrors (`bgImage`, `fgImage`, ...) keep being written into node
 * data by CompNode from its edges while the editor is open, so a full snapshot
 * would go stale the moment anything upstream re-ran. The modal reads
 * `{ ...node.data, ...draft }` — live images, drafted parameters.
 */
export type CompDraft = Partial<CompNodeData>;

/**
 * The output fields as they stood when the editor opened.
 *
 * The editor publishes a real composite on a settle while you work, so a Viewer
 * and anything downstream keep moving — that write lands in node data and is not
 * part of the draft. Cancel therefore has to put these back explicitly;
 * discarding the draft alone would leave the edited picture behind.
 */
export interface CompBaseline {
  outputImage: CompNodeData["outputImage"];
  outputImageRef: CompNodeData["outputImageRef"];
  outputWidth: CompNodeData["outputWidth"];
  outputHeight: CompNodeData["outputHeight"];
  outputImageDims: CompNodeData["outputImageDims"];
  compCommitSig: CompNodeData["compCommitSig"];
}

interface CompStore {
  isModalOpen: boolean;
  sourceNodeId: string | null;
  activeInput: CompActiveInput;
  draft: CompDraft;
  baseline: CompBaseline | null;
  openModal: (nodeId: string) => void;
  closeModal: () => void;
  setActiveInput: (i: CompActiveInput) => void;
  patchDraft: (patch: CompDraft) => void;
  setBaseline: (b: CompBaseline) => void;
}

/**
 * CompModal's editing state.
 *
 * The editor holds its parameter edits HERE and writes them into the workflow
 * store only on Done, matching what ImageCropModal, RotoModal and MaskPainterModal
 * already do. It previously wrote every control straight through to node data,
 * with `closeModal` doing nothing but hide the window — so Cancel kept your
 * changes, and since no comp parameter is in `UNDO_KEEP_FIELDS` while every comp
 * write does push a snapshot, Ctrl+Z could not get them back either. An
 * accidental slider drag then survived to the next autosave.
 */
export const useCompStore = create<CompStore>((set) => ({
  isModalOpen: false,
  sourceNodeId: null,
  activeInput: "fg",
  draft: {},
  baseline: null,
  openModal: (nodeId) =>
    set({ isModalOpen: true, sourceNodeId: nodeId, activeInput: "fg", draft: {}, baseline: null }),
  closeModal: () => set({ isModalOpen: false, sourceNodeId: null, draft: {}, baseline: null }),
  setActiveInput: (activeInput) => set({ activeInput }),
  patchDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),
  setBaseline: (baseline) => set({ baseline }),
}));
