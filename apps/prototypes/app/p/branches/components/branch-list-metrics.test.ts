import { describe, expect, it } from "vitest";
import { BranchStatus, DateRange } from "../mock";
import {
  BRANCH_METRIC_FIXTURE_NOW,
  branchActiveState,
  branchMetricEvidence,
  branchPrototypeReviewFixture,
  buildGeneratedBranchFixture,
} from "./branch-list-fixtures";
import {
  CostPhase,
  MetricAvailability,
  MetricDisclosure,
} from "./branch-list-metric-types";
import { calculateBranchListMetrics } from "./branch-list-metrics";

describe("Branch list metric projection", () => {
  it("keeps 100 and 101 rows on one uncapped path", () => {
    const hundred = buildGeneratedBranchFixture(100);
    const hundredOne = buildGeneratedBranchFixture(101);
    const hundredMetrics = calculateBranchListMetrics(
      hundred.rows.map((row) => row.id),
      hundred.evidence,
      DateRange.ThirtyDays,
      BRANCH_METRIC_FIXTURE_NOW
    );
    const hundredOneMetrics = calculateBranchListMetrics(
      hundredOne.rows.map((row) => row.id),
      hundredOne.evidence,
      DateRange.ThirtyDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(hundredMetrics.aiSpendUsd.current.state).toBe(
      MetricAvailability.Complete
    );
    expect(hundredOneMetrics.aiSpendUsd.current.state).toBe(
      MetricAvailability.Complete
    );
    expect(metricNumber(hundredOneMetrics.aiSpendUsd.current)).toBeGreaterThan(
      metricNumber(hundredMetrics.aiSpendUsd.current)
    );
  });

  it("deduplicates exact identities but adds equal-looking subscription and API costs", () => {
    const fixture = buildGeneratedBranchFixture(1);
    const branchId = fixture.rows[0]?.id as string;
    const metrics = calculateBranchListMetrics(
      [branchId],
      fixture.evidence,
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metricNumber(metrics.aiSpendUsd.current)).toBe(2);
  });

  it("keeps the global shared-Session divisor when the sibling Branch is filtered out", () => {
    const onlyAwaiting = calculateBranchListMetrics(
      ["br_awaiting_sync"],
      branchMetricEvidence,
      DateRange.NinetyDays,
      BRANCH_METRIC_FIXTURE_NOW
    );
    const bothBranches = calculateBranchListMetrics(
      ["br_awaiting_sync", "br_1284"],
      branchMetricEvidence,
      DateRange.NinetyDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metricNumber(onlyAwaiting.aiSpendUsd.current)).toBe(75);
    expect(metricNumber(bothBranches.aiSpendUsd.current)).toBe(180);
  });

  it("projects per-Session timestamps across selected windows", () => {
    const week = calculateBranchListMetrics(
      ["br_1284"],
      branchMetricEvidence,
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );
    const quarter = calculateBranchListMetrics(
      ["br_1284"],
      branchMetricEvidence,
      DateRange.NinetyDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metricNumber(week.aiSpendUsd.current)).toBe(45);
    expect(metricNumber(quarter.aiSpendUsd.current)).toBe(105);
  });

  it("scopes unavailable cost evidence to the selected window", () => {
    const week = calculateBranchListMetrics(
      ["br_1289"],
      branchMetricEvidence,
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );
    const month = calculateBranchListMetrics(
      ["br_1289"],
      branchMetricEvidence,
      DateRange.ThirtyDays,
      BRANCH_METRIC_FIXTURE_NOW
    );
    const quarter = calculateBranchListMetrics(
      ["br_1289"],
      branchMetricEvidence,
      DateRange.NinetyDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(week.aiSpendUsd.current).toMatchObject({
      state: MetricAvailability.Complete,
      value: 100,
    });
    expect(month.aiSpendUsd.current).toMatchObject({
      state: MetricAvailability.Complete,
      value: 240,
    });
    expect(quarter.aiSpendUsd.current).toMatchObject({
      state: MetricAvailability.Partial,
      value: 280,
    });
    expect(week.locPerDollar.current.state).toBe(MetricAvailability.Complete);
    expect(month.locPerDollar.current.state).toBe(MetricAvailability.Complete);
    expect(quarter.locPerDollar.current.state).toBe(
      MetricAvailability.Unavailable
    );
    expect(week.aiSpendUsd.comparison?.deltaPct.state).toBe(
      MetricAvailability.Complete
    );
    expect(month.aiSpendUsd.comparison?.deltaPct.state).toBe(
      MetricAvailability.Complete
    );
  });

  it("keeps Sessions with all-null cost evidence unavailable", () => {
    const metrics = calculateBranchListMetrics(
      ["br_unpriced_sessions"],
      branchMetricEvidence,
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metrics.aiSpendUsd.current.state).toBe(
      MetricAvailability.Unavailable
    );
    expect(metrics.locPerDollar.current.state).toBe(
      MetricAvailability.Unavailable
    );
  });

  it("uses ratio of totals and fails closed when a complete pair is missing", () => {
    const fixture = buildGeneratedBranchFixture(2);
    const ids = fixture.rows.map((row) => row.id);
    const complete = calculateBranchListMetrics(
      ids,
      fixture.evidence,
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );
    const incomplete = calculateBranchListMetrics(
      ids,
      { ...fixture.evidence, costCompleteBranchIds: [ids[0] as string] },
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(complete.locPerDollar.current.state).toBe(
      MetricAvailability.Complete
    );
    expect(incomplete.locPerDollar.current.state).toBe(
      MetricAvailability.Partial
    );
  });

  it("uses half-open event windows and suppresses incomplete comparisons", () => {
    const fixture = buildGeneratedBranchFixture(1);
    const branchId = fixture.rows[0]?.id as string;
    const boundaryEvidence = {
      ...fixture.evidence,
      costContributions: [
        {
          sourceEventId: "at-end",
          branchId,
          sessionId: "session-at-end",
          occurredAt: BRANCH_METRIC_FIXTURE_NOW.toISOString(),
          phase: CostPhase.Build,
          costUsd: 50,
          qualifyingBranchCount: 1,
        },
      ],
      costCompleteBranchIds: [branchId],
    };
    const metrics = calculateBranchListMetrics(
      [branchId],
      boundaryEvidence,
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metrics.aiSpendUsd.current.state).toBe(
      MetricAvailability.Unavailable
    );
    expect(metrics.aiSpendUsd.comparison?.deltaPct.state).not.toBe(
      MetricAvailability.Complete
    );
  });

  it("returns distinct no-data, N/A, and known-zero states", () => {
    const fixture = buildGeneratedBranchFixture(1);
    const empty = calculateBranchListMetrics(
      [],
      fixture.evidence,
      DateRange.ThirtyDays,
      BRANCH_METRIC_FIXTURE_NOW
    );
    const noOutcomes = calculateBranchListMetrics(
      [fixture.rows[0]?.id as string],
      { ...fixture.evidence, pullRequests: [] },
      DateRange.ThirtyDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(empty.activeBranches.current.state).toBe(MetricAvailability.NoData);
    expect(noOutcomes.mergeRatePct.current.state).toBe(
      MetricAvailability.NotApplicable
    );
    expect(noOutcomes.aiSpendUsd.current.state).toBe(
      MetricAvailability.Complete
    );
  });

  it("counts active status snapshots without fabricating unknown history", () => {
    const fixture = buildGeneratedBranchFixture(3);
    const ids = fixture.rows.map((row) => row.id);
    const metrics = calculateBranchListMetrics(
      ids,
      {
        ...fixture.evidence,
        statusSnapshots: ids.map((branchId, index) => ({
          branchId,
          currentActive: index !== 1,
          priorActiveByRange: {
            [DateRange.SevenDays]: true,
            [DateRange.ThirtyDays]: index === 0 ? null : true,
            [DateRange.NinetyDays]: false,
          },
        })),
      },
      DateRange.ThirtyDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metricNumber(metrics.activeBranches.current)).toBe(2);
    expect(metrics.activeBranches.comparison?.deltaPct.state).toBe(
      MetricAvailability.Unavailable
    );
  });

  it("keeps prior active snapshots distinct for each finite range", () => {
    const fixture = buildGeneratedBranchFixture(1);
    const branchId = fixture.rows[0]?.id as string;
    const evidence = {
      ...fixture.evidence,
      statusSnapshots: [
        {
          branchId,
          currentActive: true,
          priorActiveByRange: {
            [DateRange.SevenDays]: true,
            [DateRange.ThirtyDays]: false,
            [DateRange.NinetyDays]: null,
          },
        },
      ],
    };

    const week = calculateBranchListMetrics(
      [branchId],
      evidence,
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );
    const quarter = calculateBranchListMetrics(
      [branchId],
      evidence,
      DateRange.NinetyDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(week.activeBranches.comparison?.deltaPct.state).toBe(
      MetricAvailability.Complete
    );
    expect(quarter.activeBranches.comparison?.deltaPct.state).toBe(
      MetricAvailability.Unavailable
    );
  });

  it("derives evidence only from relationships present on each authored row", () => {
    expect(
      branchMetricEvidence.costContributions.some(
        (item) => item.branchId === "br_dependabot"
      )
    ).toBe(false);
    expect(
      branchMetricEvidence.costContributions.some(
        (item) => item.branchId === "br_unpriced_sessions"
      )
    ).toBe(false);
    expect(
      branchMetricEvidence.pullRequests.some(
        (item) => item.branchId === "br_session_cost"
      )
    ).toBe(false);
  });

  it("keeps displayed relative activity aligned with the fixture clock", () => {
    const row = branchPrototypeReviewFixture.rows.find(
      (item) => item.id === "br_session_cost"
    );

    expect(row?.lastActivityLabel).toBe("10h ago");
  });

  it("deduplicates PR identities and computes an even median", () => {
    const fixture = buildGeneratedBranchFixture(1);
    const branchId = fixture.rows[0]?.id as string;
    const first = {
      identity: "pr-1",
      branchId,
      mergedAt: "2026-07-27T12:00:00.000Z",
      closedAt: "2026-07-27T12:00:00.000Z",
      isDraft: false,
      additions: 8,
      deletions: 2,
    };
    const metrics = calculateBranchListMetrics(
      [branchId],
      {
        ...fixture.evidence,
        pullRequests: [
          first,
          first,
          { ...first, identity: "pr-2", additions: 25, deletions: 5 },
        ],
      },
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metricNumber(metrics.medianPrSize.current)).toBe(20);
  });

  it("uses only distinct merged and closed-undrafted outcomes for merge rate", () => {
    const fixture = buildGeneratedBranchFixture(1);
    const branchId = fixture.rows[0]?.id as string;
    const at = "2026-07-27T12:00:00.000Z";
    const base = {
      branchId,
      additions: 1,
      deletions: 1,
    };
    const metrics = calculateBranchListMetrics(
      [branchId],
      {
        ...fixture.evidence,
        pullRequests: [
          {
            ...base,
            identity: "merged",
            mergedAt: at,
            closedAt: at,
            isDraft: false,
          },
          {
            ...base,
            identity: "closed",
            mergedAt: null,
            closedAt: at,
            isDraft: false,
          },
          {
            ...base,
            identity: "draft",
            mergedAt: null,
            closedAt: at,
            isDraft: true,
          },
          {
            ...base,
            identity: "open",
            mergedAt: null,
            closedAt: null,
            isDraft: false,
          },
        ],
      },
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metricNumber(metrics.mergeRatePct.current)).toBe(50);
  });

  it("renders LOC per dollar as N/A for a complete zero denominator", () => {
    const fixture = buildGeneratedBranchFixture(1);
    const branchId = fixture.rows[0]?.id as string;
    const metrics = calculateBranchListMetrics(
      [branchId],
      {
        ...fixture.evidence,
        costContributions: fixture.evidence.costContributions.map((item) => ({
          ...item,
          costUsd: 0,
        })),
      },
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metrics.locPerDollar.current.state).toBe(
      MetricAvailability.NotApplicable
    );
  });

  it.each([
    [BranchStatus.Merged, false],
    [BranchStatus.Closed, false],
    [BranchStatus.Canceled, false],
    [BranchStatus.Open, true],
    [BranchStatus.Draft, true],
    [BranchStatus.Review, true],
    [BranchStatus.Blocked, true],
    [null, null],
    ["future-status", null],
  ])("classifies %s as %s for current and prior snapshots", (status, active) => {
    expect(branchActiveState(status)).toBe(active);
  });

  it("fails conflicting snapshots closed but preserves a missing-status subtotal", () => {
    const fixture = buildGeneratedBranchFixture(2);
    const ids = fixture.rows.map((row) => row.id);
    const duplicate = fixture.evidence.statusSnapshots[0];
    const metrics = calculateBranchListMetrics(
      ids,
      {
        ...fixture.evidence,
        statusSnapshots: duplicate
          ? [...fixture.evidence.statusSnapshots, duplicate]
          : fixture.evidence.statusSnapshots,
      },
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );
    const missing = calculateBranchListMetrics(
      ids,
      { ...fixture.evidence, statusSnapshots: [] },
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metrics.activeBranches.current.state).toBe(
      MetricAvailability.Unavailable
    );
    expect(metrics.locPerDollar.current.state).toBe(
      MetricAvailability.Unavailable
    );
    expect(missing.activeBranches.current).toEqual({
      state: MetricAvailability.Partial,
      value: 0,
      disclosure: MetricDisclosure.DefaultIncomplete,
    });
    expect(missing.locPerDollar.current.state).toBe(
      MetricAvailability.Unavailable
    );
  });

  it("fails finite-window missing LOC closed while retaining explicit zero", () => {
    const fixture = buildGeneratedBranchFixture(1);
    const branchId = fixture.rows[0]?.id as string;
    const metrics = calculateBranchListMetrics(
      [branchId],
      { ...fixture.evidence, locContributions: [] },
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metrics.locPerDollar.current.state).toBe(
      MetricAvailability.Unavailable
    );

    const explicitZero = calculateBranchListMetrics(
      [branchId],
      {
        ...fixture.evidence,
        locContributions: fixture.evidence.locContributions.map((item) =>
          item.occurredAt === "2026-07-27T12:00:00.000Z"
            ? { ...item, additions: 0, deletions: 0 }
            : item
        ),
      },
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );
    expect(explicitZero.locPerDollar.current).toEqual({
      state: MetricAvailability.Complete,
      value: 0,
    });
  });

  it.each([
    ["empty identity", { sourceEventId: "" }],
    ["null timestamp", { occurredAt: null }],
    ["malformed timestamp", { occurredAt: "not-a-date" }],
    ["future timestamp", { occurredAt: "2026-07-30T00:00:00.000Z" }],
    ["malformed value", { costUsd: Number.NaN }],
  ])("fails AI spend closed for %s", (_label, mutation) => {
    const fixture = buildGeneratedBranchFixture(1);
    const branchId = fixture.rows[0]?.id as string;
    const first = fixture.evidence.costContributions[0];
    if (!first) {
      throw new Error("Expected cost fixture");
    }
    const metrics = calculateBranchListMetrics(
      [branchId],
      {
        ...fixture.evidence,
        costContributions: [{ ...first, ...mutation }],
      },
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metrics.aiSpendUsd.current.state).toBe(
      MetricAvailability.Unavailable
    );
  });

  it("fails LOC closed for null, malformed, and future timestamps", () => {
    const fixture = buildGeneratedBranchFixture(1);
    const branchId = fixture.rows[0]?.id as string;
    const first = fixture.evidence.locContributions[0];
    if (!first) {
      throw new Error("Expected LOC fixture");
    }

    for (const occurredAt of [null, "not-a-date", "2026-07-30T00:00:00.000Z"]) {
      const metrics = calculateBranchListMetrics(
        [branchId],
        {
          ...fixture.evidence,
          locContributions: [{ ...first, occurredAt }],
        },
        DateRange.SevenDays,
        BRANCH_METRIC_FIXTURE_NOW
      );
      expect(metrics.locPerDollar.current.state).toBe(
        MetricAvailability.Unavailable
      );
    }
  });

  it("includes undated lifetime LOC only in the all-time window", () => {
    const fixture = buildGeneratedBranchFixture(1);
    const branchId = fixture.rows[0]?.id as string;
    const first = fixture.evidence.locContributions[0];
    if (!first) {
      throw new Error("Expected LOC fixture");
    }
    const metrics = calculateBranchListMetrics(
      [branchId],
      {
        ...fixture.evidence,
        locContributions: [{ ...first, occurredAt: null }],
      },
      DateRange.All,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metrics.locPerDollar.current.state).toBe(
      MetricAvailability.Complete
    );
    expect(metricNumber(metrics.locPerDollar.current)).toBeGreaterThan(0);
  });

  it("makes an all-conflicted PR population unavailable", () => {
    const fixture = buildGeneratedBranchFixture(1);
    const branchId = fixture.rows[0]?.id as string;
    const first = fixture.evidence.pullRequests[0];
    if (!first) {
      throw new Error("Expected pull request fixture");
    }
    const metrics = calculateBranchListMetrics(
      [branchId],
      {
        ...fixture.evidence,
        pullRequests: [
          first,
          { ...first, additions: (first.additions ?? 0) + 1 },
        ],
      },
      DateRange.SevenDays,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metrics.medianPrSize.current.state).toBe(
      MetricAvailability.Unavailable
    );
  });
});

function metricNumber(result: { value: number | null }): number {
  if (result.value === null) {
    throw new Error("Expected numeric metric fixture");
  }
  return result.value;
}
