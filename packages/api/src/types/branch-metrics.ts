import type { BranchVisibleLifecyclePhase } from "./branch-phase-attribution.js";

/** Canonical Branch metric identifiers shared by cloud, Desktop, and clients. */
export const BranchMetricId = {
  ActiveBranches: "active_branches",
  AiSpend: "ai_spend",
  LastActive: "last_active",
  LeadTime: "lead_time",
  AbandonmentTime: "abandonment_time",
  IdleTime: "idle_time",
  ListLocPerDollar: "list_loc_per_dollar",
  DetailLocPerDollar: "detail_loc_per_dollar",
  MedianPrSize: "median_pr_size",
  MergeRate: "merge_rate",
} as const;
export type BranchMetricId =
  (typeof BranchMetricId)[keyof typeof BranchMetricId];

/** Product-terminal status not yet emitted by the legacy BranchStatus wire type. */
export const BranchMetricTerminalStatus = {
  Canceled: "canceled",
} as const;
export type BranchMetricTerminalStatus =
  (typeof BranchMetricTerminalStatus)[keyof typeof BranchMetricTerminalStatus];

/** Availability is presentation-independent; `partial` renders as a numeric `*`. */
export const BranchMetricAvailability = {
  Complete: "complete",
  Partial: "partial",
  Unavailable: "unavailable",
  NotApplicable: "not_applicable",
  NoData: "no_data",
} as const;
export type BranchMetricAvailability =
  (typeof BranchMetricAvailability)[keyof typeof BranchMetricAvailability];

export const BranchMetricDisclosure = {
  CostIncomplete:
    "* Calculated from available qualifying Session costs. Activity with unavailable cost is excluded.",
  DefaultIncomplete:
    "* Calculated from available data. Some qualifying values are unavailable, so this number is incomplete.",
  LocIncomplete:
    "* Only includes Branches with known line counts and qualifying cost.",
} as const;
export type BranchMetricDisclosure =
  (typeof BranchMetricDisclosure)[keyof typeof BranchMetricDisclosure];

export const BranchMetricPeriod = {
  SevenDays: "7d",
  ThirtyDays: "30d",
  NinetyDays: "90d",
  All: "all",
} as const;
export type BranchMetricPeriod =
  (typeof BranchMetricPeriod)[keyof typeof BranchMetricPeriod];

export const BranchMetricComparisonLabel = {
  WeekOverWeek: "WoW",
  MonthOverMonth: "MoM",
  QuarterOverQuarter: "QoQ",
  AllTime: "all time",
} as const;
export type BranchMetricComparisonLabel =
  (typeof BranchMetricComparisonLabel)[keyof typeof BranchMetricComparisonLabel];

export const BranchMetricUnit = {
  Count: "count",
  Lines: "lines",
  LinesPerDollar: "loc_per_dollar",
  Milliseconds: "milliseconds",
  Percentage: "percentage",
  Timestamp: "timestamp",
  Usd: "usd",
} as const;
export type BranchMetricUnit =
  (typeof BranchMetricUnit)[keyof typeof BranchMetricUnit];

export const BranchMetricEventTime = {
  BoundarySnapshot: "boundary_snapshot",
  LastQualifyingActivity: "last_qualifying_activity",
  MergedAt: "merged_at",
  OutcomeTerminalAt: "outcome_terminal_at",
  PhaseContributionAt: "phase_contribution_at",
  PullRequestTerminalAt: "pull_request_terminal_at",
  SelectedBranchLifetime: "selected_branch_lifetime",
} as const;
export type BranchMetricEventTime =
  (typeof BranchMetricEventTime)[keyof typeof BranchMetricEventTime];

export type BranchMetricDefinition = {
  id: BranchMetricId;
  label: string;
  unit: BranchMetricUnit;
  population: string;
  numerator: string;
  denominator: string | null;
  numeratorEventTime: BranchMetricEventTime;
  denominatorEventTime: BranchMetricEventTime | null;
  periodBehavior: string;
  applicability: string;
};

