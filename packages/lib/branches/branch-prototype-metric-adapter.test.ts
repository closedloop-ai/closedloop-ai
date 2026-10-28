import {
  BRANCH_METRIC_DICTIONARY,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricId,
  BranchMetricPeriod,
  BranchMetricUnit,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  BRANCH_PROTOTYPE_LIST_METRIC_DEFINITIONS,
  BranchPrototypeListMetricKey,
  type BranchPrototypeMetricEvidence,
  BranchPrototypeMetricPolarity,
  calculatePrototypeBranchListMetrics,
  formatBranchMetricDefinitionInfo,
  formatBranchPrototypeSummaryMetric,
} from "./branch-prototype-metric-adapter";
import { BranchPublicationLocSource } from "./branch-publication-loc";

describe("Branch prototype metric presentation definitions", () => {
  it("derives the approved list card contract from the metric dictionary", () => {
    expect(
      BRANCH_PROTOTYPE_LIST_METRIC_DEFINITIONS.map(
        ({ key, metricId, label, unit }) => ({
          key,
          metricId,
          label,
          unit,
        })
      )
    ).toEqual([
      listDefinition(BranchPrototypeListMetricKey.ActiveBranches),
      listDefinition(BranchPrototypeListMetricKey.LocPerDollar),
      listDefinition(BranchPrototypeListMetricKey.MedianPrSize),
      listDefinition(BranchPrototypeListMetricKey.AiSpend),
      listDefinition(BranchPrototypeListMetricKey.MergeRate),
    ]);
  });

  it("keeps partial disclosures tied to canonical availability language", () => {
    expect(
      BRANCH_PROTOTYPE_LIST_METRIC_DEFINITIONS.map(
        ({ key, partialDisclosure }) => ({ key, partialDisclosure })
      )
    ).toEqual([
      {
        key: BranchPrototypeListMetricKey.ActiveBranches,
        partialDisclosure: BranchMetricDisclosure.DefaultIncomplete,
      },
      {
        key: BranchPrototypeListMetricKey.LocPerDollar,
        partialDisclosure: BranchMetricDisclosure.LocIncomplete,
      },
      {
        key: BranchPrototypeListMetricKey.MedianPrSize,
        partialDisclosure: BranchMetricDisclosure.PrIncomplete,
      },
      {
        key: BranchPrototypeListMetricKey.AiSpend,
        partialDisclosure: BranchMetricDisclosure.CostIncomplete,
      },
      {
        key: BranchPrototypeListMetricKey.MergeRate,
        partialDisclosure: BranchMetricDisclosure.DefaultIncomplete,
      },
    ]);
    expect(BranchMetricDisclosure.PrIncomplete).toBe(
      "* Calculated from merged PRs with known line counts. Some qualifying pull request sizes are unavailable."
    );
  });

  it("keeps the UI polarity and formatting units pinned separately", () => {
    expect(
      BRANCH_PROTOTYPE_LIST_METRIC_DEFINITIONS.map(
        ({ key, polarity, unit }) => ({ key, polarity, unit })
      )
    ).toEqual([
      {
        key: BranchPrototypeListMetricKey.ActiveBranches,
        polarity: BranchPrototypeMetricPolarity.HigherIsBetter,
        unit: BranchMetricUnit.Count,
      },
      {
        key: BranchPrototypeListMetricKey.LocPerDollar,
        polarity: BranchPrototypeMetricPolarity.HigherIsBetter,
        unit: BranchMetricUnit.LinesPerDollar,
      },
      {
        key: BranchPrototypeListMetricKey.MedianPrSize,
        polarity: BranchPrototypeMetricPolarity.LowerIsBetter,
        unit: BranchMetricUnit.Lines,
      },
      {
        key: BranchPrototypeListMetricKey.AiSpend,
        polarity: BranchPrototypeMetricPolarity.LowerIsBetter,
        unit: BranchMetricUnit.Usd,
      },
      {
        key: BranchPrototypeListMetricKey.MergeRate,
        polarity: BranchPrototypeMetricPolarity.HigherIsBetter,
        unit: BranchMetricUnit.Percentage,
      },
    ]);
  });

  it("formats metric dictionary info without leaking null denominators", () => {
    expect(
      formatBranchMetricDefinitionInfo(
        BRANCH_METRIC_DICTIONARY[BranchMetricId.LeadTime]
      )
    ).toEqual({
      what: "Population: latest selected merged PR cycle.",
      how: "Numerator: merge time minus qualifying successful push anchor.",
    });
    expect(
      formatBranchMetricDefinitionInfo(
        BRANCH_METRIC_DICTIONARY[BranchMetricId.DetailLocPerDollar]
      )
    ).toEqual({
      what: "Population: selected Branch lifetime.",
      how: "Numerator: per branch, lifetime successful-push additions plus deletions deduplicated by push, or admitted merged-PR additions plus deletions deduplicated by change identity when captured pushes do not cover every admitted merged PR. Denominator: selected Branch lifetime total estimated cost.",
    });
  });

  it("uses the shared dictionary-info formatter for list metric definitions", () => {
    expect(
      definitionFor(BranchPrototypeListMetricKey.ActiveBranches).info
    ).toEqual({
      what: "Population: full eligible Branch cohort after common non-date filters before pagination.",
      how: "Numerator: branches active at the period boundary.",
    });
    expect(
      definitionFor(BranchPrototypeListMetricKey.ActiveBranches).info.how
    ).not.toContain("null");
    expect(
      definitionFor(BranchPrototypeListMetricKey.LocPerDollar).info
    ).toEqual({
      what: "Population: verified publication LOC and qualifying Session cost in the filtered scope.",
      how: "Numerator: per branch, successful-push additions plus deletions deduplicated by push, or admitted merged-PR additions plus deletions deduplicated by change identity when captured pushes do not cover every admitted merged PR. Denominator: deduplicated total estimated Session cost using the global Branch divisor.",
    });
  });

  it("formats every canonical metric unit explicitly", () => {
    const values: Record<BranchMetricUnit, number> = {
      [BranchMetricUnit.Count]: 12.345,
      [BranchMetricUnit.Lines]: 1234.5,
      [BranchMetricUnit.LinesPerDollar]: 12.345,
      [BranchMetricUnit.Milliseconds]: 90_000,
      [BranchMetricUnit.Percentage]: 42.75,
      [BranchMetricUnit.Timestamp]: Date.UTC(2026, 6, 29, 12),
      [BranchMetricUnit.Usd]: 1234.567,
    };
    const expected: Record<BranchMetricUnit, string> = {
      [BranchMetricUnit.Count]: "12.35",
      [BranchMetricUnit.Lines]: "1,235 LOC",
      [BranchMetricUnit.LinesPerDollar]: "12.35 LOC/$",
      [BranchMetricUnit.Milliseconds]: "1m 30s",
      [BranchMetricUnit.Percentage]: "42.8%",
      [BranchMetricUnit.Timestamp]: "Jul 29, 2026",
      [BranchMetricUnit.Usd]: "$1,234.57",
    };

    for (const unit of Object.values(BranchMetricUnit)) {
      expect(formatBranchPrototypeSummaryMetric(unit, values[unit]), unit).toBe(
        expected[unit]
      );
    }
  });
});

