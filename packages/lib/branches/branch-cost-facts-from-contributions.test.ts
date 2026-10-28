import { BranchMetricPeriod } from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import type { BranchMetricCostContribution } from "./branch-cost-evidence";
import { costFactsFromContributions } from "./branch-cost-facts-from-contributions";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";
import {
  branchMetricFactWindows,
  branchMetricWindowKey,
} from "./branch-pull-request-metrics";

const NOW = new Date("2026-08-03T21:00:00.000Z");
const WINDOWS = buildAdjacentBranchMetricWindows(
  BranchMetricPeriod.SevenDays,
  NOW
);
const CURRENT = "2026-08-01T12:00:00.000Z";
const PRIOR = "2026-07-25T12:00:00.000Z";

function event(
  overrides: Partial<BranchMetricCostContribution> = {}
): BranchMetricCostContribution {
  return {
    sourceEventId: "event-1",
    branchId: "a",
    sessionId: "session-1",
    occurredAt: CURRENT,
    costUsd: 10,
    qualifyingBranchCount: 1,
    ...overrides,
  };
}

function currentFacts(contributions: BranchMetricCostContribution[]) {
  const facts = costFactsFromContributions(
    contributions,
    branchMetricFactWindows(WINDOWS)
  );
  return {
    holds: facts.cohortHoldsEvents,
    current: facts.windows.get(branchMetricWindowKey(WINDOWS.current)),
    prior: WINDOWS.prior
      ? facts.windows.get(branchMetricWindowKey(WINDOWS.prior))
      : undefined,
  };
}

describe("costFactsFromContributions", () => {
  it("places an event in the window that holds its instant, and only that one", () => {
    const { current, prior } = currentFacts([
      event(),
      event({ sourceEventId: "event-2", occurredAt: PRIOR, costUsd: 3 }),
    ]);

    expect(current).toEqual({ spendUsd: 10, included: 1, unusable: 0 });
    expect(prior).toEqual({ spendUsd: 3, included: 1, unusable: 0 });
  });

  it("counts a repeated session event once", () => {
    const { current } = currentFacts([event(), event()]);

    expect(current).toEqual({ spendUsd: 10, included: 1, unusable: 0 });
  });

  it("takes the cohort's share of an event split across branches", () => {
    const { current } = currentFacts([
      event({ branchId: "a", costUsd: 60, qualifyingBranchCount: 3 }),
      event({ branchId: "b", costUsd: 60, qualifyingBranchCount: 3 }),
    ]);

    expect(current?.spendUsd).toBeCloseTo(40, 12);
    expect(current?.included).toBe(1);
  });

  it.each([
    { label: "an unknown cost", overrides: { costUsd: null } },
    { label: "a negative cost", overrides: { costUsd: -1 } },
    { label: "a missing divisor", overrides: { qualifyingBranchCount: null } },
    { label: "a zero divisor", overrides: { qualifyingBranchCount: 0 } },
  ])(
    "counts an event with $label as unusable, not as zero",
    ({ overrides }) => {
      const { current } = currentFacts([
        event({ sourceEventId: "good", costUsd: 4 }),
        event({ sourceEventId: "bad", ...overrides }),
      ]);

      expect(current).toEqual({ spendUsd: 4, included: 1, unusable: 1 });
    }
  );

  it.each([null, "not-a-timestamp"])(
    "counts an event whose instant is %s as unusable in every window",
    (occurredAt) => {
      const { current, prior } = currentFacts([event({ occurredAt })]);

      expect(current).toEqual({ spendUsd: 0, included: 0, unusable: 1 });
      expect(prior).toEqual({ spendUsd: 0, included: 0, unusable: 1 });
    }
  );

  it("reports that the cohort holds events even when none fall in the window", () => {
    const outside = currentFacts([
      event({ occurredAt: "2026-01-01T00:00:00.000Z" }),
    ]);

    expect(outside.holds).toBe(true);
    expect(outside.current).toEqual({ spendUsd: 0, included: 0, unusable: 0 });
    expect(currentFacts([]).holds).toBe(false);
  });
});
