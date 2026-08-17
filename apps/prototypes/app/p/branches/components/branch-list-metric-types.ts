export const MetricAvailability = {
  Complete: "complete",
  Partial: "partial",
  Unavailable: "unavailable",
  NotApplicable: "not_applicable",
  NoData: "no_data",
} as const;
export type MetricAvailability =
  (typeof MetricAvailability)[keyof typeof MetricAvailability];

export const MetricPresentationState = {
  Complete: "complete",
  Partial: "partial",
  Unavailable: "unavailable",
  NotApplicable: "notApplicable",
  NoData: "noData",
  Loading: "loading",
  Error: "error",
} as const;
export type MetricPresentationState =
  (typeof MetricPresentationState)[keyof typeof MetricPresentationState];

export const MetricDisclosure = {
  DefaultIncomplete:
    "* Calculated from available data. Some qualifying values are unavailable, so this number is incomplete.",
  LocIncomplete:
    "* Only includes Branches with known line counts and qualifying cost.",
  CostIncomplete:
    "* Calculated from available qualifying Session costs. Activity with unavailable cost is excluded.",
  PrIncomplete:
    "* Calculated from pull requests with known line counts. Some qualifying pull request sizes are unavailable.",
} as const;
export type MetricDisclosure =
  (typeof MetricDisclosure)[keyof typeof MetricDisclosure];

export const CostPhase = {
  Build: "build",
  Review: "review",
  Rework: "rework",
} as const;
export type CostPhase = (typeof CostPhase)[keyof typeof CostPhase];

export const ComparisonLabel = {
  WeekOverWeek: "WoW",
  MonthOverMonth: "MoM",
  QuarterOverQuarter: "QoQ",
  AllTime: "all time",
} as const;
export type ComparisonLabel =
  (typeof ComparisonLabel)[keyof typeof ComparisonLabel];

export type MetricResult =
  | {
      state: typeof MetricAvailability.Complete;
      value: number;
    }
  | {
      state: typeof MetricAvailability.Partial;
      value: number;
      disclosure: MetricDisclosure;
    }
  | {
      state:
        | typeof MetricAvailability.Unavailable
        | typeof MetricAvailability.NotApplicable
        | typeof MetricAvailability.NoData;
      value: null;
    };

export type MetricValue = {
  current: MetricResult;
  comparison?: { label: ComparisonLabel; deltaPct: MetricResult };
};

export type BranchMetricBundle = {
  label: ComparisonLabel;
  activeBranches: MetricValue;
  locPerDollar: MetricValue;
  medianPrSize: MetricValue;
  aiSpendUsd: MetricValue;
  mergeRatePct: MetricValue;
};

export type StatusSnapshot = {
  branchId: string;
  currentActive: boolean | null;
  priorActiveByRange: Record<
    Exclude<DateRange, typeof DateRangeValue.All>,
    boolean | null
  >;
};

export type LocContribution = {
  sourceEventId: string;
  branchId: string;
  occurredAt: string | null;
  additions: number | null;
  deletions: number | null;
};

export type CostContribution = {
  sourceEventId: string;
  branchId: string;
  sessionId: string;
  occurredAt: string | null;
  phase: CostPhase | null;
  costUsd: number | null;
  qualifyingBranchCount: number | null;
};

/** A Session/Branch cost link whose value is unavailable or invalid. */
export type IncompleteCostContribution = {
  sourceEventId: string;
  branchId: string;
  occurredAt: string | null;
};

export type PullRequestEvidence = {
  identity: string;
  branchId: string;
  mergedAt: string | null;
  closedAt: string | null;
  isDraft: boolean;
  additions: number | null;
  deletions: number | null;
};

export type BranchMetricEvidence = {
  statusSnapshots: readonly StatusSnapshot[];
  locContributions: readonly LocContribution[];
  locCompleteBranchIds: readonly string[];
  costContributions: readonly CostContribution[];
  /** Unavailable Session cost links retained so completeness can follow time windows. */
  costIncompleteContributions: readonly IncompleteCostContribution[];
  /** Branches with complete lifetime Session cost coverage. */
  costCompleteBranchIds: readonly string[];
  pullRequests: readonly PullRequestEvidence[];
  pullRequestCoverageComplete: boolean;
};

export type MetricWindow = { startAt: number | null; endAt: number };

import type { DateRange, DateRange as DateRangeValue } from "../mock";
