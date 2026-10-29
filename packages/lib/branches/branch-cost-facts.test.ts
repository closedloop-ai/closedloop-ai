import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import type {
  BranchMetricCostFacts,
  BranchMetricCostWindowFacts,
} from "./branch-cost-facts";
import { resolveCanonicalBranchMetricWindows } from "./branch-list-metric-projection";
import {
  type BranchListMetricInput,
  calculateBranchListMetrics,
} from "./branch-list-metrics";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";
import { BranchPublicationLocSource } from "./branch-publication-loc";
import {
  branchMetricFactWindows,
  branchMetricWindowKey,
} from "./branch-pull-request-metrics";

/** ISS-12346: AI spend and every LOC per $ read the producer's cost facts. */

const NOW = new Date("2026-08-03T21:00:00.000Z");
const CURRENT = "2026-08-01T12:00:00.000Z";
const WINDOWS = buildAdjacentBranchMetricWindows(
  BranchMetricPeriod.SevenDays,
  NOW
);

/** ISS-12361: a producer with no pushed LOC folds spend alone from the facts. */
describe("AI spend facts without the pushed-LOC switch", () => {
  it("reads the spend from the facts and ignores the cost contributions", () => {
    const result = calculateBranchListMetrics(
      {
        ...input(),
        aiSpendFacts: facts({ spendUsd: 25, included: 3, unusable: 0 }),
        costContributions: [
          {
            sourceEventId: "event-1",
            sessionId: "session-1",
            branchId: "a",
            occurredAt: CURRENT,
            costUsd: 999,
            qualifyingBranchCount: 1,
          },
        ],
        costCompleteBranchIds: ["a"],
      },
      WINDOWS
    );

    expect(result.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 25,
    });
  });

  it("keeps LOC per $ on the evidence path while Pushed LOC per $ follows the spend card", () => {
    const withFacts = calculateBranchListMetrics(
      {
        ...input(),
        aiSpendFacts: facts({ spendUsd: 25, included: 3, unusable: 0 }),
      },
      WINDOWS
    );
    const withoutFacts = calculateBranchListMetrics(input(), WINDOWS);

    expect(withFacts.locPerDollar).toEqual(withoutFacts.locPerDollar);
    // 100 pushed lines over the card's $25: one spend fold behind both.
    expect(withFacts.pushedLocPerDollar?.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 4,
    });
    expect(withoutFacts.pushedLocPerDollar?.current.state).not.toBe(
      BranchMetricAvailability.Complete
    );
  });

  it("names the cost as short when an event was unusable", () => {
    const result = calculateBranchListMetrics(
      {
        ...input(),
        aiSpendFacts: facts({ spendUsd: 25, included: 3, unusable: 2 }),
      },
      WINDOWS
    );

    expect(result.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 25,
      disclosure: BranchMetricDisclosure.CostIncomplete,
    });
  });
});

