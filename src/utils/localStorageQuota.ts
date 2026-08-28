/**
 * localStorage writes that can survive a full store.
 *
 * The failure this exists for: `node-banana-models-cache` grew until the origin
 * had no room left, and the write that reported the error was
 * `node-banana-workflow-configs` — a few hundred bytes of project paths that had
 * nothing to do with filling it. Quota is per ORIGIN, not per key, so the
 * casualty is whichever writer runs next, and the caches that caused it swallow
 * their own failures silently.
 *
 * Two ideas make that recoverable:
 *
 *   1. Some keys are DISPOSABLE — pure caches, rebuildable from the server at
 *      the cost of one request. They are named here.
 *   2. A critical write may reclaim their space rather than fail.
 *
 * `localStorage` measures UTF-16 code units, so a string costs roughly twice its
 * byte length against the quota. A 3.2 MB JSON catalogue therefore needs ~6.5 MB
 * of a typical 5 MB budget and can never be stored at all.
 */

/**
 * Caches that may be dropped to make room. Order matters: the biggest and most
 * cheaply rebuilt first.
 */
const DISPOSABLE_CACHE_KEYS = [
  "node-banana-models-cache",
  "node-banana-schema-cache-v3",
] as const;

/** DOMException name/code varies across browsers; Firefox uses its own name. */
export function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: number; name: string };
  return (
    e.name === "QuotaExceededError" ||
    e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    e.code === 22 ||
    e.code === 1014
  );
}

/** Approximate bytes this key occupies against the quota (UTF-16). */
export function storedBytes(key: string): number {
  if (typeof window === "undefined") return 0;
  const v = localStorage.getItem(key);
  return v ? (key.length + v.length) * 2 : 0;
}

/** Total approximate bytes this origin is using. */
export function totalStoredBytes(): number {
  if (typeof window === "undefined") return 0;
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k) total += storedBytes(k);
  }
  return total;
}

/**
 * Write a value that matters, reclaiming disposable cache space if the store is
 * full. Throws only when the write still cannot succeed with every disposable
 * cache dropped — at which point the value genuinely does not fit and the caller
 * should surface that rather than pretend it saved.
 */
export function setItemReclaiming(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, value);
    return;
  } catch (err) {
    if (!isQuotaError(err)) throw err;
  }

  for (const cacheKey of DISPOSABLE_CACHE_KEYS) {
    if (cacheKey === key) continue;
    const freed = storedBytes(cacheKey);
    if (!freed) continue;
    localStorage.removeItem(cacheKey);
    console.warn(
      `[storage] quota hit writing "${key}"; dropped cache "${cacheKey}" ` +
      `(~${(freed / 1024 / 1024).toFixed(1)} MB) and retrying`,
    );
    try {
      localStorage.setItem(key, value);
      return;
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      // Still full — fall through and drop the next cache.
    }
  }

  throw new Error(
    `localStorage is full and "${key}" (${((key.length + value.length) * 2 / 1024).toFixed(0)} KB) ` +
    `could not be stored even after clearing every disposable cache. ` +
    `Origin usage: ~${(totalStoredBytes() / 1024 / 1024).toFixed(1)} MB.`,
  );
}

/**
 * Store into a disposable cache. Never throws — a cache that cannot be written
 * is a missed optimisation, not an error — but it says so, because silently
 * swallowing this is exactly how the store filled up unnoticed.
 */
export function setDisposableCache(key: string, value: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    console.warn(
      `[storage] could not cache "${key}" ` +
      `(~${((key.length + value.length) * 2 / 1024 / 1024).toFixed(1)} MB): quota exceeded. ` +
      `Continuing without the cache.`,
    );
    return false;
  }
}
