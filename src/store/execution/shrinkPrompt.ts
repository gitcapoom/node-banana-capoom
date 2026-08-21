/**
 * Hold a generator prompt under a character budget.
 *
 * We count the characters ourselves and only ever ask the model to SHORTEN.
 * Models are unreliable at counting and the count is free for us, so asking
 * "how long is this?" would spend a call on the one part we can do exactly.
 */

/**
 * How many reduction calls a single Send may spend. Each is a full round trip,
 * and past a few passes a model that has not converged usually will not.
 */
export const MAX_SHRINK_CALLS = 3;

/** Asks the model to shorten `text` to under `limit` characters. */
export type ShrinkCall = (text: string, limit: number) => Promise<string>;

export interface ShrinkResult {
  text: string;
  /** Set only when the budget could not be met. */
  warning: string | null;
}

export async function shrinkToLimit(
  text: string,
  limit: number | null | undefined,
  call: ShrinkCall,
): Promise<ShrinkResult> {
  // 0 / null / undefined all mean "no budget".
  if (!limit || limit <= 0 || text.length <= limit) {
    return { text, warning: null };
  }

  // Every candidate seen, including the original: a reduction pass can come
  // back LONGER than its input, so the last attempt is not necessarily the
  // best one. Picking the shortest costs nothing and is never worse.
  let best = text;

  for (let i = 0; i < MAX_SHRINK_CALLS; i++) {
    let next: string;
    try {
      next = await call(best, limit);
    } catch {
      // A failed pass is not a failed run — keep the best we have and warn.
      break;
    }
    const trimmed = (next ?? "").trim();
    // An empty answer would otherwise blank a prompt the user is about to wire
    // into a generator. Discard it and stop.
    if (!trimmed) break;

    if (trimmed.length < best.length) best = trimmed;
    if (best.length <= limit) return { text: best, warning: null };
  }

  // Deliberately NOT truncated. An over-length but coherent prompt is more
  // useful than one severed mid-phrase, and the warning makes the overage
  // visible so the choice stays the user's.
  return {
    text: best,
    warning: `${best.length - limit} characters over limit (${best.length}/${limit})`,
  };
}