describe("AI spend from producer cost facts", () => {
  it("publishes the window's spend as complete when every event was usable", () => {
    const result = metrics({ spendUsd: 25, included: 3, unusable: 0 });

    expect(result.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 25,
    });
  });

  it("keeps the spend it could read and names the cost as short when an event was unusable", () => {
    const result = metrics({ spendUsd: 25, included: 3, unusable: 1 });

    expect(result.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 25,
      disclosure: BranchMetricDisclosure.CostIncomplete,
    });
  });

  it("keeps an all-unpriced window Partial rather than hiding it (ISS-12346 C6)", () => {
    const result = metrics({ spendUsd: 0, included: 0, unusable: 1 });

    expect(result.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 0,
      disclosure: BranchMetricDisclosure.CostIncomplete,
    });
    // The series point is the same fold narrowed, so it must publish too.
    expect(result.aiSpendUsd.series?.some((point) => point !== null)).toBe(
      true
    );
  });

  it("publishes a real zero when the cohort holds events but none fall in the window", () => {
    const result = metrics({ spendUsd: 0, included: 0, unusable: 0 });

    expect(result.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 0,
    });
  });

  it("is unavailable, not zero, when the cohort holds no cost events at all", () => {
    const result = metrics(
      { spendUsd: 0, included: 0, unusable: 0 },
      { cohortHoldsEvents: false }
    );

    expect(result.aiSpendUsd.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("is unavailable when the producer sent no facts for the window", () => {
    const result = calculateBranchListMetrics(
      {
        ...input(),
        costFacts: { cohortHoldsEvents: true, windows: new Map() },
      },
      WINDOWS
    );

    expect(result.aiSpendUsd.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("reads the facts and ignores any cost contributions beside them", () => {
    const result = calculateBranchListMetrics(
      {
        ...input(),
        costContributions: [
          {
            sourceEventId: "stale",
            branchId: "a",
            sessionId: "session-stale",
            occurredAt: CURRENT,
            costUsd: 999,
            qualifyingBranchCount: 1,
          },
        ],
        costFacts: facts({ spendUsd: 5, included: 1, unusable: 0 }),
      },
      WINDOWS
    );

    expect(result.aiSpendUsd.current.value).toBe(5);
  });
});

describe("every LOC per $ is pushed LOC over that spend", () => {
  it("divides pushed lines by the window's spend on the list and canonical cards", () => {
    const result = metrics({ spendUsd: 25, included: 3, unusable: 0 });

    expect(result.locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 4,
    });
    expect(result.canonicalLocPerDollar?.current).toEqual(
      result.locPerDollar.current
    );
    expect(result.pushedLocPerDollar?.current).toEqual(
      result.locPerDollar.current
    );
  });

  it("names the cost as the short term when an event was unusable", () => {
    const result = metrics({ spendUsd: 25, included: 3, unusable: 1 });

    expect(result.locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 4,
      disclosure: BranchMetricDisclosure.CostIncomplete,
    });
  });

  it("ignores publication LOC that no push observed", () => {
    const result = calculateBranchListMetrics(
      {
        ...input(),
        locContributions: [
          {
            sourceEventId: "merged-pr",
            branchId: "a",
            occurredAt: CURRENT,
            additions: 100,
            deletions: 0,
            source: BranchPublicationLocSource.MergedPullRequest,
          },
        ],
        costFacts: facts({ spendUsd: 25, included: 3, unusable: 0 }),
      },
      WINDOWS
    );

    expect(result.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("does not apply when the window cost nothing and every line was seen", () => {
    const result = metrics({ spendUsd: 0, included: 2, unusable: 0 });

    expect(result.locPerDollar.current.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
  });
});

describe("Pensero points per $ over the same spend", () => {
  it("divides the window's spend and is not applicable over a measured zero", () => {
    const withPoints = (spendUsd: number) =>
      calculateBranchListMetrics(
        {
          ...input(),
          penseroPoints: {
            points: 50,
            hasFailedAcquisitionDay: false,
            hasAmbiguousPoints: false,
            hasUnreadablePointValues: false,
          },
          costFacts: facts({ spendUsd, included: 2, unusable: 0 }),
        },
        WINDOWS
      ).penseroPointsPerDollar?.current;

    expect(withPoints(25)?.value).toBe(2);
    expect(withPoints(0)?.state).toBe(BranchMetricAvailability.NotApplicable);
  });

  it("is Unavailable over a PARTIAL zero, which is not a measured zero", () => {
    const result = calculateBranchListMetrics(
      {
        ...input(),
        penseroPoints: PENSERO_POINTS,
        costFacts: facts({ spendUsd: 0, included: 0, unusable: 2 }),
      },
      WINDOWS
    );

    expect(result.aiSpendUsd.current.state).toBe(
      BranchMetricAvailability.Partial
    );
    expect(result.penseroPointsPerDollar?.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    // The sibling ratio over the same scalar reaches the same answer.
    expect(result.pushedLocPerDollar?.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("divides by the REQUESTED range's spend, not all-history (ISS-11117)", () => {
    // 13 days: no preset matches, so `windows.current` is all-time and only
    // `windows.requested` describes what the reader asked for.
    const requested = {
      startAt: "2026-07-10T00:00:00.000Z",
      endAt: "2026-07-23T00:00:00.000Z",
    };
    const windows = resolveCanonicalBranchMetricWindows({
      startDate: new Date(requested.startAt),
      endDate: new Date(requested.endAt),
      now: NOW,
    });
    const inRange = { spendUsd: 10, included: 1, unusable: 0 };
    // $90 spent before the range, so all-time holds $100.
    const allHistory = { spendUsd: 100, included: 2, unusable: 0 };

    expect(windows.requested).toEqual(requested);
    expect(
      calculateBranchListMetrics(
        {
          ...input(),
          penseroPoints: PENSERO_POINTS,
          costFacts: {
            cohortHoldsEvents: true,
            windows: new Map(
              branchMetricFactWindows(windows).map((entry) => [
                branchMetricWindowKey(entry),
                branchMetricWindowKey(entry) ===
                branchMetricWindowKey(requested)
                  ? inRange
                  : allHistory,
              ])
            ),
          },
        },
        windows
      ).penseroPointsPerDollar?.current.value
      // 50 points over the range's $10. Over all-history's $100 it is 0.5.
    ).toBe(5);
  });
});

const PENSERO_POINTS = {
  points: 50,
  hasFailedAcquisitionDay: false,
  hasAmbiguousPoints: false,
  hasUnreadablePointValues: false,
};

function metrics(
  window: BranchMetricCostWindowFacts,
  overrides: Partial<BranchMetricCostFacts> = {}
) {
  return calculateBranchListMetrics(
    { ...input(), costFacts: { ...facts(window), ...overrides } },
    WINDOWS
  );
}

function facts(window: BranchMetricCostWindowFacts): BranchMetricCostFacts {
  return {
    cohortHoldsEvents: true,
    windows: new Map(
      branchMetricFactWindows(WINDOWS).map((entry) => [
        branchMetricWindowKey(entry),
        window,
      ])
    ),
  };
}

function input(): BranchListMetricInput {
  return {
    cohortSize: 1,
    lastActiveEvents: [],
    lastActiveCoverageComplete: true,
    statusSnapshots: [
      { branchId: "a", currentActive: true, priorActive: true },
    ],
    locContributions: [
      {
        sourceEventId: "push-1",
        branchId: "a",
        occurredAt: CURRENT,
        additions: 100,
        deletions: 0,
        source: BranchPublicationLocSource.SuccessfulPush,
      },
    ],
    locCompleteBranchIds: ["a"],
    pullRequests: [],
    pullRequestCoverageComplete: true,
    costContributions: [],
    costCompleteBranchIds: [],
  };
}
