import {
  type BranchAnalytics,
  type BranchKpi,
  BranchKpiState,
  type BranchRow,
  BranchStatus,
  BranchViewerScope,
  NO_BRANCH_KPI_BASELINE,
} from "@repo/api/src/types/branch";
import { median } from "@repo/api/src/utils/math";
import { countPrLifecycle } from "@repo/lib/branches/branch-lifecycle-count";
import {
  isLocEnriched,
  sumEvenSplitEnrichedSpend,
} from "@repo/lib/branches/loc-per-dollar";
import { reportableSpendUsd } from "@repo/lib/branches/spend-kpi";

/**
 * Desktop main-side branch analytics projection (FEA-1948 / Epic B B6).
 *
 * Like the usage projector, the surface-agnostic derivations in `@repo/app`
 * aren't reachable under the main process's `nodenext` resolution, so the KPI
 * math lives here. Net-new metrics that the local corpus CAN compute (merge
 * rate; total AI spend; active-branch count; active/merged PR counts; median PR
 * size and LOC/$ once FEA-1899 populates lines-changed) are `available`; metrics
 * that genuinely need GitHub timing (time-to-merge, lead time) are `gated` so the
 * cards render the connect-GitHub affordance rather than a fabricated number.
 *
 * `activePrCount` (branches whose captured PR state is OPEN) and `mergedCount`
 * (branches whose status is merged) are computed here from the same local
 * `pr_state`/branch-status rows the web producer uses
 * (`apps/api/app/branches/branch-read-service.ts` `getBranchAnalytics`), so the
 * ONE shared BranchAnalytics card (`packages/app/branches/components/
 * branches-summary-cards.tsx`) shows a real number on both surfaces rather than a
 * number on the web and a connect-GitHub "—" on desktop for the same metric
 * (FEA-2950). These counts do NOT need GitHub enrichment — the desktop already
 * derives `mergeRate` and `activeBranchCount` from these same local rows.
 */

// ISS-4686: no 30-day baseline is computed on this surface either. The shared
// `NO_BRANCH_KPI_BASELINE` keeps both producers on one literal, and the day
// either wires a real baseline `BranchKpiWithBaseline` REQUIRES its
// `comparisonScope` — so a corpus aggregate can never reach the branch-detail
// cards as a per-branch verdict from desktop any more than from cloud.
function available(value: number): BranchKpi {
  return {
    value,
    state: BranchKpiState.Available,
    ...NO_BRANCH_KPI_BASELINE,
  };
}

function gated(): BranchKpi {
  return {
    value: null,
    state: BranchKpiState.Gated,
    ...NO_BRANCH_KPI_BASELINE,
  };
}

function unavailable(): BranchKpi {
  return {
    value: null,
    state: BranchKpiState.Unavailable,
    ...NO_BRANCH_KPI_BASELINE,
  };
}

/** A priced figure → KPI: a real number is `available`, a `null` is `unavailable`. */
function pricedKpi(value: number | null): BranchKpi {
  if (value == null) {
    return unavailable();
  }
  return available(value);
}

/** A branch carries FEA-1899 LOC enrichment once BOTH line counts have landed. */
export function isLocEnrichedRow(
  row: BranchRow
): row is BranchRow & { additions: number; deletions: number } {
  return isLocEnriched(row);
}

/**
 * The LOC-per-$ DENOMINATOR: captured cost even-split-attributed to the
 * LOC-enriched branches. The apportionment (FEA-2032 even-split) is the shared
 * `sumEvenSplitEnrichedSpend` kernel — the same one the web producer adapts into
 * (apps/api/app/branches/branch-read-service.ts), so the two surfaces cannot
 * re-diverge. This adapter owns only desktop's per-session cost map: captured
 * cost SUMMED across a session's model rows, with un-priced rows (`null`) dropped
 * so they never inflate the denominator (matching the dashboard's stored-cost
 * basis). Dropping un-priced rows is why an all-un-priced corpus returns `null`
 * (no map entry) rather than 0.
 */
/**
 * FEA-3695 — the AUTHORITATIVE per-session captured cost map surfaced on the
 * desktop list wire (`BranchListResponse.sessionCostUsd`). Sums a session's
 * per-model captured cost, dropping un-priced rows so an entirely un-priced
 * session is absent (priced-nothing → the client's `> 0` gate renders "—"),
 * exactly like the `sumLocEnrichedSpend` cost map below and the deduped total
 * spend read — so the client's filtered re-derivation cannot drift from the
 * headline. Keyed by the non-nullable `sessionId`, so a session shared by
 * multiple branches has ONE entry, never one per branch.
 */
export function sessionCostMapFromUsageRows(
  usageRows: ReadonlyArray<{
    sessionId: string;
    costUsdEstimated: number | null;
  }>
): Record<string, number> {
  const costBySession: Record<string, number> = {};
  for (const row of usageRows) {
    if (row.costUsdEstimated == null) {
      continue;
    }
    costBySession[row.sessionId] =
      (costBySession[row.sessionId] ?? 0) + row.costUsdEstimated;
  }
  return costBySession;
}

