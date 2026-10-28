import {
  type BranchAnalytics,
  BranchKpiState,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import type { BranchListMetricBundle } from "@repo/api/src/types/branch-metrics";
import type { GitHubPRState } from "@repo/api/src/types/github";
import { median } from "@repo/api/src/utils/math";
import { canonicalSpendKpis } from "@repo/lib/branches/branch-canonical-spend-kpis";
import {
  derivePrLifecycle,
  PrLifecycle,
  type PrLifecycleCounts,
} from "@repo/lib/branches/branch-lifecycle-count";
import { setAppSpanAttributes } from "@repo/observability/tracing/spans";
import { branchKpi } from "./branch-kpi-factory";

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
  /** True when the selected PR is only one member of an ambiguous associated set. */
  multiPrWarning: boolean;
  prState: GitHubPRState | null;
  // FEA-4333: the owned current PR's merge evidence. Paired with `prState`, it
  // feeds `derivePrLifecycle` so a stale-open-but-merged PR (prState OPEN +
  // mergedAt set) classifies as merged, not active — with `mergedAt` taking
  // precedence over the stale state (GitHub semantics).
  mergedAt: Date | null;
  additions: number | null;
  deletions: number | null;
  prSize: number | null;
};

export function buildBranchAnalytics({
  metrics,
}: {
  metrics: BranchAnalyticsMetrics[];
}): BranchAnalytics {
  // Empty corpus (no branches) → the count KPIs below are Unavailable ("no
  // data"), never a fabricated 0. This matches the desktop producer
  // (apps/desktop/src/main/branch/branch-analytics-projection.ts, which gates
  // each count on `items.length > 0`) so the ONE shared BranchAnalytics card
  // agrees on both surfaces (FEA-3333). A count of 0 over a NON-empty corpus
  // stays a real, Available 0 (e.g. everything merged).
  const branchCount = metrics.length;
  setAppSpanAttributes({
    "branches.analytics.kpi_fold.branch_count": branchCount,
  });
  // FEA-4333: classify each branch's connected PR through ONE signal — the
  // connected PR state resolved with MERGE EVIDENCE (a non-null `mergedAt`) taking
  // precedence over a stale `prState`. For single-PR outcome math, ISS-5551 keeps
  // multi-PR rows out of the decided/merged cohorts because the selected PR is not
  // authoritative for the branch's full PR lifecycle.
  const prMetrics = summarizePrMetrics(metrics);
  const prLifecycleCounts = prMetrics.singlePrLifecycleCounts;
  // Merge-RATE denominator: DECIDED branches — those whose connected PR reached a
  // terminal outcome (MERGED or CLOSED). A still-open PR has no outcome yet, so
  // counting it would conflate "not merged yet" with "won't merge" and
  // understate the rate. This aligns the cloud producer with the desktop
  // producer (apps/desktop/src/main/branch/branch-analytics-projection.ts
  // `projectBranchAnalytics`, `merged / decided`, FEA-2942) so the ONE shared
  // branches-summary-cards card cannot show two different numbers for the same
  // corpus (FEA-2943). This fold receives selected-PR metrics only; list
  // re-projection reads BranchRow.multiPrWarning from the canonical row
  // projector before excluding ambiguous multi-PR branches.
  const decidedCount = prLifecycleCounts.merged + prLifecycleCounts.closed;
  // "Merged PRs" COUNT KPI: branches whose connected PR is MERGED — merge
  // evidence (`mergedAt`) or a MERGED state won (FEA-4333/FEA-3089). Shared with
  // the desktop producer via the same lifecycle classifier, so the
  // "Merged PRs" number matches on web and desktop and a stale-open PR carrying
  // `mergedAt` is counted merged on both. Reuses the same bucket that feeds the
  // merge-rate numerator, so the count and the rate's numerator cannot disagree
  // (FEA-2997).
  const mergedPrCount = prLifecycleCounts.merged;
  const medianPrSizes = prMetrics.singlePrSizes;
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
    // active, so it is EXCLUDED here (the double-count fix).
    activePrCount: branchKpi(branchCount > 0 ? prMetrics.activePrCount : null),
    mergedCount: branchKpi(branchCount > 0 ? mergedPrCount : null),
    leadTimeForChangeMs: branchKpi(null, BranchKpiState.Gated),
    // Filled from the canonical cards by `withCanonicalSpendKpis` once they exist.
    locPerDollar: branchKpi(null),
    totalSpendUsd: branchKpi(null),
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

function summarizePrMetrics(metrics: readonly BranchAnalyticsMetrics[]): {
  activePrCount: number;
  singlePrLifecycleCounts: PrLifecycleCounts;
  singlePrSizes: number[];
} {
  const singlePrLifecycleCounts: PrLifecycleCounts = {
    active: 0,
    merged: 0,
    closed: 0,
  };
  const singlePrSizes: number[] = [];
  let activePrCount = 0;
  for (const metric of metrics) {
    const lifecycle = derivePrLifecycle(metric);
    if (lifecycle === PrLifecycle.Active) {
      activePrCount += 1;
    }
    if (metric.multiPrWarning) {
      continue;
    }
    if (lifecycle !== null) {
      singlePrLifecycleCounts[lifecycle] += 1;
    }
    if (metric.prSize !== null) {
      singlePrSizes.push(metric.prSize);
    }
  }
  return { activePrCount, singlePrLifecycleCounts, singlePrSizes };
}

/** ISS-12346: the two spend-based KPIs are the cards' own figures, not a second derivation. */
export function withCanonicalSpendKpis(
  analytics: BranchAnalytics,
  canonicalMetrics: BranchListMetricBundle
): BranchAnalytics {
  return { ...analytics, ...canonicalSpendKpis(canonicalMetrics) };
}
