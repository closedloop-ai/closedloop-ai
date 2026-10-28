import {
  BranchMetricDisclosure,
  type BranchMetricResult,
  type BranchMetricWindow,
} from "@repo/api/src/types/branch-metrics";
import { isValidNonnegative } from "./branch-cost-evidence";
import { reconcilePullRequests } from "./branch-list-metric-reconcilers";
import type { BranchListMetricInput } from "./branch-list-metrics";
import {
  complete,
  emptyCohortResult,
  noData,
  notApplicable,
  partial,
  unavailable,
} from "./branch-metric-results";
import { buildBranchMetricSeriesWindows } from "./branch-metric-series";
import type { AdjacentBranchMetricWindows } from "./branch-metric-windows";
import {
  decidedPullRequestIdentityCount,
  pullRequestClosedUnmergedInWindow,
  pullRequestCoverageIsComplete,
  pullRequestMergedInWindow,
} from "./branch-pull-request-evidence";

/**
 * Median PR size and Merge rate (ISS-11589). Definitions and the owner's
 * D1-D5 rulings: ISS-11589's decision record.
 */

/** What one window's pull requests came to, taken over the PRs that count. */
export type BranchMetricPullRequestWindowFacts = {
  merged: number;
  sized: number;
  medianSize: number | null;
  closedUnmerged: number;
  /** Distinct identities decided in the window, before twin reconciliation. */
  decidedIdentities: number;
};

/**
 * Pull-request answers a producer folded itself, per window, in place of the
 * `pullRequests` evidence the kernel would fold. `conflicted` is population
 * wide: a twin pair disagreed on lifecycle, or on size with nothing to settle it.
 */
export type BranchMetricPullRequestFacts = {
  conflicted: boolean;
  windows: ReadonlyMap<string, BranchMetricPullRequestWindowFacts>;
};

export function branchMetricWindowKey(window: BranchMetricWindow): string {
  return `${window.startAt ?? ""}/${window.endAt}`;
}

/** Every window `calculateBranchListMetrics` asks a producer-folded fact about. */
export function branchMetricFactWindows(
  windows: AdjacentBranchMetricWindows
): BranchMetricWindow[] {
  const all = [
    windows.current,
    ...(windows.requested ? [windows.requested] : []),
    ...(windows.prior ? [windows.prior] : []),
    ...buildBranchMetricSeriesWindows(windows.current),
  ];
  return [
    ...new Map(all.map((window) => [branchMetricWindowKey(window), window])),
  ].map(([, window]) => window);
}

export function calculateMedianPrSize(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): BranchMetricResult<number> {
  if (input.cohortSize === 0) {
    return emptyCohortResult(input);
  }
  if (input.pullRequestFacts) {
    return medianPrSizeFromFacts(
      input.pullRequestFacts,
      window,
      pullRequestCoverageIsComplete(input, window)
    );
  }
  if (!hasPullRequestEvidence(input)) {
    return unavailable();
  }
  const coverageComplete = pullRequestCoverageIsComplete(input, window);
  const reconciled = reconcilePullRequests(input.pullRequests ?? []);
  const merged = reconciled.values.filter((pullRequest) =>
    pullRequestMergedInWindow(pullRequest, window)
  );
  if (merged.length === 0) {
    return coverageComplete && !reconciled.conflicted
      ? noData()
      : unavailable();
  }
  const knownSizes = merged.flatMap((pullRequest) => {
    if (
      !(
        isValidNonnegative(pullRequest.additions) &&
        isValidNonnegative(pullRequest.deletions)
      )
    ) {
      return [];
    }
    return [pullRequest.additions + pullRequest.deletions];
  });
  if (knownSizes.length === 0) {
    return unavailable();
  }
  knownSizes.sort((left, right) => left - right);
  const middle = Math.floor(knownSizes.length / 2);
  const value =
    knownSizes.length % 2 === 0
      ? (knownSizes[middle - 1] + knownSizes[middle]) / 2
      : knownSizes[middle];
  // ISS-11589: one star fired for three causes and its sentence described only
  // the first, so a card with PERFECT sizing coverage told the reader that
  // sizes were unavailable. `PrIncomplete` speaks about sizes and is kept for
  // the shortfall that is about sizes; the other two are about WHICH pull
  // requests could be read, which is what ISS-9959 added `PrCoverageIncomplete`
  // to `calculateMergeRate` to say.
  const populationIsProvable = coverageComplete && !reconciled.conflicted;
  if (knownSizes.length < merged.length) {
    // The pair rides an unsized pull request only while the population it is
    // taken of is provable. A gap is a pull request absent from the evidence
    // entirely, so under one `merged.length` is itself an undercount, and
    // printing it as the total would assert exact coverage of a population
    // this fold cannot see.
    if (populationIsProvable) {
      return partial(
        value,
        knownSizes.length,
        merged.length,
        BranchMetricDisclosure.PrIncomplete
      );
    }
    return partial(
      value,
      undefined,
      undefined,
      BranchMetricDisclosure.PrIncomplete
    );
  }
  if (populationIsProvable) {
    return complete(value);
  }
  return partial(
    value,
    undefined,
    undefined,
    BranchMetricDisclosure.PrCoverageIncomplete
  );
}

