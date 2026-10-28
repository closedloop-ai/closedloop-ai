import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BRANCH_METRIC_DICTIONARY,
  type BranchListMetricBundle,
  type BranchListMetricValue,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  type BranchMetricDefinition,
  BranchMetricDisclosure,
  BranchMetricId,
  BranchMetricPeriod,
  type BranchMetricResult,
  BranchMetricUnit,
} from "@repo/api/src/types/branch-metrics";
import type { BranchMetricCostFacts } from "./branch-cost-facts";
import { costFactsFromContributions } from "./branch-cost-facts-from-contributions";
import {
  projectCanonicalBranchListMetrics,
  resolveCanonicalBranchMetricWindows,
} from "./branch-list-metric-projection";
import type { BranchMetricCostContribution } from "./branch-list-metrics";
import {
  type BranchMetricLocContribution,
  BranchPublicationLocSource,
} from "./branch-publication-loc";
import { branchMetricFactWindows } from "./branch-pull-request-metrics";

/** Prototype-safe aliases for shared metric result states. */
export const BranchPrototypeMetricAvailability = BranchMetricAvailability;
export type BranchPrototypeMetricAvailability = BranchMetricAvailability;

/** Prototype-safe aliases for shared metric comparison labels. */
export const BranchPrototypeMetricComparisonLabel = BranchMetricComparisonLabel;
export type BranchPrototypeMetricComparisonLabel = BranchMetricComparisonLabel;

/** Prototype-safe aliases for shared metric disclosure copy. */
export const BranchPrototypeMetricDisclosure = BranchMetricDisclosure;
export type BranchPrototypeMetricDisclosure = BranchMetricDisclosure;

/** Prototype-safe aliases for shared metric periods. */
export const BranchPrototypeMetricPeriod = BranchMetricPeriod;
export type BranchPrototypeMetricPeriod = BranchMetricPeriod;

export type BranchPrototypeListMetricBundle = BranchListMetricBundle;
export type BranchPrototypeListMetricValue = BranchListMetricValue;
export type BranchPrototypeMetricResult<TValue = number> =
  BranchMetricResult<TValue>;

export type BranchPrototypeMetricEvidence = {
  statusSnapshots: readonly {
    branchId: string;
    currentActive: boolean | null;
    priorActiveByRange: Record<
      Exclude<BranchMetricPeriod, typeof BranchMetricPeriod.All>,
      boolean | null
    >;
  }[];
  locContributions: readonly BranchMetricLocContribution[];
  locCompleteBranchIds: readonly string[];
  costContributions: readonly BranchMetricCostContribution[];
  costIncompleteContributions: readonly {
    sourceEventId: string;
    branchId: string;
    occurredAt: string | null;
  }[];
  costCompleteBranchIds: readonly string[];
  pullRequests: readonly {
    identity: string;
    branchId: string;
    mergedAt: string | null;
    closedAt: string | null;
    isDraft: boolean;
    additions: number | null;
    deletions: number | null;
  }[];
  pullRequestCoverageComplete: boolean;
  locPerDollarDenominatorBranchIds?: readonly string[];
  locPerDollarQualifyingSessionIds?: readonly string[];
  locPerDollarCostCoverageComplete?: boolean;
};

