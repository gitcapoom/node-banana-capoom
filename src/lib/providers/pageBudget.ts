/**
 * A time budget for paginating a provider's model list.
 *
 * Both provider listings were capped at 15 pages "to avoid timeout". A page
 * count is the wrong guard: it does not measure the thing it is protecting
 * against, and it truncates SILENTLY. Measured 2026-08-21 — Replicate returns
 * 25 models per page and has 1500+ models, so 15 pages showed 375 of them and
 * nothing said so; fal happened to need exactly 15 pages, so it fit by one page
 * and would have started truncating the moment fal added more.
 *
 * A deadline guards the actual risk (a slow request tree), keeps a generous
 * page ceiling only as a runaway backstop, and reports truncation instead of
 * hiding it. The aggregator caches results for 24h, so paying a few extra
 * seconds once a day to see the whole catalogue is a good trade.
 */
export interface PageBudget {
  /** True while there is time and headroom left to fetch another page. */
  canContinue(): boolean;
  /** Call after each page is fetched. */
  countPage(): void;
  /** True when the loop stopped early — i.e. the list is incomplete. */
  exhausted(): boolean;
  pagesFetched(): number;
}

/** Generous ceiling; only a runaway guard, not the real limit. */
const MAX_PAGES = 200;
/** Long enough for a full catalogue walk, short enough not to hang a request. */
const DEFAULT_BUDGET_MS = 25_000;

export function createPageBudget(budgetMs: number = DEFAULT_BUDGET_MS): PageBudget {
  const started = Date.now();
  let pages = 0;
  let stoppedEarly = false;

  return {
    canContinue() {
      if (pages >= MAX_PAGES || Date.now() - started > budgetMs) {
        stoppedEarly = true;
        return false;
      }
      return true;
    },
    countPage() {
      pages++;
    },
    exhausted() {
      return stoppedEarly;
    },
    pagesFetched() {
      return pages;
    },
  };
}
