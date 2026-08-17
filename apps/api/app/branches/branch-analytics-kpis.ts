import {
  type BranchAnalytics,
  BranchKpiState,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import type { GitHubPRState } from "@repo/api/src/types/github";
import { median } from "@repo/api/src/utils/math";
import { countPrLifecycle } from "@repo/lib/branches/branch-lifecycle-count";
import {
  isAnomalousSpendTotal,
  reportableSpendUsd,
} from "@repo/lib/branches/spend-kpi";
import { log } from "@repo/observability/log";
import { sumLocEnrichedSpend } from "@/app/branches/branch-cost-attribution";
import { branchKpi } from "./branch-kpi-factory";
import { sumEnrichedChurn } from "./branch-loc";
import {
  type SessionUsage,
  sumDistinctSessionUsage,
} from "./branch-read-service/session-usage-window";

/**
 * The cloud `getBranchAnalytics` KPI fold (ISS-4737 extraction): given the
 * already-materialized per-branch metrics and the windowed/lifetime session
 * usage maps, produce the ONE shared `BranchAnalytics` payload the summary-card
 * row renders. Split out of `branch-read-service.ts` so the query orchestration
 * (candidate ids, row select, usage reads) and the KPI derivation are separate
 * responsibilities — the derivation is the half that must stay in lockstep with
 * the desktop producer (`apps/desktop/src/main/branch/branch-analytics-projection.ts`)
 * and the client re-projection (`packages/app/branches/lib/filtered-branch-analytics.ts`).
 */

/** Per-branch KPI inputs folded by {@link buildBranchAnalytics}. */
export type BranchAnalyticsMetrics = {
  /** Branch artifact id — keys this branch's sessions in `usageByBranch`. */
  id: string;
  status: BranchStatus;
  prState: GitHubPRState | null;
  // FEA-4333: the owned current PR's merge evidence. Paired with `prState`, it
  // feeds `countPrLifecycle` so a stale-open-but-merged PR (prState OPEN +
  // mergedAt set) classifies as merged, not active — with `mergedAt` taking
  // precedence over the stale state (GitHub semantics).
  mergedAt: Date | null;
  additions: number | null;
  deletions: number | null;
  prSize: number | null;
};

export function buildBranchAnalytics({
  organizationId,
  metrics,
  usageByBranch,
  lifetimeUsageByBranch,
}: {
  /** Owning org — the actionable dimension on the corrupt-spend warning below. */
  organizationId: string;
  metrics: BranchAnalyticsMetrics[];
  /** Windowed per-branch session usage — the AI-spend headline's population. */
  usageByBranch: Map<string, SessionUsage>;
  /** Lifetime per-branch session usage — the LOC/$ denominator's population. */
  lifetimeUsageByBranch: Map<string, SessionUsage>;
}): BranchAnalytics {
  // Empty corpus (no branches) → the count KPIs below are Unavailable ("no
  // data"), never a fabricated 0. This matches the desktop producer
  // (apps/desktop/src/main/branch/branch-analytics-projection.ts, which gates
  // each count on `items.length > 0`) so the ONE shared BranchAnalytics card
  // agrees on both surfaces (FEA-3333). A count of 0 over a NON-empty corpus
  // stays a real, Available 0 (e.g. everything merged).
  const branchCount = metrics.length;
  // FEA-4333: the PR-lifecycle KPIs (active-PR count, merged count, merge rate)
  // classify each branch's connected PR through ONE signal — the connected PR
  // state resolved with MERGE EVIDENCE (a non-null `mergedAt`) taking precedence
  // over a stale `prState`. `countPrLifecycle` buckets each connected PR into
  // exactly one of {active, merged, closed}, so a stale-open-but-merged PR
  // (prState OPEN + mergedAt set) lands ONLY in merged and can never be counted
  // as active too. Previously `activePrCount` counted raw `prState === Open`
  // independently of the merged count, so that same PR was both "active" and
  // (once GitHub confirmed the merge) merged — the double-classification bug this
  // fixes. A branch with no connected PR is in no bucket, preserving the "Merged
  // PRs" contract that a no-connected-PR local-status merge is not a Merged PR
  // (FEA-3089).
  const prLifecycleCounts = countPrLifecycle(metrics);
  // Merge-RATE denominator: DECIDED branches — those whose connected PR reached a
  // terminal outcome (MERGED or CLOSED). A still-open PR has no outcome yet, so
  // counting it would conflate "not merged yet" with "won't merge" and
  // understate the rate. This aligns the cloud producer with the desktop
  // producer (apps/desktop/src/main/branch/branch-analytics-projection.ts
  // `projectBranchAnalytics`, `merged / decided`, FEA-2942) so the ONE shared
  // branches-summary-cards card cannot show two different numbers for the same
  // corpus (FEA-2943). multiPrWarning is structurally false on this producer
  // (one owned/current PR per branch), matching desktop's !multiPrWarning
  // exclusion.
  const decidedCount = prLifecycleCounts.merged + prLifecycleCounts.closed;
  // "Merged PRs" COUNT KPI: branches whose connected PR is MERGED — merge
  // evidence (`mergedAt`) or a MERGED state won (FEA-4333/FEA-3089). Shared with
  // the desktop producer via the same `countPrLifecycle` classifier, so the
  // "Merged PRs" number matches on web and desktop and a stale-open PR carrying
  // `mergedAt` is counted merged on both. Reuses the same bucket that feeds the
  // merge-rate numerator, so the count and the rate's numerator cannot disagree
  // (FEA-2997).
  const mergedPrCount = prLifecycleCounts.merged;
  const medianPrSizes = metrics
    .map((metric) => metric.prSize)
    .filter((value): value is number => value !== null);
  // AI spend: the DEDUPED captured cost across every branch-linked session,
  // counted ONCE no matter how many branches it touched. Folding the
  // per-branch attribution map here counted a shared session once per branch
  // and inflated the headline (the desktop producer fixed the same bug).
  const metricIds = new Set(metrics.map((metric) => metric.id));
  const cohortUsageByBranch = new Map(
    [...usageByBranch].filter(([branchId]) => metricIds.has(branchId))
  );
  const totalSpend =
    sumDistinctSessionUsage(cohortUsageByBranch).estimatedCostUsd;
  // Value per $ = total code CHURN ÷ enriched spend, computed identically to
  // the desktop producer (apps/desktop/src/main/branch-analytics-projection.ts
  // `projectBranchAnalytics`) so the ONE shared card matches on both surfaces
  // Churn is additions + DELETIONS — removed lines are work delivered, so
  // they ADD to the numerator; it is deliberately gross, not net.
  // Summed over LOC-enriched branches only: an un-enriched branch has UNKNOWN
  // LOC, and `sumLocEnrichedSpend` likewise keeps only the enriched share of
  // each session's even-split cost, so numerator and denominator cover the
  // same set of branches.
  // ISS-4632: the denominator reads `lifetimeUsageByBranch` (lifetime spend),
  // NOT the windowed `usageByBranch`, so it matches the lifetime-churn
  // numerator and narrowing the window no longer shrinks only the denominator.
  // ISS-4689 deliberately does NOT thread a global divisor in here — this
  // producer keeps the in-set count (the divisor is the branches inside
  // `metrics`). The window-independence fix lands on the LIST path, whose
  // divisor read is bounded by one page's session ids, and reaches the card
  // over the wire as `sessionBranchCount`.
  //
  // Why this path is exempt rather than neglected (review of #4244's predecessor):
  //   1. The only consumer that RENDERS this server value is the branch-detail
  //      Value-per-$ baseline (`branch-headline-cards.tsx` `baseline=`), fed by
  //      `useBranchAnalytics({})` — no filters, no date window. Unwindowed, the
  //      corpus IS the whole org, so the global count and the in-set count are
  //      the same number by construction; a global divisor would be a no-op.
  //   2. Every WINDOWED analytics request comes from the branches list, whose
  //      card re-derives `locPerDollar` in `deriveFilteredBranchAnalytics` and
  //      overrides whatever this producer returned, on web and desktop alike.
  // So a corpus-wide divisor read here could not change a rendered number.
  //
  // It could, however, cost the route: unlike the list path's page-bounded
  // read, this covers the whole filtered corpus, so it was an unbounded
  // `ceil(sessions / 1000)` sequential `artifactLink` scan on every analytics
  // request with any enriched branch — a serverless timeout on a large tenant
  // (wongk). Dropping it restores this path to fixed query cardinality.
  // Revisit only alongside a consumer that renders a WINDOWED server-side
  // `locPerDollar` without re-deriving it, and then via a set-based grouped
  // count, not a row scan.
  const { enrichedCount, churn: totalChurn } = sumEnrichedChurn(metrics);
  const locEnrichedSpend =
    sumLocEnrichedSpend(metrics, lifetimeUsageByBranch) ?? 0;
  // A negative / NaN / infinite total is IMPOSSIBLE from correct inputs — it
  // means corrupt persisted session cost or a broken pricing read upstream.
  // `reportableSpendUsd` below still collapses it to the graceful `null` the
  // card renders as "No data", but collapsing SILENTLY would make corrupt data
  // indistinguishable from an unpriced corpus (chatgpt-codex, #4244), so the
  // anomaly is reported first — with the org and the offending value, the
  // dimensions needed to find the rows. `log.warn` is the Datadog-exported
  // logger every other bad-data signal in this directory uses (see
  // `session-branch-divisor.ts`'s branch-count drift warning).
  if (isAnomalousSpendTotal(totalSpend)) {
    log.warn("branch_analytics_spend_total_invalid", {
      organizationId,
      totalSpendUsd: totalSpend,
      branchCount,
    });
  }
  return {
    viewerScope: BranchViewerScope.Organization,
    medianPrSize: branchKpi(median(medianPrSizes)),
    // Rate numerator reuses mergedPrCount (the merged PR-lifecycle bucket) — the
    // same cross-surface-parity population feeding the "Merged PRs" count — so
    // the rate's numerator and that count can never disagree, mirroring the
    // desktop producer, which feeds both from one merged set (FEA-2997/FEA-2943).
    mergeRate: branchKpi(
      decidedCount === 0 ? null : (mergedPrCount / decidedCount) * 100
    ),
    medianTimeToMergeMs: branchKpi(null, BranchKpiState.Gated),
    // Active-PR count: branches whose connected PR is an active OPEN PR
    // (FEA-4333) — a stale-open PR carrying `mergedAt` classifies as merged, not
    // active, so it is EXCLUDED here (the double-count fix). Mutually exclusive
    // with mergedCount by construction: `countPrLifecycle` puts each connected PR
    // in exactly one bucket.
    activePrCount: branchKpi(branchCount > 0 ? prLifecycleCounts.active : null),
    mergedCount: branchKpi(branchCount > 0 ? mergedPrCount : null),
    leadTimeForChangeMs: branchKpi(null, BranchKpiState.Gated),
    locPerDollar: branchKpi(
      enrichedCount > 0 && locEnrichedSpend > 0
        ? totalChurn / locEnrichedSpend
        : null
    ),
    // ISS-4737: the null-on-zero rule is the SHARED `reportableSpendUsd`
    // predicate, so the desktop producer and the client-side filtered
    // re-projection cannot render `$0` for a corpus this producer calls
    // no-data.
    totalSpendUsd: branchKpi(reportableSpendUsd(totalSpend)),
    // Active branches: canonical branch STATUS not merged/closed — a broader,
    // orthogonal population than active PRs (a branch with a draft PR or no PR
    // is an active branch but not an active PR). The canonical status already
    // resolves merge evidence (via `deriveBranchMergedState`), so a stale-open
    // PR carrying `mergedAt` has status Merged and is correctly excluded here.
    activeBranchCount: branchKpi(
      branchCount > 0
        ? metrics.filter(
            (metric) =>
              metric.status !== BranchStatus.Merged &&
              metric.status !== BranchStatus.Closed
          ).length
        : null
    ),
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: BranchKpiState.Unavailable,
    },
  };
}
