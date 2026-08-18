/**
 * Byte-budgeted LRU for GPU textures.
 *
 * Replaces an ad-hoc cache in colorChain.ts that had three defects, each of which
 * cost real time on a large graph:
 *
 *  - It counted ENTRIES, not bytes. A cap of 12 at 6554x3686 RGBA8 is 1.16 GB of
 *    VRAM — simultaneously too small for the working set and far too large for the
 *    hardware.
 *  - It was FIFO wearing an LRU's clothes. `Map.get` does not reorder, so a hot
 *    entry aged toward the front and got evicted while a cold recent one survived.
 *    With ~29 distinct inputs competing for 12 slots the hit rate was ~0, and every
 *    miss decoded a 24MP image inside the render mutex.
 *  - Nothing ever cleared it on workflow load, so each successive open in a session
 *    inherited the previous workflow's textures. Opens degraded progressively.
 *
 * Generic over the value so the GL details stay in colorChain: the caller supplies
 * the byte weight and the disposer.
 */

export interface TexCacheEntry<V> {
  value: V;
  bytes: number;
}

export class TexCache<V> {
  private map = new Map<string, TexCacheEntry<V>>();
  private total = 0;

  /**
   * @param budgetBytes evict until the total fits under this
   * @param dispose called exactly once per value that leaves the cache
   */
  constructor(
    private budgetBytes: number,
    private dispose: (value: V) => void,
  ) {}

  get size(): number {
    return this.map.size;
  }

  /** Total weight currently held. GL memory is invisible to devtools, so this is
   *  the only way to see whether the budget is doing anything. */
  get bytes(): number {
    return this.total;
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    // THE fix for the FIFO pathology: re-insert so this key becomes newest.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V, bytes: number): void {
    // Replacing a live key must dispose the old value, and exactly once.
    const prev = this.map.get(key);
    if (prev) {
      this.total -= prev.bytes;
      this.map.delete(key);
      if (prev.value !== value) this.dispose(prev.value);
    }
    this.map.set(key, { value, bytes });
    this.total += bytes;
    this.evictToBudget(key);
  }

  /** Drop one key if present. */
  delete(key: string): boolean {
    const hit = this.map.get(key);
    if (!hit) return false;
    this.map.delete(key);
    this.total -= hit.bytes;
    this.dispose(hit.value);
    return true;
  }

  /** Dispose everything. Used on workflow load — see resetColorChainCaches. */
  clear(): void {
    for (const entry of this.map.values()) this.dispose(entry.value);
    this.map.clear();
    this.total = 0;
  }

  /**
   * Evict oldest-first until under budget. A loop, not a single `if` — one insert
   * of a 96 MB texture can push several small ones out at once.
   *
   * `keep` is never evicted: an entry larger than the whole budget would otherwise
   * evict itself immediately and the caller would hold a disposed texture.
   */
  private evictToBudget(keep?: string): void {
    for (const key of [...this.map.keys()]) {
      if (this.total <= this.budgetBytes) break;
      if (key === keep) continue;
      const entry = this.map.get(key)!;
      this.map.delete(key);
      this.total -= entry.bytes;
      this.dispose(entry.value);
    }
  }
}