/** Exact formula/data dictionary from PRD-600/601/602. */
export const BRANCH_METRIC_DICTIONARY = {
  [BranchMetricId.ActiveBranches]: {
    id: BranchMetricId.ActiveBranches,
    label: "Active branches",
    unit: BranchMetricUnit.Count,
    population:
      "full eligible Branch cohort after common non-date filters before pagination",
    numerator: "branches active at the period boundary",
    denominator: null,
    numeratorEventTime: BranchMetricEventTime.BoundarySnapshot,
    denominatorEventTime: null,
    periodBehavior:
      "current boundary snapshot; prior requires historical status evidence",
    applicability: "eligible Branch records with a resolved canonical status",
  },
  [BranchMetricId.AiSpend]: {
    id: BranchMetricId.AiSpend,
    label: "AI spend",
    unit: BranchMetricUnit.Usd,
    population: "qualifying Build, Review, and Rework contributions",
    numerator: "deduplicated subscription-equivalent plus API-associated cost",
    denominator: null,
    numeratorEventTime: BranchMetricEventTime.PhaseContributionAt,
    denominatorEventTime: null,
    periodBehavior:
      "qualifying cost activity in the selected adjacent UTC window",
    applicability: "nonempty filtered Branch cohort",
  },
  [BranchMetricId.LastActive]: {
    id: BranchMetricId.LastActive,
    label: "Last active",
    unit: BranchMetricUnit.Timestamp,
    population: "qualifying persisted Session activity and attributable events",
    numerator: "maximum authoritative occurrence or completion time",
    denominator: null,
    numeratorEventTime: BranchMetricEventTime.LastQualifyingActivity,
    denominatorEventTime: null,
    periodBehavior:
      "maximum qualifying authoritative event time across the cohort",
    applicability:
      "nonempty filtered Branch cohort with attributable activity evidence",
  },
  [BranchMetricId.LeadTime]: {
    id: BranchMetricId.LeadTime,
    label: "Lead time for change",
    unit: BranchMetricUnit.Milliseconds,
    population: "latest selected merged PR cycle",
    numerator: "merge time minus qualifying successful push anchor",
    denominator: null,
    numeratorEventTime: BranchMetricEventTime.OutcomeTerminalAt,
    denominatorEventTime: null,
    periodBehavior: "selected Branch lifetime; latest selected PR cycle only",
    applicability: "selected merged PR cycle",
  },
  [BranchMetricId.AbandonmentTime]: {
    id: BranchMetricId.AbandonmentTime,
    label: "Abandonment Duration",
    unit: BranchMetricUnit.Milliseconds,
    population: "latest selected closed-unmerged PR cycle",
    numerator: "close time minus qualifying successful push anchor",
    denominator: null,
    numeratorEventTime: BranchMetricEventTime.OutcomeTerminalAt,
    denominatorEventTime: null,
    periodBehavior: "selected Branch lifetime; latest selected PR cycle only",
    applicability: "selected closed-unmerged PR cycle",
  },
  [BranchMetricId.IdleTime]: {
    id: BranchMetricId.IdleTime,
    label: "Idle/waiting",
    unit: BranchMetricUnit.Milliseconds,
    population: "latest selected terminal PR cycle",
    numerator:
      "outcome span minus union of clipped Build, Review, Rework intervals",
    denominator: null,
    numeratorEventTime: BranchMetricEventTime.OutcomeTerminalAt,
    denominatorEventTime: null,
    periodBehavior: "selected terminal outcome span",
    applicability: "selected terminal PR cycle with a trustworthy outcome span",
  },
  [BranchMetricId.ListLocPerDollar]: {
    id: BranchMetricId.ListLocPerDollar,
    label: "LOC per $",
    unit: BranchMetricUnit.LinesPerDollar,
    population: "complete in-window gross LOC and cost contribution pairs",
    numerator: "sum of additions plus deletions",
    denominator: "sum of Build, Review, and Rework cost for the same pairs",
    numeratorEventTime: BranchMetricEventTime.PhaseContributionAt,
    denominatorEventTime: BranchMetricEventTime.PhaseContributionAt,
    periodBehavior:
      "independently window LOC pushes and cost activity, then pair by Branch",
    applicability:
      "nonempty cohort with at least one complete Branch LOC/cost pair",
  },
  [BranchMetricId.DetailLocPerDollar]: {
    id: BranchMetricId.DetailLocPerDollar,
    label: "LOC per $",
    unit: BranchMetricUnit.LinesPerDollar,
    population: "selected Branch/PR lifetime",
    numerator: "selected PR additions plus deletions",
    denominator: "selected Branch lifetime Build, Review, and Rework cost",
    numeratorEventTime: BranchMetricEventTime.SelectedBranchLifetime,
    denominatorEventTime: BranchMetricEventTime.SelectedBranchLifetime,
    periodBehavior: "selected Branch lifetime; list date filter does not apply",
    applicability: "known selected-PR LOC and complete positive Branch cost",
  },
  [BranchMetricId.MedianPrSize]: {
    id: BranchMetricId.MedianPrSize,
    label: "Median PR size",
    unit: BranchMetricUnit.Lines,
    population: "distinct merged PRs with known gross LOC",
    numerator: "median additions plus deletions",
    denominator: null,
    numeratorEventTime: BranchMetricEventTime.MergedAt,
    denominatorEventTime: null,
    periodBehavior: "distinct merged PRs assigned by mergedAt",
    applicability: "nonempty merged-PR population with defensible LOC",
  },
  [BranchMetricId.MergeRate]: {
    id: BranchMetricId.MergeRate,
    label: "Merge rate",
    unit: BranchMetricUnit.Percentage,
    population: "distinct decided PRs",
    numerator: "merged PR count",
    denominator: "merged plus closed-unmerged PR count",
    numeratorEventTime: BranchMetricEventTime.PullRequestTerminalAt,
    denominatorEventTime: BranchMetricEventTime.PullRequestTerminalAt,
    periodBehavior: "decided PRs assigned by mergedAt or closedAt",
    applicability: "at least one distinct decided associated PR",
  },
} as const satisfies Record<BranchMetricId, BranchMetricDefinition>;