describe("formatBranchPrototypeSummaryMetric edge values", () => {
  it("formats durations across the seconds, minutes, and hours boundaries", () => {
    const cases: [number, string][] = [
      [59_400, "59s"],
      [120_000, "2m"],
      [3_600_000, "1h"],
      [5_400_000, "1h 30m"],
    ];
    for (const [value, expected] of cases) {
      expect(
        formatBranchPrototypeSummaryMetric(BranchMetricUnit.Milliseconds, value)
      ).toBe(expected);
    }
  });

  it("refuses negative or non-finite durations and unrepresentable timestamps", () => {
    const cases: [BranchMetricUnit, number][] = [
      [BranchMetricUnit.Milliseconds, -1],
      [BranchMetricUnit.Milliseconds, Number.NaN],
      [BranchMetricUnit.Timestamp, Number.POSITIVE_INFINITY],
      [BranchMetricUnit.Timestamp, MAX_DATE_MS + 1],
    ];
    for (const [unit, value] of cases) {
      expect(
        formatBranchPrototypeSummaryMetric(unit, value),
        String(value)
      ).toBe("Unavailable");
    }
  });
});

describe("calculatePrototypeBranchListMetrics", () => {
  it("windows each bounded period by its day count and leaves all-time open", () => {
    const windows = Object.values(BranchMetricPeriod).map(
      (period) =>
        calculatePrototypeBranchListMetrics([BRANCH_A], evidence(), period, NOW)
          .window
    );
    expect(windows).toEqual([
      { startAt: "2026-07-23T00:00:00.000Z", endAt: NOW_ISO },
      { startAt: "2026-06-30T00:00:00.000Z", endAt: NOW_ISO },
      { startAt: "2026-05-31T00:00:00.000Z", endAt: NOW_ISO },
      { startAt: "2026-05-01T00:00:00.000Z", endAt: NOW_ISO },
      { startAt: null, endAt: NOW_ISO },
    ]);
  });

  it("reads the prior active flag for the selected period only", () => {
    const deltas = [
      BranchMetricPeriod.SevenDays,
      BranchMetricPeriod.ThirtyDays,
      BranchMetricPeriod.SixtyDays,
      BranchMetricPeriod.NinetyDays,
    ].map(
      (period) =>
        calculatePrototypeBranchListMetrics([BRANCH_A], evidence(), period, NOW)
          .activeBranches.comparison?.deltaPct
    );
    expect(deltas).toEqual([
      { state: BranchMetricAvailability.NotApplicable, value: null },
      { state: BranchMetricAvailability.Complete, value: 0 },
      { state: BranchMetricAvailability.Unavailable, value: null },
      { state: BranchMetricAvailability.Unavailable, value: null },
    ]);
    expect(
      calculatePrototypeBranchListMetrics(
        [BRANCH_A],
        evidence(),
        BranchMetricPeriod.ThirtyDays,
        NOW
      ).activeBranches.comparison?.label
    ).toBe(BranchMetricComparisonLabel.MonthOverMonth);
  });

  it("divides LOC by the cohort's own cost unless a denominator population is named", () => {
    expect(allTime(evidence()).locPerDollar.current).toEqual(complete(10));
    expect(
      allTime(
        evidence({
          locPerDollarDenominatorBranchIds: [BRANCH_A, BRANCH_Z],
          costCompleteBranchIds: [BRANCH_A, BRANCH_Z],
        })
      ).locPerDollar.current
    ).toEqual(complete(4));
  });

  it("marks LOC partial when the cohort or coverage list is not a clean match", () => {
    const partialCases = [
      { cohort: [BRANCH_A], overrides: { locCompleteBranchIds: [] } },
      { cohort: [BRANCH_A, BRANCH_A], overrides: {} },
      {
        cohort: [BRANCH_A],
        overrides: { locCompleteBranchIds: [BRANCH_A, BRANCH_A] },
      },
      {
        cohort: [BRANCH_A, BRANCH_B],
        overrides: {
          locCompleteBranchIds: [BRANCH_A, BRANCH_B],
          costCompleteBranchIds: [BRANCH_A, BRANCH_B],
        },
      },
    ];
    for (const { cohort, overrides } of partialCases) {
      expect(
        calculatePrototypeBranchListMetrics(
          cohort,
          evidence(overrides),
          BranchMetricPeriod.All,
          NOW
        ).locPerDollar.current
      ).toEqual(partial(10, BranchMetricDisclosure.LocIncomplete));
    }
  });

  it("counts a branch with a zero-line contribution as LOC-covered", () => {
    const result = calculatePrototypeBranchListMetrics(
      [BRANCH_A, BRANCH_B],
      evidence({
        locContributions: [
          LOC_A,
          {
            ...LOC_A,
            sourceEventId: "push-b",
            branchId: BRANCH_B,
            additions: 0,
            deletions: 0,
          },
        ],
        locCompleteBranchIds: [BRANCH_A, BRANCH_B],
        costCompleteBranchIds: [BRANCH_A, BRANCH_B],
      }),
      BranchMetricPeriod.All,
      NOW
    );
    expect(result.locPerDollar.current).toEqual(complete(10));
  });

  it("defaults the LOC source to a successful push and the change identity to the event", () => {
    expect(allTime(evidence()).totalLocPushed?.current).toEqual(complete(40));
    expect(
      allTime(
        evidence({
          locContributions: [
            { ...LOC_A, source: BranchPublicationLocSource.MergedPullRequest },
          ],
        })
      ).totalLocPushed?.current
    ).toEqual({ state: BranchMetricAvailability.Unavailable, value: null });
    expect(
      allTime(
        evidence({
          locContributions: [LOC_A, { ...LOC_A, sourceEventId: "push-2" }],
        })
      ).totalLocPushed?.current
    ).toEqual(complete(80));
    expect(
      allTime(
        evidence({
          locContributions: [
            { ...LOC_A, changeIdentity: "change-1" },
            { ...LOC_A, sourceEventId: "push-2", changeIdentity: "change-1" },
          ],
        })
      ).totalLocPushed?.current
    ).toEqual(complete(40));
  });

  it("marks spend partial when a branch lacks explicit cost coverage or carries unpriced activity", () => {
    const withoutCoverage = allTime(evidence({ costCompleteBranchIds: [] }));
    const withUnpriced = allTime(
      evidence({
        costCompleteBranchIds: [],
        costIncompleteContributions: [
          {
            sourceEventId: "unpriced-1",
            branchId: BRANCH_A,
            occurredAt: IN_WINDOW,
          },
        ],
      })
    );
    for (const result of [withoutCoverage, withUnpriced]) {
      expect(result.aiSpendUsd.current).toEqual(
        partial(4, BranchMetricDisclosure.CostIncomplete)
      );
      expect(result.locPerDollar.current).toEqual(
        partial(10, BranchMetricDisclosure.LocIncomplete)
      );
    }
  });

  it("lets explicit LOC-per-dollar overrides replace the derived denominator facts", () => {
    expect(
      allTime(evidence({ locPerDollarCostCoverageComplete: false }))
        .locPerDollar.current
    ).toEqual(partial(10, BranchMetricDisclosure.LocIncomplete));
    expect(
      allTime(
        evidence({
          costCompleteBranchIds: [],
          locPerDollarCostCoverageComplete: true,
        })
      ).locPerDollar.current
    ).toEqual(complete(10));
    expect(
      allTime(evidence({ locPerDollarQualifyingSessionIds: [] })).locPerDollar
        .current
    ).toEqual({ state: BranchMetricAvailability.NoData, value: null });
  });
});

