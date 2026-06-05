import { create } from "zustand";
import type { RotoShape, RotoTool } from "@/types";

/** Deep-copy shapes so history snapshots are independent. */
function cloneShapes(shapes: RotoShape[]): RotoShape[] {
  return shapes.map((s) => ({
    ...s,
    points: s.points.map((p) => ({
      ...p,
      anchor: { ...p.anchor },
      inHandle: { ...p.inHandle },
      outHandle: { ...p.outHandle },
      feather: { ...p.feather },
    })),
  }));
}

interface RotoStore {
  // Modal state
  isModalOpen: boolean;
  sourceNodeId: string | null;
  sourceImage: string | null;

  // Shapes + selection
  shapes: RotoShape[];
  selectedShapeId: string | null;
  selectedPointId: string | null;
  currentTool: RotoTool;

  // History
  history: RotoShape[][];
  historyIndex: number;

  // Modal actions
  openModal: (nodeId: string, image: string, existingShapes?: RotoShape[]) => void;
  closeModal: () => void;

  // Tool / selection
  setTool: (tool: RotoTool) => void;
  setSelectedShape: (id: string | null) => void;
  setSelectedPoint: (id: string | null) => void;

  // Shape mutators
  addShape: (shape: RotoShape) => void;
  replaceShape: (id: string, shape: RotoShape) => void;
  updateShape: (id: string, patch: Partial<RotoShape>) => void;
  deleteShape: (id: string) => void;
  moveShape: (id: string, dir: -1 | 1) => void;
  clear: () => void;

  // History
  undo: () => void;
  redo: () => void;
  pushHistory: () => void;
}

export const useRotoStore = create<RotoStore>((set, get) => ({
  isModalOpen: false,
  sourceNodeId: null,
  sourceImage: null,
  shapes: [],
  selectedShapeId: null,
  selectedPointId: null,
  currentTool: "pen",
  history: [[]],
  historyIndex: 0,

  openModal: (nodeId, image, existingShapes = []) => {
    const shapes = cloneShapes(existingShapes);
    set({
      isModalOpen: true,
      sourceNodeId: nodeId,
      sourceImage: image,
      shapes,
      selectedShapeId: shapes[0]?.id ?? null,
      selectedPointId: null,
      currentTool: shapes.length ? "select" : "pen",
      history: [cloneShapes(shapes)],
      historyIndex: 0,
    });
  },

  closeModal: () => {
    set({
      isModalOpen: false,
      sourceNodeId: null,
      sourceImage: null,
      shapes: [],
      selectedShapeId: null,
      selectedPointId: null,
      history: [[]],
      historyIndex: 0,
    });
  },

  setTool: (tool) => set({ currentTool: tool }),
  setSelectedShape: (id) => set({ selectedShapeId: id, selectedPointId: null }),
  setSelectedPoint: (id) => set({ selectedPointId: id }),

  addShape: (shape) => {
    get().pushHistory();
    set((state) => ({ shapes: [...state.shapes, shape], selectedShapeId: shape.id }));
  },

  replaceShape: (id, shape) => {
    get().pushHistory();
    set((state) => ({ shapes: state.shapes.map((s) => (s.id === id ? shape : s)) }));
  },

  updateShape: (id, patch) => {
    get().pushHistory();
    set((state) => ({ shapes: state.shapes.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  },

  deleteShape: (id) => {
    get().pushHistory();
    set((state) => {
      const shapes = state.shapes.filter((s) => s.id !== id);
      return {
        shapes,
        selectedShapeId: state.selectedShapeId === id ? (shapes[0]?.id ?? null) : state.selectedShapeId,
        selectedPointId: null,
      };
    });
  },

  moveShape: (id, dir) => {
    get().pushHistory();
    set((state) => {
      const idx = state.shapes.findIndex((s) => s.id === id);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= state.shapes.length) return state;
      const shapes = [...state.shapes];
      [shapes[idx], shapes[j]] = [shapes[j], shapes[idx]];
      return { shapes };
    });
  },

  clear: () => {
    get().pushHistory();
    set({ shapes: [], selectedShapeId: null, selectedPointId: null });
  },

  pushHistory: () => {
    set((state) => {
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push(cloneShapes(state.shapes));
      return { history: newHistory, historyIndex: newHistory.length - 1 };
    });
  },

  undo: () => {
    set((state) => {
      if (state.historyIndex > 0) {
        const i = state.historyIndex - 1;
        return { historyIndex: i, shapes: cloneShapes(state.history[i]), selectedPointId: null };
      }
      return state;
    });
  },

  redo: () => {
    set((state) => {
      if (state.historyIndex < state.history.length - 1) {
        const i = state.historyIndex + 1;
        return { historyIndex: i, shapes: cloneShapes(state.history[i]), selectedPointId: null };
      }
      return state;
    });
  },
}));
