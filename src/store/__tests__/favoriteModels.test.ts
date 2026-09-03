/**
 * Favourite models.
 *
 * The model browser already had "Recently Used", which is automatic and
 * decays — you cannot keep a model there, and a burst of experimenting pushes
 * the one you actually rely on out of it. Favourites are the pinned
 * counterpart: only the user adds or removes them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import { useWorkflowStore } from "../workflowStore";
import { FAVORITE_MODELS_KEY } from "../utils/localStorage";
import type { FavoriteModel } from "@/types";

vi.mock("@/components/Toast", () => ({
  useToast: { getState: () => ({ show: vi.fn() }) },
}));

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
  saveLogSession: vi.fn(),
}));

const NANO = { provider: "fal" as const, modelId: "minimax/h3", displayName: "MiniMax H3" };
const OTHER = { provider: "replicate" as const, modelId: "bytedance/seedance", displayName: "Seedance" };

function stored(): FavoriteModel[] {
  const raw = localStorage.getItem(FAVORITE_MODELS_KEY);
  return raw ? JSON.parse(raw) : [];
}

beforeEach(() => {
  localStorage.clear();
  useWorkflowStore.setState({ favoriteModels: [] });
});

describe("toggleFavoriteModel", () => {
  it("stars a model", () => {
    act(() => useWorkflowStore.getState().toggleFavoriteModel(NANO));
    expect(useWorkflowStore.getState().favoriteModels).toHaveLength(1);
    expect(useWorkflowStore.getState().favoriteModels[0].modelId).toBe("minimax/h3");
  });

  it("un-stars the same model", () => {
    act(() => useWorkflowStore.getState().toggleFavoriteModel(NANO));
    act(() => useWorkflowStore.getState().toggleFavoriteModel(NANO));
    expect(useWorkflowStore.getState().favoriteModels).toHaveLength(0);
  });

  it("never stores the same model twice", () => {
    act(() => useWorkflowStore.getState().toggleFavoriteModel(NANO));
    act(() => useWorkflowStore.getState().toggleFavoriteModel(OTHER));
    act(() => useWorkflowStore.getState().toggleFavoriteModel(NANO)); // removes
    act(() => useWorkflowStore.getState().toggleFavoriteModel(NANO)); // re-adds
    const ids = useWorkflowStore.getState().favoriteModels.map((f) => f.modelId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(2);
  });

  it("keys on provider AND model id", () => {
    // Recents key on modelId alone. Favourites are long-lived, so the same id
    // offered by two providers must be two independent pins — un-starring one
    // must not silently remove the other.
    const falCopy = { provider: "fal" as const, modelId: "shared/id", displayName: "via fal" };
    const repCopy = { provider: "replicate" as const, modelId: "shared/id", displayName: "via replicate" };

    act(() => useWorkflowStore.getState().toggleFavoriteModel(falCopy));
    act(() => useWorkflowStore.getState().toggleFavoriteModel(repCopy));
    expect(useWorkflowStore.getState().favoriteModels).toHaveLength(2);

    act(() => useWorkflowStore.getState().toggleFavoriteModel(falCopy));
    const left = useWorkflowStore.getState().favoriteModels;
    expect(left).toHaveLength(1);
    expect(left[0].provider).toBe("replicate");
  });

  it("puts the newest pin first", () => {
    act(() => useWorkflowStore.getState().toggleFavoriteModel(NANO));
    act(() => useWorkflowStore.getState().toggleFavoriteModel(OTHER));
    expect(useWorkflowStore.getState().favoriteModels[0].modelId).toBe(OTHER.modelId);
  });

  it("survives a reload", () => {
    act(() => useWorkflowStore.getState().toggleFavoriteModel(NANO));
    expect(stored()).toHaveLength(1);
    expect(stored()[0].displayName).toBe("MiniMax H3");

    act(() => useWorkflowStore.getState().toggleFavoriteModel(NANO));
    expect(stored()).toHaveLength(0);
  });

  it("is not capped", () => {
    // Recents are capped at MAX_RECENT_MODELS because they accumulate on their
    // own. Every favourite is a deliberate act, so dropping one would be
    // discarding something the user asked to keep.
    for (let i = 0; i < 40; i++) {
      act(() =>
        useWorkflowStore.getState().toggleFavoriteModel({
          provider: "fal", modelId: `model-${i}`, displayName: `Model ${i}`,
        }),
      );
    }
    expect(useWorkflowStore.getState().favoriteModels).toHaveLength(40);
  });
});
