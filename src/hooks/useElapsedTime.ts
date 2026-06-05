"use client";

import { useEffect, useState } from "react";

/**
 * Live elapsed-time counter for loading states.
 *
 * Returns the integer number of seconds since `startedAt` (ms epoch). When
 * `active` is false (or `startedAt` is null), returns null and no timer
 * runs. Updates every 5 seconds — chosen to match the user-requested
 * "queue position display refresh" cadence and to keep re-renders cheap
 * across many simultaneously-running nodes.
 */
export function useElapsedTime(startedAt: number | null | undefined, active: boolean): number | null {
  const [now, setNow] = useState<number | null>(() => (active && startedAt ? Date.now() : null));

  useEffect(() => {
    if (!active || !startedAt) {
      setNow(null);
      return;
    }
    // Render once immediately, then on a 5s interval.
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(interval);
  }, [active, startedAt]);

  if (!active || !startedAt || now == null) return null;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** Format a seconds count as e.g. `12s`, `1m 04s`, `1h 02m`. */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}
