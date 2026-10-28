/**
 * ISS-11589: the Branches card's Median PR size over twinned pull-request rows,
 * and the star that has to say which shortfall it is describing.
 */
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  type BranchListMetricInput,
  type BranchMetricPullRequestEvidence,
  calculateBranchListMetrics,
} from "./branch-list-metrics";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";

const NOW = new Date("2026-08-03T21:00:00.000Z");
const IN_WINDOW = "2026-08-01T12:00:00.000Z";
const BEFORE_WINDOW = "2026-06-01T00:00:00.000Z";

describe("calculateMedianPrSize — twinned pull-request rows", () => {
  it("keeps a pull request whose App row is sized and whose twin is not", () => {
    // The population before the tie-break held only PR #3: #1 and #2 were each
    // claimed by two rows that disagreed, and both rows of each pair were
    // dropped. The median was then taken over a third of the pull requests the
    // card had actually read.
    const result = medianFor([
      pullRequest("acme/web#1", { additions: 500, githubId: "PR_1" }),
      pullRequest("acme/web#1", { additions: null, deletions: null }),
      pullRequest("acme/web#2", { additions: 100, githubId: "PR_2" }),
      pullRequest("acme/web#2", { additions: 7 }),
      pullRequest("acme/web#3", { additions: 20 }),
    ]);

    expect(result).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 100,
    });
  });

  it("lets the App-owned row settle a size disagreement, not arrival order", () => {
    const appRow = pullRequest("acme/web#1", {
      additions: 500,
      githubId: "PR_1",
    });
    const repolessTwin = pullRequest("acme/web#1", { additions: 7 });

    expect(medianFor([appRow, repolessTwin])).toEqual(
      medianFor([repolessTwin, appRow])
    );
    expect(medianFor([repolessTwin, appRow])).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 500,
    });
  });
});

describe("calculateMedianPrSize — the star names its own cause", () => {
  it("says sizes are unavailable only when a merged PR is genuinely unsized", () => {
    const result = medianFor([
      pullRequest("acme/web#1", { additions: 100 }),
      pullRequest("acme/web#2", { additions: null, deletions: null }),
    ]);

    expect(result).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 100,
      coverage: { included: 1, total: 2 },
      disclosure: BranchMetricDisclosure.PrIncomplete,
    });
  });

  it("names the coverage gap, not sizes, when every merged PR is sized", () => {
    // The observed defect: sizing coverage was PERFECT and the card still told
    // the reader that qualifying pull request sizes were unavailable.
    const input = baseInput([pullRequest("acme/web#1", { additions: 100 })]);
    input.pullRequestCoverageComplete = false;

    expect(sevenDayMedian(input)).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 100,
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
  });

  it("names the coverage gap when a row carried no identity at all", () => {
    const input = baseInput([
      pullRequest("acme/web#1", { additions: 100 }),
      pullRequest("", { additions: 40 }),
    ]);

    expect(sevenDayMedian(input)).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 100,
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
  });

  it("claims no coverage pair when a gap and an unsized PR coexist", () => {
    // `merged.length` is itself an undercount under a gap, so printing it as
    // the total would assert exact coverage of a population this fold cannot
    // see — the same refusal the merge-rate sibling makes.
    const input = baseInput([
      pullRequest("acme/web#1", { additions: 100 }),
      pullRequest("acme/web#2", { additions: null, deletions: null }),
    ]);
    input.pullRequestCoverageComplete = false;

    expect(sevenDayMedian(input)).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 100,
      disclosure: BranchMetricDisclosure.PrIncomplete,
    });
  });
});

describe("calculateMedianPrSize — a twin disagreement the tie-break cannot settle", () => {
  it("drops a pull request whose twins disagree about when it merged", () => {
    // The tie-break ranks diff stats and nothing else, so it confers no
    // authority here: letting the sized row carry a merge instant its twin
    // contradicts would publish a population decided by arrival order.
    const input = baseInput([
      pullRequest("acme/web#1", { additions: 100 }),
      pullRequest("acme/web#2", { additions: 500 }),
      pullRequest("acme/web#2", { additions: 500, mergedAt: null }),
    ]);

    expect(sevenDayMedian(input)).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 100,
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
  });

  it("still resolves a twin pair that only disagrees about its diff stats", () => {
    const input = baseInput([
      pullRequest("acme/web#1", { additions: 100 }),
      pullRequest("acme/web#2", { additions: 500, githubId: "PR_2" }),
      pullRequest("acme/web#2", { additions: null, deletions: null }),
    ]);

    expect(sevenDayMedian(input)).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 300,
    });
  });

  it("stars a figure whose twin pair was decided by arrival order", () => {
    // tamsinb review on #8237: desktop never writes a `githubId`, so two sized
    // repo-less rows disagreeing about #2 leave arrival order holding the
    // answer. That pair carried `conflicted` before the tie-break existed, and
    // publishing the winner as Complete would hide a stale `linesAdded` behind
    // an unstarred number.
    const input = baseInput([
      pullRequest("acme/web#1", { additions: 100 }),
      pullRequest("acme/web#2", { additions: 500 }),
      pullRequest("acme/web#2", { additions: 40 }),
    ]);

    expect(sevenDayMedian(input)).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 300,
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
  });

  it("publishes a complete figure when a gap lands outside the window", () => {
    const input = baseInput([pullRequest("acme/web#1", { additions: 100 })]);
    input.pullRequestCoverageComplete = false;
    input.pullRequestCoverageGaps = [{ occurredAt: BEFORE_WINDOW }];

    expect(sevenDayMedian(input)).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 100,
    });
  });
});

function pullRequest(
  identity: string,
  overrides: Partial<BranchMetricPullRequestEvidence> = {}
): BranchMetricPullRequestEvidence {
  return {
    identity,
    mergedAt: IN_WINDOW,
    closedAt: null,
    githubId: null,
    additions: 0,
    deletions: 0,
    ...overrides,
  };
}

function baseInput(
  pullRequests: readonly BranchMetricPullRequestEvidence[]
): BranchListMetricInput {
  return {
    cohortSize: 1,
    lastActiveCoverageComplete: true,
    lastActiveEvents: [{ sourceEventId: "event-a", occurredAt: IN_WINDOW }],
    statusSnapshots: [
      { branchId: "a", currentActive: true, priorActive: null },
    ],
    locContributions: [],
    locCompleteBranchIds: ["a"],
    pullRequests,
    pullRequestCoverageComplete: true,
    costContributions: [],
    costCompleteBranchIds: ["a"],
  };
}

function sevenDayMedian(input: BranchListMetricInput) {
  return calculateBranchListMetrics(
    input,
    buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
  ).medianPrSize.current;
}

function medianFor(pullRequests: readonly BranchMetricPullRequestEvidence[]) {
  return sevenDayMedian(baseInput(pullRequests));
}
