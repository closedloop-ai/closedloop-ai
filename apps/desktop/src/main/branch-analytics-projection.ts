import {
  type BranchAnalytics,
  type BranchKpi,
  BranchKpiState,
  type BranchRow,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";

/**
 * Desktop main-side branch analytics projection (FEA-1948 / Epic B B6).
 *
 * Like the usage projector, the surface-agnostic derivations in `@repo/app`
 * aren't reachable under the main process's `nodenext` resolution, so the KPI
 * math lives here. Net-new metrics that the local corpus CAN compute (merge
 * rate; total AI spend; active-branch count; median PR size and LOC/$ once
 * FEA-1899 populates lines-changed) are `available`; metrics that genuinely need
 * GitHub (active/merged PR counts, time-to-merge, lead time) are `gated` so the
 * cards render the connect-GitHub affordance rather than a fabricated number.
 */

function available(value: number): BranchKpi {
  return {
    value,
    state: BranchKpiState.Available,
    baseline30d: null,
    deltaPct: null,
  };
}

function gated(): BranchKpi {
  return {
    value: null,
    state: BranchKpiState.Gated,
    baseline30d: null,
    deltaPct: null,
  };
}

function unavailable(): BranchKpi {
  return {
    value: null,
    state: BranchKpiState.Unavailable,
    baseline30d: null,
    deltaPct: null,
  };
}

/** A priced figure → KPI: a real number is `available`, a `null` is `unavailable`. */
function pricedKpi(value: number | null): BranchKpi {
  if (value == null) {
    return unavailable();
  }
  return available(value);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

/** A branch carries FEA-1899 LOC enrichment once BOTH line counts have landed. */
export function isLocEnrichedRow(row: BranchRow): boolean {
  return row.additions != null && row.deletions != null;
}

/**
 * The LOC-per-$ DENOMINATOR: captured cost attributed to the LOC-enriched
 * branches, apportioning each session's cost EVENLY across the branches it
 * touched (FEA-2032 even-split) and keeping only the enriched-branch fraction.
 *
 * Why apportion rather than count a whole session whenever it touches one
 * enriched branch: a session that worked an enriched branch AND an un-enriched
 * one has only PART of its spend offset by known LOC. Counting its full cost
 * would drag un-enriched spend — money with no LOC to offset it — into the
 * denominator and deflate the ratio. The even-split share (enriched ÷ total
 * branches) keeps exactly the fraction that produced the LOC in the numerator.
 *
 * A 0-LOC enriched branch (both line counts present, net 0) IS counted — that's
 * KNOWN-zero LOC, distinct from an un-enriched branch's UNKNOWN LOC, which is
 * excluded. Returns `null` when no enriched branch carries any captured cost, so
 * the caller renders "—" rather than a misleading 0 (matching the priced-KPI
 * contract).
 */
export function sumLocEnrichedSpend(
  items: BranchRow[],
  usageRows: ReadonlyArray<{
    sessionId: string;
    costUsdEstimated: number | null;
  }>
): number | null {
  // Per session: how many distinct branches it touched, and how many of those
  // are LOC-enriched. `sessionIds` is already deduped per branch, so one pass
  // over the branch rows yields both counts (== the SQL even-split branch_count).
  const branchCount = new Map<string, number>();
  const enrichedCount = new Map<string, number>();
  for (const item of items) {
    const enriched = isLocEnrichedRow(item);
    for (const sessionId of item.sessionIds) {
      branchCount.set(sessionId, (branchCount.get(sessionId) ?? 0) + 1);
      if (enriched) {
        enrichedCount.set(sessionId, (enrichedCount.get(sessionId) ?? 0) + 1);
      }
    }
  }

  // Per session: captured cost summed across its model rows; un-priced rows
  // (`null`) are skipped so they never inflate the denominator (matching the
  // dashboard's stored-cost basis — never re-derived to list price).
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

  let total = 0;
  let anyPriced = false;
  for (const [sessionId, cost] of costBySession) {
    const branches = branchCount.get(sessionId) ?? 0;
    const enriched = enrichedCount.get(sessionId) ?? 0;
    if (branches === 0 || enriched === 0) {
      continue;
    }
    total += cost * (enriched / branches);
    anyPriced = true;
  }
  return anyPriced ? total : null;
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
  // Merge rate = merged / opened, computed from local PR lifecycle. Multi-PR
  // branches are excluded (their lifecycle is ambiguous — the row only carries
  // the latest PR's state), matching the median-PR-size exclusion below.
  const withPr = items.filter(
    (row) => row.prState != null && !row.multiPrWarning
  );
  const merged = items.filter(
    (row) => row.prState === "MERGED" && !row.multiPrWarning
  );
  const mergeRate =
    withPr.length > 0
      ? available((merged.length / withPr.length) * 100)
      : unavailable();

  // Median PR size over MERGED, single-PR branches — matching the delivery
  // dashboard's data treatment (`apps/api/app/insights/service.ts` getDelivery,
  // the "pr-size" KPI). That side maps every merged PR's line total through
  // `?? 0`, so a merged branch with no LOC enrichment counts as a 0-line PR and
  // is INCLUDED in the median rather than excluded; the KPI is therefore
  // available whenever any single-PR branch has merged. We mirror that here so
  // the two surfaces report the same metric (FEA-2159): drop the
  // enrichment gate and fold a missing line count in as 0. Multi-PR branches
  // stay excluded (ambiguous lifecycle — the row carries only the latest PR's
  // state), matching the merge-rate exclusion above.
  const sizes = items
    .filter((row) => row.status === BranchStatus.Merged && !row.multiPrWarning)
    .map((row) => (row.additions ?? 0) + (row.deletions ?? 0));
  const medianPrSize =
    sizes.length > 0 ? available(median(sizes)) : unavailable();

  // Net LOC per dollar — needs LOC enrichment AND priced cost. The numerator (net
  // LOC) is summed over LOC-enriched branches; the denominator
  // (`spend.locEnrichedSpendUsd`) is the captured cost EVEN-SPLIT-attributed to
  // those same enriched branches (`sumLocEnrichedSpend`), so a session split
  // across enriched and un-enriched branches contributes only its enriched share
  // — un-enriched spend with no LOC to offset it stays out of the ratio.
  const locRows = items.filter(isLocEnrichedRow);
  const totalNetLoc = locRows.reduce(
    (sum, row) => sum + ((row.additions ?? 0) - (row.deletions ?? 0)),
    0
  );
  const totalCost = spend.locEnrichedSpendUsd ?? 0;
  const locPerDollar =
    locRows.length > 0 && totalCost > 0
      ? available(totalNetLoc / totalCost)
      : unavailable();

  // Total AI spend — the DEDUPED priced cost across every branch-linked session,
  // counted ONCE no matter how many branches it touched (so it reconciles with the
  // usage summary's `totalEstimatedCost` and the agent dashboard, instead of the
  // per-branch attribution sum that inflated this card). Unavailable (NOT $0) when
  // nothing prices, so the card shows "—" rather than implying free work.
  const totalSpendUsd = pricedKpi(spend.totalSpendUsd);

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

  return {
    viewerScope: BranchViewerScope.Self,
    medianPrSize,
    mergeRate,
    medianTimeToMergeMs: gated(),
    activePrCount: gated(),
    mergedCount: gated(),
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
