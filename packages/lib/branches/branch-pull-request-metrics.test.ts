import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import { resolveCanonicalBranchMetricWindows } from "./branch-list-metric-projection";
import {
  type BranchListMetricInput,
  calculateBranchListMetrics,
} from "./branch-list-metrics";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";
import {
  type BranchMetricPullRequestFacts,
  type BranchMetricPullRequestWindowFacts,
  branchMetricFactWindows,
  branchMetricWindowKey,
} from "./branch-pull-request-metrics";

const NOW = new Date("2026-08-03T21:00:00.000Z");
const WINDOWS = buildAdjacentBranchMetricWindows(
  BranchMetricPeriod.SevenDays,
  NOW
);

describe("Median PR size from producer facts", () => {
  it("is No data when nothing merged and the twins are consistent", () => {
    expect(median(facts({ merged: 0 }))).toEqual({
      state: BranchMetricAvailability.NoData,
      value: null,
    });
  });

  it("is Unavailable when nothing merged but twins disagreed", () => {
    expect(median(facts({ merged: 0 }, true))).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  it("is Unavailable when merged PRs exist and none is sized", () => {
    expect(median(facts({ merged: 3, sized: 0, medianSize: null }))).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  it("is Unavailable for a window the producer folded no facts for", () => {
    expect(median({ conflicted: false, windows: new Map() })).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  it("carries the sized-of-merged pair while the population is provable", () => {
    expect(median(facts({ merged: 4, sized: 3, medianSize: 120 }))).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 120,
      coverage: { included: 3, total: 4 },
      disclosure: BranchMetricDisclosure.PrIncomplete,
    });
  });

  it("drops the pair when twins disagreed, since the total is then unprovable", () => {
    expect(
      median(facts({ merged: 4, sized: 3, medianSize: 120 }, true))
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 120,
      disclosure: BranchMetricDisclosure.PrIncomplete,
    });
  });

  it("is Complete when every merged PR is sized and the twins agree", () => {
    expect(median(facts({ merged: 4, sized: 4, medianSize: 120.5 }))).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 120.5,
    });
  });

  it("names the twin disagreement when every merged PR is sized", () => {
    expect(
      median(facts({ merged: 4, sized: 4, medianSize: 120 }, true))
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 120,
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
  });
});

describe("Merge rate from producer facts", () => {
  it("is merged over merged plus closed-unmerged", () => {
    expect(mergeRate(facts({ merged: 3, closedUnmerged: 1 }))).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 75,
    });
  });

  it("is a real zero when PRs closed and none merged", () => {
    expect(mergeRate(facts({ merged: 0, closedUnmerged: 2 }))).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 0,
    });
  });

  it("is Not applicable when nothing was decided and the twins agree", () => {
    expect(mergeRate(facts({ merged: 0, closedUnmerged: 0 }))).toEqual({
      state: BranchMetricAvailability.NotApplicable,
      value: null,
    });
  });

  it("is Unavailable when nothing was decided but twins disagreed", () => {
    expect(mergeRate(facts({}, true))).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  it("reports decided rows against decided identities when twins disagreed", () => {
    expect(
      mergeRate(
        facts({ merged: 3, closedUnmerged: 1, decidedIdentities: 5 }, true)
      )
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 75,
      coverage: { included: 4, total: 5 },
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
  });

  it("is Unavailable for a window the producer folded no facts for", () => {
    expect(mergeRate({ conflicted: false, windows: new Map() })).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });
});

/**
 * ISS-9959: a producer that folds its own counts still cannot see a pull request
 * its source never recorded, so the coverage gaps decide the facts path's
 * completeness exactly as they decide the evidence path's.
 */
describe("producer facts beside an ISS-9959 coverage gap", () => {
  const GAP = [{ branchId: "branch-a", occurredAt: null }];

  it("stars Median PR size instead of publishing it Complete", () => {
    const pullRequestFacts = facts({ merged: 2, sized: 2, medianSize: 40 });

    expect(
      calculateBranchListMetrics({ ...baseInput(), pullRequestFacts }, WINDOWS)
        .medianPrSize.current
    ).toEqual({ state: BranchMetricAvailability.Complete, value: 40 });
    expect(
      calculateBranchListMetrics(
        {
          ...baseInput(),
          pullRequestFacts,
          pullRequestCoverageGaps: GAP,
        },
        WINDOWS
      ).medianPrSize.current
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 40,
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
  });

  it("stars Merge rate and withholds the decided pair the gap undercounts", () => {
    expect(
      calculateBranchListMetrics(
        {
          ...baseInput(),
          pullRequestFacts: facts({
            merged: 3,
            closedUnmerged: 1,
            decidedIdentities: 4,
          }),
          pullRequestCoverageGaps: GAP,
        },
        WINDOWS
      ).mergeRatePct.current
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 75,
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
  });

  it("leaves an undecided window Unavailable rather than Not applicable", () => {
    expect(
      calculateBranchListMetrics(
        {
          ...baseInput(),
          pullRequestFacts: facts({ merged: 0, closedUnmerged: 0 }),
          pullRequestCoverageGaps: GAP,
        },
        WINDOWS
      ).mergeRatePct.current
    ).toEqual({ state: BranchMetricAvailability.Unavailable, value: null });
  });

  it("clears a window no gap reaches, from the same supplied list", () => {
    expect(
      calculateBranchListMetrics(
        {
          ...baseInput(),
          pullRequestFacts: facts({ merged: 2, sized: 2, medianSize: 40 }),
          pullRequestCoverageGaps: [
            { branchId: "branch-a", occurredAt: "2020-01-01T00:00:00.000Z" },
          ],
        },
        WINDOWS
      ).medianPrSize.current
    ).toEqual({ state: BranchMetricAvailability.Complete, value: 40 });
  });
});

describe("producer facts against pull-request evidence", () => {
  it("answers from the facts and never from the evidence beside them", () => {
    const input = {
      ...baseInput(),
      pullRequests: [
        {
          identity: "acme/web#1",
          mergedAt: "2026-08-01T00:00:00.000Z",
          closedAt: "2026-08-01T00:00:00.000Z",
          additions: 999,
          deletions: 1,
        },
      ],
      pullRequestFacts: facts({ merged: 2, sized: 2, medianSize: 7 }),
    };
    const bundle = calculateBranchListMetrics(input, WINDOWS);

    expect(bundle.medianPrSize.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 7,
    });
  });

  it("counts a closed draft as closed-unmerged and an open one as undecided", () => {
    const input = {
      ...baseInput(),
      pullRequests: [
        {
          identity: "acme/web#1",
          mergedAt: "2026-08-01T00:00:00.000Z",
          closedAt: null,
          additions: 1,
          deletions: 1,
        },
        {
          identity: "acme/web#2",
          mergedAt: null,
          closedAt: "2026-08-01T00:00:00.000Z",
          additions: 1,
          deletions: 1,
        },
        {
          identity: "acme/web#3",
          mergedAt: null,
          closedAt: null,
          additions: 1,
          deletions: 1,
        },
      ],
    };

    expect(
      calculateBranchListMetrics(input, WINDOWS).mergeRatePct.current
    ).toEqual({ state: BranchMetricAvailability.Complete, value: 50 });
  });
});

describe("a producer that sends neither facts nor evidence", () => {
  it("leaves both metrics Unavailable rather than reading an empty population", () => {
    const { pullRequests, pullRequestCoverageComplete, ...input } = baseInput();

    const bundle = calculateBranchListMetrics(input, WINDOWS);

    expect(pullRequests).toEqual([]);
    expect(pullRequestCoverageComplete).toBe(true);
    for (const metric of [bundle.medianPrSize, bundle.mergeRatePct]) {
      expect(metric.current).toEqual({
        state: BranchMetricAvailability.Unavailable,
        value: null,
      });
    }
  });

  it("is Unavailable when only one of the two evidence fields arrives", () => {
    const { pullRequestCoverageComplete, ...input } = baseInput();

    expect(pullRequestCoverageComplete).toBe(true);
    expect(
      calculateBranchListMetrics(input, WINDOWS).medianPrSize.current.state
    ).toBe(BranchMetricAvailability.Unavailable);
  });
});

describe("every window the fold asks about", () => {
  it.each([
    BranchMetricPeriod.SevenDays,
    BranchMetricPeriod.ThirtyDays,
    BranchMetricPeriod.NinetyDays,
  ])("has facts to answer from for a %s request", (period) => {
    const windows = buildAdjacentBranchMetricWindows(period, NOW);
    const asked = branchMetricFactWindows(windows);
    const pullRequestFacts: BranchMetricPullRequestFacts = {
      conflicted: false,
      windows: new Map(
        asked.map((window, index) => [
          branchMetricWindowKey(window),
          {
            merged: 2,
            sized: 2,
            medianSize: 10 + index,
            closedUnmerged: 1,
            decidedIdentities: 3,
          },
        ])
      ),
    };

    const bundle = calculateBranchListMetrics(
      { ...baseInput(), pullRequestFacts },
      windows
    );

    for (const metric of [bundle.medianPrSize, bundle.mergeRatePct]) {
      expect(metric.current.state).toBe(BranchMetricAvailability.Complete);
      expect(metric.comparison).toBeDefined();
      expect(metric.series?.every((point) => point !== null)).toBe(true);
    }
  });
});

describe("a custom date range", () => {
  const START = new Date("2026-07-10T00:00:00.000Z");
  const END = new Date("2026-07-23T00:00:00.000Z");
  const range = { startDate: START, endDate: END, now: NOW };
  const requestedWindow = {
    startAt: START.toISOString(),
    endAt: END.toISOString(),
  };

  it("asks the pull-request fold about the requested bounds, beside the all-time window", () => {
    const windows = resolveCanonicalBranchMetricWindows(range);

    expect(windows.requested).toEqual(requestedWindow);
    expect(windows.current.startAt).toBeNull();
    expect(
      branchMetricFactWindows(windows).map(branchMetricWindowKey)
    ).toContain(branchMetricWindowKey(requestedWindow));
  });

  it("publishes the requested range's facts for the PR metrics and all-time for the rest", () => {
    const windows = resolveCanonicalBranchMetricWindows(range);
    const pullRequestFacts: BranchMetricPullRequestFacts = {
      conflicted: false,
      windows: new Map([
        [
          branchMetricWindowKey(requestedWindow),
          {
            merged: 1,
            sized: 1,
            medianSize: 42,
            closedUnmerged: 1,
            decidedIdentities: 2,
          },
        ],
      ]),
    };

    const bundle = calculateBranchListMetrics(
      { ...baseInput(), pullRequestFacts },
      windows
    );

    expect(bundle.medianPrSize.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 42,
    });
    expect(bundle.mergeRatePct.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 50,
    });
    // The all-time window has no facts, so a fold that read it would say so.
    expect(bundle.medianPrSize.series).toBeUndefined();
  });

  it("counts only the pull requests decided inside the requested range", () => {
    const windows = resolveCanonicalBranchMetricWindows(range);
    const pullRequests = [
      {
        identity: "a#1",
        mergedAt: "2026-07-12T00:00:00.000Z",
        closedAt: null,
        additions: 10,
        deletions: 0,
      },
      {
        identity: "a#2",
        mergedAt: "2026-06-01T00:00:00.000Z",
        closedAt: null,
        additions: 999,
        deletions: 0,
      },
      {
        identity: "a#3",
        mergedAt: null,
        closedAt: "2026-07-13T00:00:00.000Z",
        additions: 5,
        deletions: 0,
      },
      {
        identity: "a#4",
        mergedAt: null,
        closedAt: "2026-07-23T00:00:00.000Z",
        additions: 5,
        deletions: 0,
      },
    ];

    const bundle = calculateBranchListMetrics(
      { ...baseInput(), pullRequests },
      windows
    );

    expect(bundle.medianPrSize.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 10,
    });
    expect(bundle.mergeRatePct.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 50,
    });
  });

  it("leaves a true all-time request, and a preset, without a requested window", () => {
    expect(
      resolveCanonicalBranchMetricWindows({ now: NOW }).requested
    ).toBeUndefined();
    expect(
      resolveCanonicalBranchMetricWindows({
        startDate: new Date(NOW.getTime() - 7 * 86_400_000),
        endDate: NOW,
        now: NOW,
      }).requested
    ).toBeUndefined();
  });
});