export function sumLocEnrichedSpend(
  items: BranchRow[],
  usageRows: ReadonlyArray<{
    sessionId: string;
    costUsdEstimated: number | null;
  }>,
  // ISS-4689 — each session's GLOBAL branch count, the window-independent
  // even-split divisor. Build it with `readGlobalBranchCountsForItems` over the
  // FULL local corpus (the un-windowed item set); omitted, the kernel falls back
  // to the in-set count and keeps the pre-ISS-4689 window-sensitivity.
  globalBranchCounts?: ReadonlyMap<string, number>
): number | null {
  const costBySession = new Map<string, number>();
  for (const row of usageRows) {
    if (row.costUsdEstimated == null) {
      continue;
    }
    costBySession.set(
      row.sessionId,
      (costBySession.get(row.sessionId) ?? 0) + row.costUsdEstimated
    );
  }
  return sumEvenSplitEnrichedSpend(
    items.map((item) => ({
      enriched: isLocEnrichedRow(item),
      sessionIds: item.sessionIds,
    })),
    costBySession,
    globalBranchCounts
  );
}

/**
 * Deduped, pre-priced spend the caller computes from the per-session usage read
 * (`readBranchUsageTokenRows`) — NOT from per-branch `estimatedCostUsd`. Per-branch
 * cost is ATTRIBUTION: a session linked to N branches contributes its full cost to
 * each of those N branches, so column-summing it over-counts every shared session
 * (the AI-spend inflation bug). These numbers count each session ONCE.
 */
export type BranchSpendInput = {
  /** Deduped priced cost across ALL branch-linked sessions — the AI-spend KPI. */
  totalSpendUsd: number | null;
  /**
   * The LOC-per-$ denominator: captured cost EVEN-SPLIT-attributed to the
   * LOC-enriched branches (`sumLocEnrichedSpend`). A session split across an
   * enriched and an un-enriched branch contributes only its enriched fraction,
   * so spend with no LOC to offset it stays out of the ratio. A 0-LOC enriched
   * branch still counts (known-zero LOC); an un-enriched branch never does.
   */
  locEnrichedSpendUsd: number | null;
};

