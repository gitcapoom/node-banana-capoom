"use client";

/**
 * Small "in-flight" badge for nodes whose status is "loading".
 *
 * Pulls the executor-supplied `loadingPhase` ("Submitting…", "Polling…")
 * and `loadingStartedAt` ms epoch, derives a live elapsed-time counter
 * via `useElapsedTime` (5s refresh), and renders both in a compact
 * overlay. Pass `active` to scope the timer to the loading branch — when
 * false (e.g. status flipped to complete/error), the badge unmounts and
 * the timer cleans up.
 */

import { useElapsedTime, formatElapsed } from "@/hooks/useElapsedTime";

interface LoadingBadgeProps {
  active: boolean;
  loadingStartedAt: number | null | undefined;
  loadingPhase: string | null | undefined;
  /** Provider queue position (0-indexed). When non-null and no
   *  loadingPhase override is set, the badge formats as `Queued · #N`. */
  queuePosition?: number | null;
  /** Tailwind size / position overrides. Defaults to a top-right pill. */
  className?: string;
}

export function LoadingBadge({
  active,
  loadingStartedAt,
  loadingPhase,
  queuePosition,
  className = "absolute top-2 right-2 z-10 px-2 py-0.5 rounded bg-black/70 text-white text-[10px] flex items-center gap-1 backdrop-blur-sm pointer-events-none",
}: LoadingBadgeProps) {
  const elapsed = useElapsedTime(loadingStartedAt ?? null, active);
  if (!active) return null;
  // Synthesize a phase label if the executor didn't provide one but did
  // emit a queue position via the SSE stream.
  const label =
    loadingPhase ||
    (queuePosition != null ? `Queued · #${queuePosition + 1}` : "Working…");
  return (
    <div className={className}>
      <span className="text-blue-300">{label}</span>
      {elapsed != null && (
        <span className="text-white/70 tabular-nums">{formatElapsed(elapsed)}</span>
      )}
    </div>
  );
}
