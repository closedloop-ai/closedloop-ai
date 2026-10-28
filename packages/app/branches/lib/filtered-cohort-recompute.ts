import {
  type BranchAnalytics,
  BranchStatus,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { median } from "@repo/api/src/utils/math";
import { countPrLifecycle } from "@repo/lib/branches/branch-lifecycle-count";
import { isLocEnriched } from "@repo/lib/branches/loc-per-dollar";
import {
  bindCanonicalMetricsToFilteredRows,
  type PartialCohortMetrics,
  replaceCurrent,
  unavailableForEmpty,
} from "./approved-filtered-metrics";
import type { BranchFilters } from "./branch-row";
import { analyticsLoc } from "./filtered-branch-analytics";

/**
 * ISS-9967: the filtered-cohort fallback that RECOMPUTES rather than fails
 * closed.
 *
 * `bindCanonicalMetricsToFilteredRows` is the shipped fallback: when the exact
 * cohort producer has no answer, it keeps the two row-provable figures and
 * blanks every event-history card to Unavailable, captioned as a filter
 * problem. The rule this module applies instead is the ticket's: a filter
 * narrows the population; it does not remove the ability to count it. Every
 * card with a row-derivable form is re-derived over the rows on screen, so the
 * strip reconciles with the table beneath it under the same facet.
 *
 * Built ON the shipped binder rather than beside it: the cohort-size, spend,
 * active-count, comparison-blanking and window-scoped handling are unchanged,
 * and only the two cards this module can prove from rows are overridden.
 *
 * WHAT IS NOT RE-DERIVED, and why (whitlockk + codex review). A Branch row carries
 * whole-branch file-cache LOC and no publication evidence, so neither
 * `totalLocPushed` nor `canonicalLocPerDollar` has a row-provable form:
 *
 * - `canonicalLocPerDollar`'s numerator is timestamped publication LOC
 *   (successful-push or merged-PR contributions, each filtered by its own
 *   `occurredAt`) over a denominator folded across the SAME window — that
 *   matched pair is ISS-9956's fix. Dividing whole-branch churn by the WINDOWED
 *   session-cost map reintroduces exactly the defect that ticket removed: a
 *   branch that last moved this week carries months of prior LOC into a 7-day
 *   numerator, and the card reads high without ever reading wrong.
 * - `totalLocPushed` has no push evidence on the row at all.
 *
 * Both therefore keep the shipped path — the producer's partial answer, else
 * Unavailable. That is an absence of evidence, not a filter refusal.
 *
 * The two cards below ARE row-provable, but only over SINGLE-PR branches: a row
 * carries just its latest PR's state, so a multi-PR branch has an ambiguous
 * lifecycle and is excluded. The canonical kernel has no such exclusion — it
 * derives per-PR from the full associated-PR collection — so a cohort holding a
 * multi-PR branch is a SHORT population here, and it is published as `Partial`
 * with that coverage rather than as `Complete`. (An earlier draft of this
 * module claimed the exclusion matched "both server producers"; that is true of
 * the legacy `BranchAnalytics` KPI pair, not of the `BranchListMetricBundle`
 * fields this module actually overwrites.)
 */
export function recomputeCanonicalMetricsOverFilteredRows(
  analytics: BranchAnalytics,
  rows: readonly WireBranchRow[],
  filters: BranchFilters,
  sessionCostUsd?: Readonly<Record<string, number>>,
  unfilteredRows: readonly WireBranchRow[] = rows,
  partialCohort?: PartialCohortMetrics
): BranchAnalytics {
  const bound = bindCanonicalMetricsToFilteredRows(
    analytics,
    rows,
    filters,
    sessionCostUsd,
    unfilteredRows,
    partialCohort
  );
  // Identity is the shipped binder's own contract: unchanged means it declined
  // to apply (no facet, or the facet removed no row), and there is nothing to
  // recompute over.
  const metrics = bound.canonicalMetrics;
  if (bound === analytics || !metrics) {
    return bound;
  }
  const noData = unavailableForEmpty(rows);
  return {
    ...bound,
    canonicalMetrics: {
      ...metrics,
      medianPrSize: replaceCurrent(
        metrics.medianPrSize,
        noData ?? filteredMedianPrSize(rows)
      ),
      mergeRatePct: replaceCurrent(
        metrics.mergeRatePct,
        noData ?? filteredMergeRate(rows)
      ),
    },
  };
}

/**
 * Median gross lines per MERGED, single-PR, LOC-enriched branch. Reads the
 * file-cache analytics basis, never the PR-backfilled display value, so the
 * figure matches the legacy header derivation on the same rows.
 *
 * Coverage is counted against every MERGED row in the cohort, so a merged
 * multi-PR branch the derivation cannot read shortens the population it
 * reports rather than silently leaving the figure `Complete`.
 */
function filteredMedianPrSize(
  rows: readonly WireBranchRow[]
): BranchMetricResult<number> {
  const mergedRows = rows.filter((row) => row.status === BranchStatus.Merged);
  const readable = mergedRows.filter((row) => !row.multiPrWarning);
  if (mergedRows.length === 0) {
    return { state: BranchMetricAvailability.NotApplicable, value: null };
  }
  // Every merged branch in the cohort is multi-PR, so "no merged PR to size" is
  // a claim about branches this derivation never read. Unavailable, not N/A.
  if (readable.length === 0) {
    return { state: BranchMetricAvailability.Unavailable, value: null };
  }
  const sizes = readable
    .map(analyticsLoc)
    .filter(isLocEnriched)
    .map((loc) => loc.additions + loc.deletions);
  const size = median(sizes);
  if (size === null) {
    return { state: BranchMetricAvailability.Unavailable, value: null };
  }
  if (sizes.length === mergedRows.length) {
    return { state: BranchMetricAvailability.Complete, value: size };
  }
  return {
    state: BranchMetricAvailability.Partial,
    value: size,
    coverage: { included: sizes.length, total: mergedRows.length },
    disclosure: shortPopulationDisclosure(
      readable.length !== mergedRows.length,
      sizes.length !== readable.length
    ),
  };
}

/**
 * Merged ÷ decided (merged + closed) over single-PR rows, through the same
 * merge-evidence-first classifier the producers use, so a stale-open-but-merged
 * PR lands in the merged bucket here exactly as it does unfiltered.
 */
function filteredMergeRate(
  rows: readonly WireBranchRow[]
): BranchMetricResult<number> {
  const readable = rows.filter((row) => !row.multiPrWarning);
  const counts = countPrLifecycle(
    readable.map((row) => ({
      prState: row.prState,
      mergedAt: row.mergedAt ?? null,
    }))
  );
  const decided = counts.merged + counts.closed;
  if (decided === 0) {
    // "No decided PR" over a subset does not establish that the branches this
    // derivation skipped have none either — the same asymmetry `cohortPartial`
    // applies to a producer's verdict over a partial cohort.
    return readable.length === rows.length
      ? { state: BranchMetricAvailability.NotApplicable, value: null }
      : { state: BranchMetricAvailability.Unavailable, value: null };
  }
  const value = (counts.merged / decided) * 100;
  if (readable.length === rows.length) {
    return { state: BranchMetricAvailability.Complete, value };
  }
  return {
    state: BranchMetricAvailability.Partial,
    value,
    coverage: { included: readable.length, total: rows.length },
    disclosure: BranchMetricDisclosure.BranchesIncomplete,
  };
}

/**
 * Which sentence a short figure carries: branches the derivation could not
 * read, evidence missing from the ones it could, or both. One result carries
 * one disclosure, so naming only half would let the reader believe the other
 * narrowing did not happen.
 */
function shortPopulationDisclosure(
  branchesDropped: boolean,
  evidenceShort: boolean
): BranchMetricDisclosure {
  if (branchesDropped && evidenceShort) {
    return BranchMetricDisclosure.BranchesAndEvidenceIncomplete;
  }
  if (branchesDropped) {
    return BranchMetricDisclosure.BranchesIncomplete;
  }
  return BranchMetricDisclosure.LocIncomplete;
}