export function projectBranchAnalytics(
  items: BranchRow[],
  spend: BranchSpendInput
): BranchAnalytics {
  // Merge rate = merged / decided, computed from local PR lifecycle. FEA-2942:
  // the denominator is DECIDED branches (PR MERGED or CLOSED), NOT every branch
  // that has a PR — a still-open PR has no terminal outcome yet, so counting it
  // against the rate conflates "not merged yet" with "won't merge" and
  // understates the number (the Insights "Merge rate" KPI has the same fix).
  // Multi-PR branches are excluded (their lifecycle is ambiguous — the row only
  // carries the latest PR's state), matching the median-PR-size exclusion below.
  const decided = items.filter(
    (row) =>
      (row.prState === "MERGED" || row.prState === "CLOSED") &&
      !row.multiPrWarning
  );
  const merged = items.filter(
    (row) => row.prState === "MERGED" && !row.multiPrWarning
  );
  const mergeRate =
    decided.length > 0
      ? available((merged.length / decided.length) * 100)
      : unavailable();

  // Median PR size (additions + deletions) over MERGED, single-PR branches whose
  // LOC is ENRICHED — i.e. BOTH line counts are populated. Un-enriched rows (size
  // not yet fetched) are EXCLUDED, not folded in as 0.
  //
  // FEA-2949: this is the single PR-size definition shared with the Desktop
  // Delivery dashboard (`apps/api`-shaped `local-insights.ts`, FEA-2868, which
  // medians enriched PR LOC ONLY) and the surface-agnostic `medianPrSize` helper
  // in `@repo/app/branches/lib/branch-derivations`. Previously this projection
  // 0-padded un-enriched rows (`(additions ?? 0) + (deletions ?? 0)`, FEA-2159),
  // which DISAGREED with the dashboard on the same machine: folding an un-enriched
  // merged PR in as 0 dragged the Branches median toward 0 while the dashboard
  // (and the shared helper) excluded it, so the "Median PR size" card showed
  // materially different numbers across surfaces. Completing FEA-2181's intent,
  // the two surfaces now use ONE rule (enriched-only) and agree. Multi-PR branches
  // stay excluded (ambiguous lifecycle — the row only carries the latest PR's
  // state), matching the merge-rate set. The KPI is unavailable when no merged,
  // single-PR, LOC-enriched branch exists (empty `sizes`).
  const sizes = items
    .filter(
      (row): row is BranchRow & { additions: number; deletions: number } =>
        row.status === BranchStatus.Merged &&
        !row.multiPrWarning &&
        isLocEnrichedRow(row)
    )
    .map((row) => row.additions + row.deletions);
  const medianPrSize =
    sizes.length > 0 ? available(median(sizes) ?? 0) : unavailable();

  // Value per $ = total code CHURN ÷ enriched spend — needs LOC enrichment AND
  // priced cost. The numerator is churn: additions + DELETIONS. Removed lines are
  // work delivered, so they ADD to the total; netting them out (the previous
  // formula) reported a large refactor as near-zero value and a pure deletion as
  // negative. Summed over LOC-enriched branches; the denominator
  // (`spend.locEnrichedSpendUsd`) is the captured cost EVEN-SPLIT-attributed to
  // those same enriched branches (`sumLocEnrichedSpend`), so a session split
  // across enriched and un-enriched branches contributes only its enriched share
  // — un-enriched spend with no LOC to offset it stays out of the ratio. The web
  // producer (`apps/api/app/branches/branch-read-service.ts` `getBranchAnalytics`)
  // computes this identically so the ONE shared card matches on both surfaces.
  const locRows = items.filter(isLocEnrichedRow);
  const totalChurn = locRows.reduce(
    (sum, row) => sum + row.additions + row.deletions,
    0
  );
  const totalCost = spend.locEnrichedSpendUsd ?? 0;
  const locPerDollar =
    locRows.length > 0 && totalCost > 0
      ? available(totalChurn / totalCost)
      : unavailable();

  // Total AI spend — the DEDUPED priced cost across every branch-linked session,
  // counted ONCE no matter how many branches it touched (so it reconciles with the
  // usage summary's `totalEstimatedCost` and the agent dashboard, instead of the
  // per-branch attribution sum that inflated this card). Unavailable (NOT $0) when
  // nothing prices, so the card shows "—" rather than implying free work.
  // ISS-4737: unavailable ALSO when the priced rows sum to exactly zero, via the
  // shared `reportableSpendUsd` rule the web producer and the client-side
  // filtered re-projection now call too — `sumStoredBranchCost` returns a real 0
  // for priced-but-zero rows, and rendering that as `$0` claimed the work was
  // free while the web producer reported the same corpus as no-data.
  const totalSpendUsd = pricedKpi(reportableSpendUsd(spend.totalSpendUsd));

  // Active branches — count still in progress (status not merged/closed). LOCAL:
  // derived from branch status, no GitHub PR state. A count of 0 over a non-empty
  // corpus is meaningful (everything merged), so only an empty corpus is
  // unavailable.
  const activeBranchCount =
    items.length > 0
      ? available(
          items.filter(
            (row) =>
              row.status !== BranchStatus.Merged &&
              row.status !== BranchStatus.Closed
          ).length
        )
      : unavailable();

  // FEA-4333: the active-PR count classifies each connected PR through the SAME
  // merge-evidence-first `countPrLifecycle` classifier the web producer uses, so a
  // stale-open-but-merged PR lands in the merged bucket, never `active` — the two
  // counts are mutually exclusive by construction. On desktop `row.prState` is
  // already merge-aware (`derivePrState` in `shared-branches-api.ts` resolves a
  // non-null `mergedAt`/`"merged"` state to MERGED before the row is built), so the
  // list row carries no separate `mergedAt` and the classifier reads it off the
  // already-resolved `prState` (`mergedAt: null` here).
  const prLifecycleCounts = countPrLifecycle(
    items.map((row) => ({ prState: row.prState, mergedAt: null }))
  );

  // Active-PR and merged counts — computed LOCALLY from the same captured
  // `pr_state`/branch-status rows the web producer uses (FEA-2950), so the shared
  // BranchAnalytics card shows a real number on both surfaces instead of a real
  // number on the web and a connect-GitHub "—" on desktop. `activePrCount` counts
  // branches whose connected PR is an active OPEN PR (distinct from
  // `activeBranchCount`, which counts branch STATUS ≠ merged/closed — a branch with
  // no PR or a draft PR is an active branch but not an active PR). `mergedCount`
  // reuses the very same `merged` array that feeds `mergeRate`'s numerator
  // (FEA-2997), so the "Merged PRs" count and the rate's numerator can never
  // disagree — both are merged, single-PR branches (`prState === "MERGED" &&
  // !multiPrWarning`), sharing the multi-PR ambiguous-lifecycle exclusion the
  // classifier-based active count does not apply. Neither needs GitHub enrichment.
  // An empty corpus is unavailable (matching the other count KPIs), never a
  // fabricated 0.
  const activePrCount =
    items.length > 0 ? available(prLifecycleCounts.active) : unavailable();
  const mergedCount =
    items.length > 0 ? available(merged.length) : unavailable();

  return {
    viewerScope: BranchViewerScope.Self,
    medianPrSize,
    mergeRate,
    medianTimeToMergeMs: gated(),
    activePrCount,
    mergedCount,
    leadTimeForChangeMs: gated(),
    locPerDollar,
    totalSpendUsd,
    activeBranchCount,
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: BranchKpiState.Unavailable,
    },
  };
}

/**
 * One session's even-split divisor, FLOORED AT 1 so a missing or zero count never
 * divides a cost by zero and a session on a single branch keeps its full cost.
 * The per-session counterpart to `readGlobalBranchCountsForItems` (which builds
 * the map from the pre-display link set); mirrors the cloud `sessionBranchCount` in
 * apps/api/app/branches/branch-cost-attribution.ts so the two surfaces floor the
 * divisor identically.
 */
export function sessionBranchCount(
  branchCounts: ReadonlyMap<string, number>,
  sessionId: string
): number {
  return Math.max(1, branchCounts.get(sessionId) ?? 1);
}