const NOW_ISO = "2026-07-30T00:00:00.000Z";
const NOW = new Date(NOW_ISO);
const IN_WINDOW = "2026-07-28T00:00:00.000Z";
const MAX_DATE_MS = 8.64e15;
const BRANCH_A = "branch-a";
const BRANCH_B = "branch-b";
const BRANCH_Z = "branch-z";
const LOC_A = {
  sourceEventId: "push-1",
  branchId: BRANCH_A,
  occurredAt: IN_WINDOW,
  additions: 30,
  deletions: 10,
};

function evidence(
  overrides: Partial<BranchPrototypeMetricEvidence> = {}
): BranchPrototypeMetricEvidence {
  return {
    statusSnapshots: [
      {
        branchId: BRANCH_A,
        currentActive: true,
        priorActiveByRange: {
          [BranchMetricPeriod.SevenDays]: false,
          [BranchMetricPeriod.ThirtyDays]: true,
          [BranchMetricPeriod.SixtyDays]: null,
          [BranchMetricPeriod.NinetyDays]: null,
        },
      },
    ],
    locContributions: [LOC_A],
    locCompleteBranchIds: [BRANCH_A],
    costContributions: [
      {
        sourceEventId: "cost-a",
        branchId: BRANCH_A,
        sessionId: "session-a",
        occurredAt: IN_WINDOW,
        costUsd: 4,
        qualifyingBranchCount: 1,
      },
      {
        sourceEventId: "cost-z",
        branchId: BRANCH_Z,
        sessionId: "session-z",
        occurredAt: IN_WINDOW,
        costUsd: 6,
        qualifyingBranchCount: 1,
      },
    ],
    costIncompleteContributions: [],
    costCompleteBranchIds: [BRANCH_A],
    pullRequests: [],
    pullRequestCoverageComplete: true,
    ...overrides,
  };
}

