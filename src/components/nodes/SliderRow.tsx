"use client";

/**
 * Labelled slider + formatted readout, double-click to reset.
 *
 * Shared by the Blur and Dilate nodes. It started as a private helper inside
 * BlurNode; the second copy went into Dilate and was deleted again the same
 * day, because this repo has already paid for two copies of a grade control
 * drifting apart.
 */
export interface SliderRowProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  resetValue: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}

export function SliderRow({ label, min, max, step, value, resetValue, format, onChange }: SliderRowProps) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="text-[10px] text-neutral-400 w-[52px] shrink-0">{label}</label>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onDoubleClick={() => onChange(resetValue)}
        className="nodrag nopan flex-1 h-1 accent-indigo-500 cursor-pointer min-w-0"
        title="Double-click to reset"
      />
      <span className="text-[10px] text-neutral-300 w-[40px] shrink-0 tabular-nums text-right">{format(value)}</span>
    </div>
  );
}
