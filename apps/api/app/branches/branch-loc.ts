import { BranchStatus } from "@repo/api/src/types/branch";
import { isLocEnriched } from "@repo/lib/branches/loc-per-dollar";
import type { BranchFileChangeTotals } from "./branch-read-service/file-change-totals-read";

/**
 * Branch changed-LOC (lines-of-change) resolution for the Branches read service.
 *
 * These helpers are the SSOT for turning folded file-cache diff counts and
 * connected-PR diff stats into the branch's changed-LOC totals — the numbers the detail
 * Value-per-$ card and the analytics Median PR size KPI read. They are kept in
 * this sibling module (not `branch-read-service.ts`) so the
 * cohesive LOC logic and its focused tests live together and the service file
 * stays smaller (FEA-4229; whitlockk / codex review). Every helper preserves null —
 * it never fabricates a count — so an un-enriched or partial cache reads as
 * unavailable rather than as a bogus zero/partial size.
 */

export type LocTotals = {
  additions: number | null;
  deletions: number | null;
  filesChanged: number | null;
};

export type PullRequestLocDetail = {
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
};

/**
 * Resolve the branch's CURRENT file-cache LOC totals, gating on cache currency.
 *
 * `refreshBranchFileChangeCache` deliberately PRESERVES the previous file-change
 * rows and leaves `fileCacheHeadSha` on the OLD sha when a refresh for a new
 * `headSha` fails or is still pending (file-cache-service.ts `markCacheRefreshFailed`
 * clears neither the rows nor the sha). So a non-empty file-change cache is NOT
 * proof the totals describe the branch's current head — they may be a STALE prior
 * head's diff (davetho review). Summing those rows and treating any non-null pair
 * as "enriched/current" makes the list/detail LOC and the analytics median report
 * the old sha's size for the new head, disagreeing with GitHub again.
 *
 * The sums arrive already folded by {@link getBranchFileChangeTotals}, which
 * owns the all-or-nothing completeness rule (any un-enriched file makes the
 * whole dimension `null`). This function owns only the CURRENCY gate.
 *
 * This gates the file-cache totals on `fileCacheHeadSha === headSha`: only a cache
 * refreshed FOR the current head counts. A stale (old-sha) or never-synced (null
 * sha) cache reads as all-null — UNKNOWN — so downstream `resolveDetailLoc` falls
 * back to the connected PR's diff stats (display) and `analyticsPullRequestSize`
 * excludes the branch from the median rather than folding in a stale size. A branch
 * with no head sha at all (never pushed) likewise cannot match, so it reads UNKNOWN.
 */
export function currentFileTotals(
  totals: BranchFileChangeTotals,
  fileCacheHeadSha: string | null,
  headSha: string | null,
  fileCacheCapped = false
): LocTotals {
  if (!(headSha && fileCacheHeadSha) || fileCacheHeadSha !== headSha) {
    return { additions: null, deletions: null, filesChanged: null };
  }
  // ISS-10298: the sums now arrive from their OWN statement, so the row's claim
  // that its cache is current is not by itself evidence that THESE rows are the
  // ones it was claiming about. A refresh committing between the two reads is
  // what this catches; `headSha` is also null when the fold saw rows for more
  // than one head, which is the same unknown.
  if (totals.headSha !== fileCacheHeadSha) {
    return { additions: null, deletions: null, filesChanged: null };
  }
  // ISS-6127: a CAPPED cache is fresh and its rows are individually complete, so
  // every per-file guard passes and the sum comes out confident and short. The
  // provider withheld files it will not name, which makes the branch's LOC
  // UNKNOWN in exactly the sense this function already models for a stale cache
  // — so it takes the same exit, and every consumer downstream (the median, the
  // LOC/$ numerator and its paired denominator, the display fallback) inherits
  // the right answer without learning a second vocabulary.
  if (fileCacheCapped) {
    return { additions: null, deletions: null, filesChanged: null };
  }
  if (totals.fileCount === 0) {
    return { additions: null, deletions: null, filesChanged: null };
  }
  return {
    additions: totals.additions,
    deletions: totals.deletions,
    filesChanged: totals.fileCount,
  };
}

/**
 * The per-branch size feeding the shared medianPrSize KPI. FEA-3334: sourced from
 * the branch file-cache line totals (additions + deletions), the SAME basis the
 * desktop producer (apps/desktop/src/main/branch/branch-analytics-projection.ts
 * `projectBranchAnalytics`) and the Delivery SSOT (apps/api/app/insights/service.ts
 * `lineTotalsByBranch`) use — NOT the PR's reported additions/deletions. A PR's
 * line counts fold in merge commits and base-diff churn, so they frequently differ
 * from the file-cache LOC; preferring them made the ONE shared card compute a
 * different median on web than on desktop for the same merged branches. An
 * un-enriched merged branch (either file-cache line count still null → UNKNOWN
 * size) returns null so it is EXCLUDED from the median rather than folded in as 0
 * (which would drag the median toward 0), matching the desktop producer's
 * enriched-only filter and getDelivery's enriched-PR median.
 */
export function analyticsPullRequestSize(
  status: BranchStatus,
  fileTotals: { additions: number | null; deletions: number | null }
): number | null {
  if (status !== BranchStatus.Merged) {
    return null;
  }
  if (!isLocEnriched(fileTotals)) {
    return null;
  }
  return fileTotals.additions + fileTotals.deletions;
}

/**
 * Resolve the detail view's changed-LOC (FEA-4229). The branch's own file-cache
 * totals win when enriched (both line counts present — the SSOT the analytics
 * median also uses). When the file-cache is un-enriched but the connected PR
 * detail carries diff stats (e.g. a merged PR whose `additions`/`deletions` came
 * from the provider), those PR totals backfill the detail so Value-per-$ can
 * compute instead of rendering a bare dash. This mirrors the frontend
 * `usePreferredBranchLoc` "local fallback" contract (both line counts required,
 * never a half-populated pair). Returns real numbers or preserves null — never
 * fabricates a count.
 *
 * FEA-4268 — the list view's `toBranchRow` now ALSO resolves its DISPLAYED
 * `additions`/`deletions` through this precedence, so the list and detail show the
 * same reconciled count. The analytics median (`analyticsPullRequestSize`) still
 * stays STRICTLY on the file-cache basis, and the list row surfaces those raw
 * file-cache totals separately as `analyticsAdditions`/`analyticsDeletions` for the
 * client-side KPIs — so the PR backfill here reaches DISPLAY only, never the
 * file-cache analytics basis, preserving cross-surface parity with the desktop
 * producer.
 */
export function resolveDetailLoc(
  fileTotals: LocTotals,
  pr: PullRequestLocDetail | null
): LocTotals {
  if (isLocEnriched(fileTotals)) {
    return fileTotals;
  }
  if (pr && pr.additions != null && pr.deletions != null) {
    return {
      additions: pr.additions,
      deletions: pr.deletions,
      filesChanged: pr.changedFiles ?? fileTotals.filesChanged,
    };
  }
  return fileTotals;
}