/** Execute prototype fixtures through the production Branch metric kernel. */
export function calculatePrototypeBranchListMetrics(
  cohortIds: readonly string[],
  evidence: BranchPrototypeMetricEvidence,
  period: BranchMetricPeriod,
  now: Date
): BranchListMetricBundle {
  const cohort = new Set(cohortIds);
  const denominatorBranches = new Set(
    evidence.locPerDollarDenominatorBranchIds ?? cohortIds
  );
  const range = metricRange(period, now);
  return projectCanonicalBranchListMetrics({
    branches: cohortIds.map((id) => ({
      id,
      status: BranchStatus.Open,
      lastActivityAt: null,
    })),
    statusSnapshots: evidence.statusSnapshots
      .filter((snapshot) => cohort.has(snapshot.branchId))
      .map((snapshot) => ({
        branchId: snapshot.branchId,
        currentActive: snapshot.currentActive,
        priorActive:
          period === BranchMetricPeriod.All
            ? null
            : snapshot.priorActiveByRange[period],
      })),
    lastActiveEvents: [],
    lastActiveCoverageComplete: false,
    locContributions: evidence.locContributions
      .filter((contribution) => cohort.has(contribution.branchId))
      .map((contribution) => ({
        ...contribution,
        changeIdentity:
          contribution.changeIdentity ??
          `${contribution.branchId}:${contribution.sourceEventId}`,
        source:
          contribution.source ?? BranchPublicationLocSource.SuccessfulPush,
      })),
    locCoverageComplete:
      hasCoverage(cohortIds, evidence.locCompleteBranchIds) &&
      cohortIds.every((branchId) =>
        evidence.locContributions.some(
          (contribution) => contribution.branchId === branchId
        )
      ),
    locCompleteBranchIds: evidence.locCompleteBranchIds.filter((id) =>
      cohort.has(id)
    ),
    pullRequests: evidence.pullRequests
      .filter((pullRequest) => cohort.has(pullRequest.branchId))
      .map((pullRequest) => ({
        identity: pullRequest.identity,
        mergedAt: pullRequest.mergedAt,
        closedAt: pullRequest.closedAt,
        isDraft: pullRequest.isDraft,
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
      })),
    pullRequestCoverageComplete: evidence.pullRequestCoverageComplete,
    costContributions: visibleCostContributions(evidence, cohort),
    costCompleteBranchIds: cohortIds.filter((branchId) =>
      hasExplicitCostCoverage(evidence, branchId)
    ),
    aiSpendFacts: prototypeSpendFacts(evidence, cohortIds, cohort, range, now),
    locPerDollarCostContributions: denominatorCostContributions(
      evidence,
      denominatorBranches
    ),
    locPerDollarQualifyingSessionIds:
      evidence.locPerDollarQualifyingSessionIds ??
      denominatorSessionIds(evidence, denominatorBranches),
    locPerDollarCostCoverageComplete:
      evidence.locPerDollarCostCoverageComplete ??
      [...denominatorBranches].every((branchId) =>
        hasExplicitCostCoverage(evidence, branchId)
      ),
    now,
    ...range,
  });
}

/**
 * A branch with no declared cost coverage holds cost the fixture cannot read,
 * which is what the facts call an unusable event.
 */
function prototypeSpendFacts(
  evidence: BranchPrototypeMetricEvidence,
  cohortIds: readonly string[],
  cohort: ReadonlySet<string>,
  range: { startDate?: Date; endDate?: Date },
  now: Date
): BranchMetricCostFacts {
  const uncovered = cohortIds.filter(
    (branchId) => !hasExplicitCostCoverage(evidence, branchId)
  ).length;
  const facts = costFactsFromContributions(
    visibleCostContributions(evidence, cohort),
    branchMetricFactWindows(
      resolveCanonicalBranchMetricWindows({ ...range, now })
    )
  );
  return {
    ...facts,
    windows: new Map(
      [...facts.windows].map(([key, window]) => [
        key,
        { ...window, unusable: window.unusable + uncovered },
      ])
    ),
  };
}

function visibleCostContributions(
  evidence: BranchPrototypeMetricEvidence,
  cohort: ReadonlySet<string>
): BranchMetricCostContribution[] {
  return [
    ...evidence.costContributions.filter((contribution) =>
      cohort.has(contribution.branchId)
    ),
    ...incompleteCostContributions(evidence, cohort),
  ];
}

function denominatorCostContributions(
  evidence: BranchPrototypeMetricEvidence,
  branches: ReadonlySet<string>
): BranchMetricCostContribution[] {
  return [
    ...evidence.costContributions.filter((contribution) =>
      branches.has(contribution.branchId)
    ),
    ...incompleteCostContributions(evidence, branches),
  ];
}

function incompleteCostContributions(
  evidence: BranchPrototypeMetricEvidence,
  branches: ReadonlySet<string>
): BranchMetricCostContribution[] {
  return evidence.costIncompleteContributions
    .filter((contribution) => branches.has(contribution.branchId))
    .map((contribution) => ({
      ...contribution,
      sessionId: `incomplete:${contribution.sourceEventId}`,
      costUsd: null,
      qualifyingBranchCount: null,
    }));
}