export function calculateMergeRate(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): BranchMetricResult<number> {
  if (input.cohortSize === 0) {
    return emptyCohortResult(input);
  }
  if (input.pullRequestFacts) {
    return mergeRateFromFacts(
      input.pullRequestFacts,
      window,
      pullRequestCoverageIsComplete(input, window)
    );
  }
  if (!hasPullRequestEvidence(input)) {
    return unavailable();
  }
  const coverageComplete = pullRequestCoverageIsComplete(input, window);
  const reconciled = reconcilePullRequests(input.pullRequests ?? []);
  const pullRequests = reconciled.values;
  const merged = pullRequests.filter((pullRequest) =>
    pullRequestMergedInWindow(pullRequest, window)
  );
  const closedUnmerged = pullRequests.filter((pullRequest) =>
    pullRequestClosedUnmergedInWindow(pullRequest, window)
  );
  const decided = merged.length + closedUnmerged.length;
  if (decided === 0) {
    return coverageComplete && !reconciled.conflicted
      ? notApplicable()
      : unavailable();
  }
  const value = (merged.length / decided) * 100;
  if (coverageComplete && !reconciled.conflicted) {
    return complete(value);
  }
  // ISS-9959 acceptance 2: a star has to say WHAT is missing. This was a bare
  // `partial(value)` — no coverage pair, and `DefaultIncomplete`'s sentence,
  // which names no cause — so the card asserted "some qualifying values are
  // unavailable" while being unable to say how many.
  //
  // The pair is emitted ONLY where the decided population is provable. A coverage
  // gap is a pull request that could not be read at all, so it is absent from
  // `input.pullRequests` and any total derived from them is a confident
  // undercount — `{ included: 1, total: 1 }` printed beside a sentence saying
  // qualifying pull requests are unavailable, which is the exact-looking number
  // `BranchMetricResult` reserves for a producer that can prove both counts.
  if (!coverageComplete) {
    return partial(
      value,
      undefined,
      undefined,
      BranchMetricDisclosure.PrCoverageIncomplete
    );
  }
  // Reconciliation conflict is the one shortfall whose population IS provable:
  // every contradicting identity is present in `input.pullRequests`, so the
  // total counts it once whether the fold dropped its rows (a lifecycle
  // disagreement) or published an arrival-order winner it cannot call settled
  // (two sized repo-less twins). ISS-11589 narrowed WHICH disagreements reach
  // here — a twin pair the tie-break can settle no longer does — without
  // changing that.
  return partial(
    value,
    decided,
    decidedPullRequestIdentityCount(input.pullRequests ?? [], window),
    BranchMetricDisclosure.PrCoverageIncomplete
  );
}

/**
 * ISS-9959 (H1, marisolashgrove review on #8791): `coverageComplete` is the SAME
 * per-window verdict the evidence path takes, and the facts path needs it for a
 * reason SQL cannot remove — a pull request the sync never wrote is absent from
 * `pull_request_detail`, so no fold over that table can see it. Without it a
 * branch whose associated collection hides a decided pull request published
 * Complete where it used to be starred.
 */
function medianPrSizeFromFacts(
  facts: BranchMetricPullRequestFacts,
  window: BranchMetricWindow,
  coverageComplete: boolean
): BranchMetricResult<number> {
  const counts = facts.windows.get(branchMetricWindowKey(window));
  if (!counts) {
    return unavailable();
  }
  const populationIsProvable = coverageComplete && !facts.conflicted;
  if (counts.merged === 0) {
    return populationIsProvable ? noData() : unavailable();
  }
  if (counts.medianSize === null) {
    return unavailable();
  }
  if (counts.sized < counts.merged) {
    return populationIsProvable
      ? partial(
          counts.medianSize,
          counts.sized,
          counts.merged,
          BranchMetricDisclosure.PrIncomplete
        )
      : partial(
          counts.medianSize,
          undefined,
          undefined,
          BranchMetricDisclosure.PrIncomplete
        );
  }
  return populationIsProvable
    ? complete(counts.medianSize)
    : partial(
        counts.medianSize,
        undefined,
        undefined,
        BranchMetricDisclosure.PrCoverageIncomplete
      );
}

/** `coverageComplete`: see {@link medianPrSizeFromFacts}. */
function mergeRateFromFacts(
  facts: BranchMetricPullRequestFacts,
  window: BranchMetricWindow,
  coverageComplete: boolean
): BranchMetricResult<number> {
  const counts = facts.windows.get(branchMetricWindowKey(window));
  if (!counts) {
    return unavailable();
  }
  const decided = counts.merged + counts.closedUnmerged;
  if (decided === 0) {
    return coverageComplete && !facts.conflicted
      ? notApplicable()
      : unavailable();
  }
  const value = (counts.merged / decided) * 100;
  // The coverage pair rides only where the decided population is provable, the
  // same split the evidence path makes: a gap is a pull request this fold could
  // not read at all, so `decidedIdentities` is itself an undercount and printing
  // it would assert exact coverage of a population SQL cannot see.
  if (!coverageComplete) {
    return partial(
      value,
      undefined,
      undefined,
      BranchMetricDisclosure.PrCoverageIncomplete
    );
  }
  return facts.conflicted
    ? partial(
        value,
        decided,
        counts.decidedIdentities,
        BranchMetricDisclosure.PrCoverageIncomplete
      )
    : complete(value);
}

function hasPullRequestEvidence(input: BranchListMetricInput): boolean {
  return (
    input.pullRequests !== undefined &&
    input.pullRequestCoverageComplete !== undefined
  );
}