describe("branchMetricFactWindows", () => {
  it("lists the current window, the prior window and every series bucket once", () => {
    const listed = branchMetricFactWindows(WINDOWS);
    const keys = listed.map(branchMetricWindowKey);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(branchMetricWindowKey(WINDOWS.current));
    expect(keys).toContain(
      branchMetricWindowKey(WINDOWS.prior as NonNullable<typeof WINDOWS.prior>)
    );
    // Seven daily buckets: each one is a window the fold will ask about.
    expect(listed.length).toBe(9);
  });

  it("lists only the unbounded window for all time", () => {
    const allTime = buildAdjacentBranchMetricWindows(
      BranchMetricPeriod.All,
      NOW
    );

    expect(branchMetricFactWindows(allTime)).toEqual([allTime.current]);
  });

  it("keys an unbounded start differently from a bounded one", () => {
    expect(branchMetricWindowKey({ startAt: null, endAt: "b" })).not.toBe(
      branchMetricWindowKey({ startAt: "a", endAt: "b" })
    );
  });
});

function facts(
  counts: Partial<BranchMetricPullRequestWindowFacts>,
  conflicted = false
): BranchMetricPullRequestFacts {
  return {
    conflicted,
    windows: new Map([
      [
        branchMetricWindowKey(WINDOWS.current),
        {
          merged: 0,
          sized: 0,
          medianSize: null,
          closedUnmerged: 0,
          decidedIdentities: 0,
          ...counts,
        },
      ],
    ]),
  };
}

function median(pullRequestFacts: BranchMetricPullRequestFacts) {
  return calculateBranchListMetrics(
    { ...baseInput(), pullRequestFacts },
    WINDOWS
  ).medianPrSize.current;
}

function mergeRate(pullRequestFacts: BranchMetricPullRequestFacts) {
  return calculateBranchListMetrics(
    { ...baseInput(), pullRequestFacts },
    WINDOWS
  ).mergeRatePct.current;
}

function baseInput(): BranchListMetricInput {
  return {
    cohortSize: 1,
    lastActiveCoverageComplete: true,
    lastActiveEvents: [],
    statusSnapshots: [],
    locContributions: [],
    locCompleteBranchIds: [],
    pullRequests: [],
    pullRequestCoverageComplete: true,
    costContributions: [],
    costCompleteBranchIds: [],
  };
}
