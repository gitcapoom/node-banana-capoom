/**
 * Cheap render signatures for the live GPU nodes (color chain, Blur, Comp).
 *
 * Two distinct costs these solve, both of which scale with graph size:
 *
 * 1. **Signature building.** A node's "did anything change?" key must never
 *    embed a raw image. Inputs are data URLs running to tens of megabytes, so
 *    `JSON.stringify({ url })` in a render body copies the whole image on every
 *    React render. `cheapUrlKey` keys off length + head/tail instead.
 *
 * 2. **Redundant commits.** React Flow's viewport culling unmounts nodes that
 *    scroll out of view and remounts them on the way back, which re-fires every
 *    render effect. Without a memory that survives the unmount, panning across a
 *    large graph re-encodes an identical full-res PNG (`toDataURL`, ~100-300ms
 *    on a 4K frame) and writes it to the store for each node that passes
 *    through — every write re-rendering the tree and cascading a recompute
 *    downstream. `RenderSignatureCache` remembers what was already committed.
 */

/** Collision-safe-enough identity for a possibly-huge data URL. */
export function cheapUrlKey(url: string | null | undefined): string {
  if (!url) return "-";
  if (url.length <= 160) return url;
  return `${url.length}:${url.slice(0, 64)}:${url.slice(-64)}`;
}

/**
 * Per-node memory of the last committed render, module-level so it outlives
 * the unmount/remount cycle of viewport culling.
 */

/**
 * Every RenderSignatureCache, plus any extra reset hooks, so a workflow load can
 * drop them all in one call.
 *
 * These caches are module-level ON PURPOSE — React Flow viewport-culls nodes, and
 * a per-instance ref would die with the unmount and re-run the work on the way
 * back. But module-level also means they outlive the WORKFLOW, and node ids repeat
 * across workflows (`comp-1` exists in every file), so without a reset the second
 * workflow opened in a session inherits the first one's "already committed"
 * memory and skips work it genuinely needs to do.
 */
const allCaches: RenderSignatureCache[] = [];
const extraResets: Array<() => void> = [];

/** Register a non-RenderSignatureCache structure that must also clear on load. */
export function registerSignatureReset(fn: () => void): void {
  extraResets.push(fn);
}

/** Clear every registered commit-signature cache. Call on workflow load. */
export function resetCommitSignatureCaches(): void {
  for (const c of allCaches) c.clear();
  for (const fn of extraResets) fn();
}

export class RenderSignatureCache {
  constructor() {
    allCaches.push(this);
  }

  /** Drop every remembered signature. See resetCommitSignatureCaches. */
  clear(): void {
    this.map.clear();
  }

  private readonly map = new Map<string, string>();

  /** True when `signature` is exactly what was last committed for `nodeId`. */
  matches(nodeId: string, signature: string): boolean {
    return this.map.get(nodeId) === signature;
  }

  set(nodeId: string, signature: string): void {
    this.map.set(nodeId, signature);
  }

  forget(nodeId: string): void {
    this.map.delete(nodeId);
  }
}
