"use client";

/**
 * Shared bits for the chainable color nodes (Color Grade / HSV Correct /
 * Contrast Adjust).
 */

// Re-exported from the util module so both client components and the
// (non-React) executors can import it without crossing the use-client line.
export { COLOR_NODE_TYPES } from "@/utils/colorChain";

interface ClampTogglesProps {
  clampBlacks: boolean;
  clampWhites: boolean;
  onChange: (which: "clampBlacks" | "clampWhites", value: boolean) => void;
}

/**
 * Two pill toggles that re-enable clamping of the low / high end on this
 * node's output. Off by default so out-of-range values flow into the
 * next color node (float chain). Turn on (typically on the last node) to
 * bring values back into [0,1].
 */
export function ClampToggles({ clampBlacks, clampWhites, onChange }: ClampTogglesProps) {
  return (
    <div className="flex items-center gap-1.5 pt-1 border-t border-neutral-800/60">
      <span className="text-[9px] text-neutral-500 shrink-0">Clamp</span>
      <button
        onClick={() => onChange("clampBlacks", !clampBlacks)}
        title="Clamp values below 0 (blacks) to 0"
        className={`nodrag nopan text-[10px] px-2 py-0.5 rounded transition-colors ${
          clampBlacks ? "bg-indigo-600 text-white" : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
        }`}
      >
        Blacks
      </button>
      <button
        onClick={() => onChange("clampWhites", !clampWhites)}
        title="Clamp values above 1 (whites) to 1"
        className={`nodrag nopan text-[10px] px-2 py-0.5 rounded transition-colors ${
          clampWhites ? "bg-indigo-600 text-white" : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
        }`}
      >
        Whites
      </button>
    </div>
  );
}
