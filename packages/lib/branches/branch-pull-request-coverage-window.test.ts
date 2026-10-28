import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  type BranchListMetricInput,
  type BranchMetricPullRequestCoverageGap,
  calculateBranchListMetrics,
} from "./branch-list-metrics";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";

const NOW = new Date("2026-08-03T21:00:00.000Z");
/** Inside the 7-day current window (which opens 2026-07-27T21:00:00.000Z). */
const IN_WINDOW = "2026-08-01T12:00:00.000Z";
/** Comfortably before that window opened. */
const BEFORE_WINDOW = "2026-06-01T00:00:00.000Z";

describe("ISS-9959: per-window pull-request coverage", () => {
  it("clears a window no observed gap instant lands in, while the cohort flag is false", () => {
    const result = metricsFor({
      pullRequestCoverageComplete: false,
      pullRequestCoverageGaps: [{ branchId: "a", occurredAt: BEFORE_WINDOW }],
    });

    // The star on both non-count PR cards is what ISS-9959 exists to remove. The
    // gap is placed at an instant its producer OBSERVED, so a June instant is
    // genuinely outside a window that opened in late July — the same exact test
    // the LOC sibling has always applied to its own observed events.
    expect(result.medianPrSize.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 40,
    });
    expect(result.mergeRatePct.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 100,
    });
  });

  it("clears a window when the producer supplies an EMPTY gap list", () => {
    const result = metricsFor({
      pullRequestCoverageComplete: false,
      pullRequestCoverageGaps: [],
    });

    // The case both producers actually rely on. A cohort whose only shortfalls
    // hide no decision emits no gap at all, so reading an empty list as "no gaps,
    // fall back to the cohort flag" would star every window exactly as before and
    // the per-window derivation would be dead on arrival.
    expect(result.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Complete
    );
    expect(result.medianPrSize.current.state).toBe(
      BranchMetricAvailability.Complete
    );
  });

  it("stars the window, names its cause, and claims no coverage it cannot prove", () => {
    const result = metricsFor({
      pullRequestCoverageComplete: false,
      pullRequestCoverageGaps: [{ branchId: "a", occurredAt: IN_WINDOW }],
    });

    expect(result.medianPrSize.current.state).toBe(
      BranchMetricAvailability.Partial
    );
    // ISS-9959 acceptance 2 gave merge rate a cause to name: before it, this was
    // a bare `partial(value)` carrying `DefaultIncomplete`, whose sentence names
    // nothing. The ABSENCE of `coverage` here is equally load-bearing, and
    // `toEqual` is what pins it: a gap is a pull request that could not be read,
    // so it is absent from `pullRequests` and any total derived from them would
    // print an exact-looking `{ included: 1, total: 1 }` beside a sentence saying
    // qualifying pull requests are unavailable.
    expect(result.mergeRatePct.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 100,
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
  });

  it("poisons every window when the gap cannot be placed at all", () => {
    const result = metricsFor({
      pullRequestCoverageComplete: false,
      pullRequestCoverageGaps: [{ occurredAt: null }],
    });

    expect(result.medianPrSize.current.state).toBe(
      BranchMetricAvailability.Partial
    );
    expect(result.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("poisons an all-time window, which every observed instant falls inside", () => {
    const result = metricsFor(
      {
        pullRequestCoverageComplete: false,
        pullRequestCoverageGaps: [{ branchId: "a", occurredAt: BEFORE_WINDOW }],
      },
      BranchMetricPeriod.All
    );

    expect(result.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("falls back to the cohort flag when the producer omits gaps entirely", () => {
    const complete = metricsFor({ pullRequestCoverageComplete: true });
    const incomplete = metricsFor({ pullRequestCoverageComplete: false });

    // A producer that predates the field is answered exactly as it was before.
    expect(complete.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Complete
    );
    expect(incomplete.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("keeps a twinned identity in merge rate's population instead of erasing it", () => {
    const windows = buildAdjacentBranchMetricWindows(
      BranchMetricPeriod.SevenDays,
      NOW
    );
    const result = calculateBranchListMetrics(
      {
        ...baseInput(),
        pullRequestCoverageComplete: true,
        pullRequests: [
          pullRequest("repo#1", IN_WINDOW, null, 10, 30),
          // ISS-11589: one pull request, two rows, contradicting line counts.
          // Reconciliation used to drop BOTH sides, so a decided pull request
          // known to exist went uncounted and the rate was taken of a short
          // population. The twin tie-break keeps it — a 2-of-2 population,
          // which is what this case pins.
          //
          // The star stays, because neither row carries a `githubId` and so
          // arrival order, not an authority, picked the surviving size
          // (tamsinb review on #8237). Only a pair the tie-break can actually
          // settle reaches Complete.
          pullRequest("repo#2", IN_WINDOW, null, 1, 1),
          pullRequest("repo#2", IN_WINDOW, null, 500, 500),
        ],
      },
      windows
    );

    expect(result.mergeRatePct.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 100,
      coverage: { included: 2, total: 2 },
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
  });

  it("counts a lifecycle-contradicted identity in merge rate's total, not its numerator", () => {
    const windows = buildAdjacentBranchMetricWindows(
      BranchMetricPeriod.SevenDays,
      NOW
    );
    const result = calculateBranchListMetrics(
      {
        ...baseInput(),
        pullRequestCoverageComplete: true,
        pullRequests: [
          pullRequest("repo#1", IN_WINDOW, null, 10, 30),
          // ISS-11589: equally-sized twins that disagree about whether this
          // pull request merged. The tie-break ranks diff stats only, so it
          // has no authority here and both rows are dropped — the shortfall
          // ISS-9959 identified as the one whose population IS provable,
          // because the contradicting identity is still present to count.
          pullRequest("repo#2", IN_WINDOW, null, 5, 5),
          pullRequest("repo#2", null, null, 5, 5),
        ],
      },
      windows
    );

    expect(result.mergeRatePct.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 100,
      coverage: { included: 1, total: 2 },
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
  });
});

function metricsFor(
  coverage: {
    pullRequestCoverageComplete: boolean;
    pullRequestCoverageGaps?: readonly BranchMetricPullRequestCoverageGap[];
  },
  period: BranchMetricPeriod = BranchMetricPeriod.SevenDays
) {
  return calculateBranchListMetrics(
    {
      ...baseInput(),
      pullRequestCoverageComplete: coverage.pullRequestCoverageComplete,
      ...(coverage.pullRequestCoverageGaps === undefined
        ? {}
        : { pullRequestCoverageGaps: coverage.pullRequestCoverageGaps }),
      pullRequests: [pullRequest("repo#1", IN_WINDOW, null, 10, 30)],
    },
    buildAdjacentBranchMetricWindows(period, NOW)
  );
}

function baseInput(): BranchListMetricInput {
  return {
    cohortSize: 1,
    lastActiveCoverageComplete: true,
    lastActiveEvents: [{ sourceEventId: "event-a", occurredAt: IN_WINDOW }],
    statusSnapshots: [
      { branchId: "a", currentActive: true, priorActive: null },
    ],
    locContributions: [],
    locCompleteBranchIds: ["a"],
    pullRequests: [],
    pullRequestCoverageComplete: true,
    costContributions: [],
    costCompleteBranchIds: ["a"],
  };
}

function pullRequest(
  identity: string,
  mergedAt: string | null,
  closedAt: string | null,
  additions: number | null,
  deletions: number | null
) {
  return { identity, mergedAt, closedAt, additions, deletions };
}