function allTime(input: BranchPrototypeMetricEvidence) {
  return calculatePrototypeBranchListMetrics(
    [BRANCH_A],
    input,
    BranchMetricPeriod.All,
    NOW
  );
}

function complete(value: number) {
  return { state: BranchMetricAvailability.Complete, value };
}

function partial(value: number, disclosure: BranchMetricDisclosure) {
  return { state: BranchMetricAvailability.Partial, value, disclosure };
}

function listDefinition(key: BranchPrototypeListMetricKey) {
  const metricIdByKey = {
    [BranchPrototypeListMetricKey.ActiveBranches]:
      BranchMetricId.ActiveBranches,
    [BranchPrototypeListMetricKey.LocPerDollar]:
      BranchMetricId.ListLocPerDollar,
    [BranchPrototypeListMetricKey.MedianPrSize]: BranchMetricId.MedianPrSize,
    [BranchPrototypeListMetricKey.AiSpend]: BranchMetricId.AiSpend,
    [BranchPrototypeListMetricKey.MergeRate]: BranchMetricId.MergeRate,
  };
  const metricId = metricIdByKey[key];
  const definition = BRANCH_METRIC_DICTIONARY[metricId];
  return {
    key,
    metricId,
    label: definition.label,
    unit: definition.unit,
  };
}

function definitionFor(key: BranchPrototypeListMetricKey) {
  const definition = BRANCH_PROTOTYPE_LIST_METRIC_DEFINITIONS.find(
    (candidate) => candidate.key === key
  );
  if (!definition) {
    throw new Error(`Missing Branch prototype metric definition ${key}`);
  }
  return definition;
}