function metricRange(
  period: BranchMetricPeriod,
  now: Date
): { startDate?: Date; endDate?: Date } {
  if (period === BranchMetricPeriod.All) {
    return {};
  }
  let days = 90;
  if (period === BranchMetricPeriod.SevenDays) {
    days = 7;
  } else if (period === BranchMetricPeriod.ThirtyDays) {
    days = 30;
  } else if (period === BranchMetricPeriod.SixtyDays) {
    days = 60;
  }
  return {
    startDate: new Date(now.getTime() - days * DAY_MS),
    endDate: now,
  };
}

function denominatorSessionIds(
  evidence: BranchPrototypeMetricEvidence,
  branches: ReadonlySet<string>
): string[] {
  return [
    ...new Set([
      ...evidence.costContributions
        .filter((contribution) => branches.has(contribution.branchId))
        .map((contribution) => contribution.sessionId),
      ...evidence.costIncompleteContributions
        .filter((contribution) => branches.has(contribution.branchId))
        .map((contribution) => `incomplete:${contribution.sourceEventId}`),
    ]),
  ];
}

function hasCoverage(
  expectedIds: readonly string[],
  coveredIds: readonly string[]
): boolean {
  const expected = new Set(expectedIds);
  const covered = new Set(coveredIds);
  return (
    expected.size === expectedIds.length &&
    covered.size === coveredIds.length &&
    [...expected].every((id) => covered.has(id))
  );
}