export type BranchMetricCoverage = {
  included: number;
  total: number;
};

export type BranchMetricResult<Value> =
  | {
      state: typeof BranchMetricAvailability.Complete;
      value: Value;
      coverage?: BranchMetricCoverage;
    }
  | {
      state: typeof BranchMetricAvailability.Partial;
      value: Value;
      /** Exact coverage when the producer can prove both counts. */
      coverage?: BranchMetricCoverage;
      disclosure: BranchMetricDisclosure;
    }
  | {
      state:
        | typeof BranchMetricAvailability.Unavailable
        | typeof BranchMetricAvailability.NotApplicable
        | typeof BranchMetricAvailability.NoData;
      value: null;
    };

export type BranchMetricWindow = {
  startAt: string | null;
  endAt: string;
};

export type BranchMetricComparison = {
  label: Exclude<
    BranchMetricComparisonLabel,
    typeof BranchMetricComparisonLabel.AllTime
  >;
  priorWindow: BranchMetricWindow;
  deltaPct: BranchMetricResult<number>;
};

export type BranchListMetricValue = {
  current: BranchMetricResult<number>;
  comparison?: BranchMetricComparison;
};

export type BranchListMetricBundle = {
  period: BranchMetricPeriod;
  label: BranchMetricComparisonLabel;
  window: BranchMetricWindow;
  cohortSize: number;
  lastActiveAt: BranchMetricResult<string>;
  activeBranches: BranchListMetricValue;
  locPerDollar: BranchListMetricValue;
  medianPrSize: BranchListMetricValue;
  aiSpendUsd: BranchListMetricValue;
  mergeRatePct: BranchListMetricValue;
};

export type BranchDetailMetricBundle = {
  locPerDollar: BranchMetricResult<number>;
  phaseCostUsd: Record<BranchVisibleLifecyclePhase, BranchMetricResult<number>>;
  totalCostUsd: BranchMetricResult<number>;
  leadTimeMs: BranchMetricResult<number>;
  abandonmentTimeMs: BranchMetricResult<number>;
  idleTimeMs: BranchMetricResult<number>;
};

export const BranchMetricPullRequestOutcome = {
  Merged: "merged",
  ClosedUnmerged: "closed_unmerged",
  Open: "open",
  Draft: "draft",
} as const;
export type BranchMetricPullRequestOutcome =
  (typeof BranchMetricPullRequestOutcome)[keyof typeof BranchMetricPullRequestOutcome];
