/**
 * Stopping a provider job when the user cancels the node.
 *
 * Cancel in the canvas aborts the browser's fetch to /api/generate, which
 * fires `request.signal` here. Without listening for it, a provider's poll
 * loop kept going until the job finished (up to the 20-minute ceiling) and the
 * job itself ran to completion and was billed. The route now hands that
 * signal to every provider via `GenerationInput.signal`.
 *
 * Two different things happen on cancel, depending on the provider:
 *   - Replicate, fal and muapi have a cancel endpoint, so the job itself is
 *     stopped (Replicate/fal don't bill a canceled job; muapi's endpoint is
 *     best effort).
 *   - Kie, WaveSpeed, Luma, Unifically and Gemini have none. The poll stops
 *     and nothing more is downloaded, but the provider finishes and bills
 *     the job regardless.
 */

import type { GenerationOutput } from "@/lib/providers/types";

/**
 * Wait `ms`, waking early if the signal aborts.
 * Returns true when cancelled — the caller stops polling.
 */
export function waitUnlessCancelled(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return new Promise((r) => setTimeout(() => r(false), ms));
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Ask the provider to stop the job. Best effort: a failure is logged, never
 * thrown — the user has already moved on, and there is no one to report to.
 */
export async function cancelUpstream(
  requestId: string,
  provider: string,
  cancel: () => Promise<Response>,
): Promise<void> {
  try {
    const resp = await cancel();
    if (resp.ok) {
      console.log(`[API:${requestId}] ${provider}: job canceled on the provider`);
    } else {
      const text = await resp.text().catch(() => "");
      console.warn(`[API:${requestId}] ${provider}: cancel returned ${resp.status} ${text.substring(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[API:${requestId}] ${provider}: cancel request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The result a provider returns once it has stopped for a cancel. */
export function cancelledOutput(requestId: string, provider: string, stoppedOnProvider: boolean): GenerationOutput {
  console.log(
    `[API:${requestId}] ${provider}: cancelled by the client` +
    (stoppedOnProvider ? "" : " (no cancel API — the provider still finishes and bills the job)"),
  );
  return { success: false, error: "Cancelled" };
}
