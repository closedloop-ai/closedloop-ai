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
import { isLocEnriched } from "@repo/lib/branches/loc-per-dollar";

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

/** A branch carries FEA-1899 LOC enrichment once BOTH line counts have landed. */
export function isLocEnrichedRow(
  row: BranchRow
): row is BranchRow & { additions: number; deletions: number } {
  return isLocEnriched(row);
}

/**
 * FEA-3695 — the AUTHORITATIVE per-session captured cost map surfaced on the
 * desktop list wire (`BranchListResponse.sessionCostUsd`). Sums a session's
 * per-model captured cost, dropping un-priced rows so an entirely un-priced
 * session is absent (priced-nothing → the client's `> 0` gate renders "—"),
 * exactly like the deduped total spend read — so the client's filtered re-derivation cannot drift from the
 * headline. Keyed by the non-nullable `sessionId`, so a session shared by
 * multiple branches has ONE entry, never one per branch.
 */
export function sessionCostMapFromUsageRows(
  usageRows: ReadonlyArray<{
    sessionId: string;
    costUsdEstimated: number | null;
  }>
): Record<string, number> {
  // ISS-8565: null-prototype container so a key literally named `__proto__`
  // becomes an own property instead of hitting the inherited `__proto__`
  // setter, which creates no own key and silently drops the entry.
  // On a plain `{}`, `costBySession["__proto__"]` reads back Object.prototype,
  // so the `?? 0` never fires and `Object.prototype + number` coerces to a
  // string before the setter discards it. The `continue` above stays as-is:
  // an all-unpriced session must remain ABSENT so the client renders "-".
  const costBySession: Record<string, number> = Object.create(null);
  for (const row of usageRows) {
    if (row.costUsdEstimated == null) {
      continue;
    }
    costBySession[row.sessionId] =
      (costBySession[row.sessionId] ?? 0) + row.costUsdEstimated;
  }
  // Spread restores a normal prototype for downstream consumers (object
  // spread defines rather than assigns, so an own `__proto__` key survives).
  return { ...costBySession };
}

/**
 * The count and PR KPIs of the shared BranchAnalytics card. The two spend-based
 * KPIs (`totalSpendUsd`, `locPerDollar`) are left unavailable here and filled
 * from the canonical cards by the caller (ISS-12361), so spend is derived once.
 */
export function projectBranchAnalytics(items: BranchRow[]): BranchAnalytics {
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
    locPerDollar: unavailable(),
    totalSpendUsd: unavailable(),
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
