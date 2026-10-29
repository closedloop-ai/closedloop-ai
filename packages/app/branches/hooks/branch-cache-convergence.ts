import {
  CacheConvergence,
  type CacheConvergenceContract,
  convergingPrefixes,
} from "../../shared/query/list-cache-convergence";
import { branchesKeys } from "./use-branches";

/**
 * ISS-9553 — how every branch cache family behaves when a live change event
 * flushes. The BranchesLiveBridge now derives its invalidation set from here.
 *
 * Classifying the whole key object is what surfaced the `lists` gap: the bridge
 * invalidated `usages`/`analyticsRoot`/`cohortAnalyticsRoot`/`pageDataRoot` and
 * omitted `lists`. A hand-maintained prefix list cannot notice a family it never
 * named; a total classification cannot omit it in the first place.
 *
 * `branchesKeys.list` is read only by the split path of `useBranchesPageData`,
 * which only the HTTP source takes, and that source exposes no `subscribe`; so
 * no list reader runs under a live source today.
 */
export const branchCacheConvergence: CacheConvergenceContract<
  typeof branchesKeys
> = {
  all: { prefix: CacheConvergence.Root },

  // Every one of these is derived from the local branch corpus, so any branch
  // change can move it: the table page, the summary, the filtered-cohort
  // metrics, and the KPI cards that read `pageData`.
  lists: { prefix: CacheConvergence.Always },
  list: { coveredBy: "lists" },
  usages: { prefix: CacheConvergence.Always },
  usage: { coveredBy: "usages" },
  analyticsRoot: { prefix: CacheConvergence.Always },
  analytics: { coveredBy: "analyticsRoot" },
  cohortAnalyticsRoot: { prefix: CacheConvergence.Always },
  cohortAnalytics: { coveredBy: "cohortAnalyticsRoot" },
  pageDataRoot: { prefix: CacheConvergence.Always },
  pageData: { coveredBy: "pageDataRoot" },

  // A scoped `{ branchId }` change refreshes that branch's detail, its lazily
  // fetched merged trace, and its comments; a broad change sweeps all three
  // prefixes. The trace and comments are first-class cache entries, so an open
  // Sessions & timeline tab would otherwise hold a stale trace until remount.
  details: { prefix: CacheConvergence.BroadOnly },
  detail: { coveredBy: "details" },
  traces: { prefix: CacheConvergence.BroadOnly },
  trace: { coveredBy: "traces" },
  commentsRoot: { prefix: CacheConvergence.BroadOnly },
  comments: { coveredBy: "commentsRoot" },

  listStatusOrdering: {
    prefix: CacheConvergence.Excluded,
    reason:
      "A statement of which ordering the producer is serving, not a read of the corpus. It is latched so a reader's list key is stable, and it owns its own renewal boundary in `served-status-ordering.ts`; invalidating it on every change would re-key the list mid-page and reset the reader's pagination to page 0, which is the instability it exists to prevent.",
  },
};

/**
 * Prefixes the branches bridge invalidates on every flush.
 *
 * Resolved on call, not at module scope, for the reason spelled out in the
 * sessions sibling: the bridge only ever read its key object from inside
 * `flush`, and hoisting that read turns any partial `vi.mock` of the hooks
 * module into an import-time throw for every file that loads the bridge.
 */
export function branchAlwaysConvergePrefixes() {
  return convergingPrefixes(
    branchesKeys,
    branchCacheConvergence,
    CacheConvergence.Always
  );
}

/** Prefixes the branches bridge sweeps wholesale on a BROAD change. */
export function branchBroadConvergePrefixes() {
  return convergingPrefixes(
    branchesKeys,
    branchCacheConvergence,
    CacheConvergence.BroadOnly
  );
}
