"use client";

import { useCallback, useState } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { loadMediaById } from "@/utils/mediaStorage";

interface EnsureArgs {
  id: string;
  /** Raw field to populate with full-res (e.g. "image", "sourceImage", "outputMask"). */
  field: string;
  /** File ref to load full-res from. */
  ref?: string;
  /** Current full-res value, if already loaded. */
  current?: string | null;
  folder?: "inputs" | "generations";
}

/**
 * On-demand full-res loader for a node image field.
 *
 * With lazy loading, displayed image fields are NULL on open (only the inline
 * thumb is shown). When the user double-clicks to view, or opens an editor, call
 * `ensure(...)` to load the full-res from its file ref into node data — so the
 * overlay / live canvas shows real resolution. `loading` drives a spinner.
 *
 * No-ops (returns `current`) when full-res is already present, so it's safe to
 * call on every double-click / editor-open.
 */
export function useFullResField() {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const saveDirectoryPath = useWorkflowStore((s) => s.saveDirectoryPath);
  const [loading, setLoading] = useState(false);

  const ensure = useCallback(
    async ({ id, field, ref, current, folder = "inputs" }: EnsureArgs): Promise<string | null> => {
      if (current) return current;
      if (!ref || !saveDirectoryPath) return current ?? null;
      setLoading(true);
      try {
        const url = await loadMediaById(ref, saveDirectoryPath, folder);
        if (url) {
          updateNodeData(id, { [field]: url });
          return url;
        }
        return null;
      } finally {
        setLoading(false);
      }
    },
    [updateNodeData, saveDirectoryPath],
  );

  return { ensure, loading };
}