function hasExplicitCostCoverage(
  evidence: BranchPrototypeMetricEvidence,
  branchId: string
): boolean {
  return (
    evidence.costCompleteBranchIds.includes(branchId) ||
    evidence.costIncompleteContributions.some(
      (contribution) => contribution.branchId === branchId
    )
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const BranchPrototypeListMetricKey = {
  ActiveBranches: "activeBranches",
  LocPerDollar: "locPerDollar",
  MedianPrSize: "medianPrSize",
  AiSpend: "aiSpendUsd",
  MergeRate: "mergeRatePct",
} as const;
export type BranchPrototypeListMetricKey =
  (typeof BranchPrototypeListMetricKey)[keyof typeof BranchPrototypeListMetricKey];

export const BranchPrototypeMetricPolarity = {
  HigherIsBetter: "higher_is_better",
  LowerIsBetter: "lower_is_better",
} as const;
export type BranchPrototypeMetricPolarity =
  (typeof BranchPrototypeMetricPolarity)[keyof typeof BranchPrototypeMetricPolarity];

export type BranchPrototypeListMetricDefinition = {
  key: BranchPrototypeListMetricKey;
  metricId: BranchMetricId;
  label: string;
  unit: BranchMetricUnit;
  polarity: BranchPrototypeMetricPolarity;
  info: BranchMetricDefinitionInfo;
  partialDisclosure: BranchMetricDisclosure;
};

export const BranchPrototypeDetailMetricKey = {
  AbandonmentTime: "abandonmentTime",
  DetailLocPerDollar: "detailLocPerDollar",
  LeadTime: "leadTime",
} as const;
export type BranchPrototypeDetailMetricKey =
  (typeof BranchPrototypeDetailMetricKey)[keyof typeof BranchPrototypeDetailMetricKey];

export type BranchPrototypeDetailMetricDefinition = {
  label: string;
  periodBehavior: string;
  info: BranchMetricDefinitionInfo;
};

export type BranchMetricDefinitionInfo = {
  what: string;
  how: string;
};

export type BranchMetricDefinitionInfoSource = Pick<
  BranchMetricDefinition,
  "population" | "numerator" | "denominator"
>;

export const BRANCH_PROTOTYPE_DETAIL_METRIC_DEFINITIONS: Record<
  BranchPrototypeDetailMetricKey,
  BranchPrototypeDetailMetricDefinition
> = {
  [BranchPrototypeDetailMetricKey.AbandonmentTime]: defineDetailMetric(
    BranchMetricId.AbandonmentTime
  ),
  [BranchPrototypeDetailMetricKey.DetailLocPerDollar]: defineDetailMetric(
    BranchMetricId.DetailLocPerDollar
  ),
  [BranchPrototypeDetailMetricKey.LeadTime]: defineDetailMetric(
    BranchMetricId.LeadTime
  ),
};

export const BRANCH_PROTOTYPE_LIST_METRIC_DEFINITIONS: readonly BranchPrototypeListMetricDefinition[] =
  [
    defineListMetric({
      key: BranchPrototypeListMetricKey.ActiveBranches,
      metricId: BranchMetricId.ActiveBranches,
      polarity: BranchPrototypeMetricPolarity.HigherIsBetter,
      partialDisclosure: BranchMetricDisclosure.DefaultIncomplete,
    }),
    defineListMetric({
      key: BranchPrototypeListMetricKey.LocPerDollar,
      metricId: BranchMetricId.ListLocPerDollar,
      polarity: BranchPrototypeMetricPolarity.HigherIsBetter,
      partialDisclosure: BranchMetricDisclosure.LocIncomplete,
    }),
    defineListMetric({
      key: BranchPrototypeListMetricKey.MedianPrSize,
      metricId: BranchMetricId.MedianPrSize,
      polarity: BranchPrototypeMetricPolarity.LowerIsBetter,
      partialDisclosure: BranchMetricDisclosure.PrIncomplete,
    }),
    defineListMetric({
      key: BranchPrototypeListMetricKey.AiSpend,
      metricId: BranchMetricId.AiSpend,
      polarity: BranchPrototypeMetricPolarity.LowerIsBetter,
      partialDisclosure: BranchMetricDisclosure.CostIncomplete,
    }),
    defineListMetric({
      key: BranchPrototypeListMetricKey.MergeRate,
      metricId: BranchMetricId.MergeRate,
      polarity: BranchPrototypeMetricPolarity.HigherIsBetter,
      partialDisclosure: BranchMetricDisclosure.DefaultIncomplete,
    }),
  ];

function defineListMetric({
  key,
  metricId,
  polarity,
  partialDisclosure,
}: {
  key: BranchPrototypeListMetricKey;
  metricId: BranchMetricId;
  polarity: BranchPrototypeMetricPolarity;
  partialDisclosure: BranchMetricDisclosure;
}): BranchPrototypeListMetricDefinition {
  const definition = BRANCH_METRIC_DICTIONARY[metricId];
  return {
    key,
    metricId,
    label: definition.label,
    unit: definition.unit,
    polarity,
    info: formatBranchMetricDefinitionInfo(definition),
    partialDisclosure,
  };
}

function defineDetailMetric(
  metricId: BranchMetricId
): BranchPrototypeDetailMetricDefinition {
  const definition = BRANCH_METRIC_DICTIONARY[metricId];
  return {
    label: definition.label,
    periodBehavior: definition.periodBehavior,
    info: formatBranchMetricDefinitionInfo(definition),
  };
}

/** Format Branch metric dictionary formula copy for prototype tooltip copy. */
export function formatBranchMetricDefinitionInfo(
  definition: BranchMetricDefinitionInfoSource
): BranchMetricDefinitionInfo {
  return {
    what: `Population: ${definition.population}.`,
    how: definition.denominator
      ? `Numerator: ${definition.numerator}. Denominator: ${definition.denominator}.`
      : `Numerator: ${definition.numerator}.`,
  };
}

type BranchMetricFormatter = (value: number) => string;

const BRANCH_METRIC_UNIT_FORMATTERS: Record<
  BranchMetricUnit,
  BranchMetricFormatter
> = {
  [BranchMetricUnit.Count]: formatNumber,
  [BranchMetricUnit.Lines]: formatLines,
  [BranchMetricUnit.LinesPerDollar]: formatLinesPerDollar,
  [BranchMetricUnit.Milliseconds]: formatMilliseconds,
  [BranchMetricUnit.Percentage]: formatPercentage,
  [BranchMetricUnit.Timestamp]: formatTimestamp,
  [BranchMetricUnit.Usd]: formatUsd,
};

/** Format a Branch prototype summary-card value for every canonical metric unit. */
export function formatBranchPrototypeSummaryMetric(
  unit: BranchMetricUnit,
  value: number
): string {
  return BRANCH_METRIC_UNIT_FORMATTERS[unit](value);
}

function formatLines(value: number): string {
  return `${Math.round(value).toLocaleString("en-US")} LOC`;
}

function formatLinesPerDollar(value: number): string {
  return `${formatNumber(value)} LOC/$`;
}

function formatMilliseconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "Unavailable";
  }
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatPercentage(value: number): string {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value)) {
    return "Unavailable";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unavailable";
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatUsd(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}
