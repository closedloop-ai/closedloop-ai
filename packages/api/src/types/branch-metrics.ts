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
  CanonicalLocPerDollar: "canonical_loc_per_dollar",
  TotalLocPushed: "total_loc_pushed",
  PushedLocPerDollar: "pushed_loc_per_dollar",
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
  /**
   * ISS-8968: some branches in the filter were not admitted to the figure, so
   * the population is short — unlike its siblings, which name evidence that was
   * short for a metric. Deliberately names no cause:
   * a branch is dropped for reasons the reader cannot act on, and the nearest
   * existing sentences (`PrIncomplete`, `LocIncomplete`) blame the user's own
   * data for what is an admission decision.
   */
  BranchesIncomplete:
    "* Calculated from part of the current selection. Some branches in this filter are not included in this figure.",
  /**
   * ISS-8968: BOTH narrowings apply — the population is short a branch AND the
   * producer's own evidence was short for the branches that did make it. One
   * result carries one disclosure, so naming only the branch narrowing would
   * drop the producer's stated cause and naming only the producer's would leave
   * the reader believing the whole selection was measured. Its coverage stays
   * the producer's, which is the count it can actually prove.
   */
  BranchesAndEvidenceIncomplete:
    "* Calculated from part of the current selection. Some branches in this filter are not included, and some qualifying values for those that are remain unavailable.",
  CostIncomplete:
    "* Calculated from available qualifying Session costs. Activity with unavailable cost is excluded.",
  DefaultIncomplete:
    "* Calculated from available data. Some qualifying values are unavailable, so this number is incomplete.",
  LocIncomplete:
    "* Result uses verified publication LOC and all known qualifying Session cost; unavailable evidence is excluded.",
  /**
   * ISS-9930, operator ruling 2026-09-17: a Pensero day the collector attempted
   * and never once retrieved, on top of the history below. No Pensero member
   * restates that the number is incomplete — the Partial marker already does.
   */
  PenseroAcquisitionDaysFailed:
    "* Calculated from the Pensero delivery days collected so far. Some days could not be collected, and earlier history is still being collected.",
  /**
   * ISS-9930, operator ruling 2026-09-17. The resting state of every Pensero
   * pts/$ result: the backward walk has no historical cutoff
   * (`PenseroBackfillCursor` schema doc), so unswept history always remains and
   * no sibling sentence names days or collection at all.
   */
  PenseroAcquisitionIncomplete:
    "* Calculated from the Pensero delivery days collected so far. Earlier history is still being collected.",
  /**
   * ISS-9930, operator ruling 2026-09-17; clause sharpened by ISS-10608,
   * operator ruling 2026-09-17: points this branch's own collected rows hold
   * but that no single branch could claim, so the sum is short of its own
   * evidence rather than short on acquisition.
   */
  PenseroAttributionAmbiguous:
    "* Calculated from the Pensero delivery days collected so far. Some points belong to more than one branch, and earlier history is still being collected.",
  /**
   * ISS-9930, operator ruling 2026-09-17: BOTH shortfalls apply. One result
   * carries one disclosure, so the clauses compose in one sentence — naming
   * either alone would drop a cause the reader is owed. Same shape as
   * {@link BranchMetricDisclosure.BranchesAndEvidenceIncomplete}, and the
   * resting clause always closes the sentence. Clause wording: ISS-10608.
   */
  PenseroDaysFailedAndAttributionAmbiguous:
    "* Calculated from the Pensero delivery days collected so far. Some days could not be collected, some points belong to more than one branch, and earlier history is still being collected.",
  /**
   * ISS-10608, operator ruling 2026-09-17: a stored point value no measurement
   * could have produced, so its share was refused. A different cause from
   * {@link BranchMetricDisclosure.PenseroAttributionAmbiguous}. Members below
   * compose the ruled clauses in the order the ticket fixes: days, then
   * attribution, then values.
   */
  PenseroPointValuesUnreadable:
    "* Calculated from the Pensero delivery days collected so far. Some point values could not be read, and earlier history is still being collected.",
  /** ISS-10608, operator ruling 2026-09-17: days and values. */
  PenseroDaysFailedAndPointValuesUnreadable:
    "* Calculated from the Pensero delivery days collected so far. Some days could not be collected, some point values could not be read, and earlier history is still being collected.",
  /** ISS-10608, operator ruling 2026-09-17: attribution and values. */
  PenseroAttributionAmbiguousAndPointValuesUnreadable:
    "* Calculated from the Pensero delivery days collected so far. Some points belong to more than one branch, some point values could not be read, and earlier history is still being collected.",
  /** ISS-10608, operator ruling 2026-09-17: all three shortfalls. */
  PenseroDaysFailedAttributionAmbiguousAndPointValuesUnreadable:
    "* Calculated from the Pensero delivery days collected so far. Some days could not be collected, some points belong to more than one branch, some point values could not be read, and earlier history is still being collected.",
  /**
   * ISS-9959: merge rate's incompleteness is about WHICH pull requests could be
   * associated to the cohort and read, not about their line counts, so it
   * cannot borrow `PrIncomplete`'s sentence about sizes. It previously fell to
   * `DefaultIncomplete`, a star that names no cause at all.
   */
  PrCoverageIncomplete:
    "* Calculated from the PRs linked to these branches. Some qualifying pull requests are unavailable.",
  PrIncomplete:
    "* Calculated from merged PRs with known line counts. Some qualifying pull request sizes are unavailable.",
  /**
   * ISS-9957: the pushed-lines basis, which has no denominator. Its siblings all
   * name Session cost, and printing one of those under a card that divides by
   * nothing would footnote a different number than the `*` is attached to.
   */
  PushedLocIncomplete:
    "* Counted from recorded pushes. Published changes with no recorded push are excluded, so this total is incomplete.",
} as const;
export type BranchMetricDisclosure =
  (typeof BranchMetricDisclosure)[keyof typeof BranchMetricDisclosure];

export const BranchMetricPeriod = {
  SevenDays: "7d",
  ThirtyDays: "30d",
  SixtyDays: "60d",
  NinetyDays: "90d",
  All: "all",
} as const;
export type BranchMetricPeriod =
  (typeof BranchMetricPeriod)[keyof typeof BranchMetricPeriod];

export const BranchMetricComparisonLabel = {
  WeekOverWeek: "WoW",
  MonthOverMonth: "MoM",
  PriorSixtyDays: "vs prior 60d",
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
  PullRequestTerminalAt: "pull_request_terminal_at",
  PublicationAt: "publication_at",
  /**
   * When a Session's cost event occurred. ISS-9970 renamed this from
   * `PhaseContributionAt`: the dollar is total estimated cost, so the instant
   * that places it in a window is the cost event's own, not the lifecycle
   * phase segment that happened to carry it.
   */
  SessionCostAt: "session_cost_at",
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
    population: "qualifying Session cost contributions",
    numerator: "deduplicated total estimated Session cost",
    denominator: null,
    numeratorEventTime: BranchMetricEventTime.SessionCostAt,
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
  /**
   * ISS-9097 item 2. The numerator used to read "deduplicated verified-push OR
   * merged-PR additions plus deletions", which a reader takes as a union and
   * which the CEO's merged-authored ruling cannot be squared with, because it
   * names no single basis to square.
   *
   * The producer picks ONE lane per branch and discards the other
   * (`apps/api/app/branches/branch-publication-loc-projection.ts`): push rows
   * when captured pushes cover every admitted merged PR, admitted merged-PR rows
   * otherwise. So the primary basis is PUSHED — which is what ISS-10667 already
   * asserts by moving this label to "Pushed LOC per $" — and merged-PR evidence
   * is a fallback, never the merged-authored measure, which is Sessions'.
   * "Deduplicated" now says within WHICH lane: push and PR rows carry different
   * change identities, so reconciliation has not fused them across lanes since
   * that split. What the change identity IS stays unspelled, because one
   * sentence renders on both surfaces and they key it differently — cloud on
   * the merged PR's head SHA, desktop on repository plus PR number.
   *
   * The LANE SELECTION is the cloud producer's alone. The desktop projection
   * (`apps/desktop/src/main/branch/branch-publication-loc-projection.ts`) has no
   * push lane at all — it never emits `SuccessfulPush` and admits every merged
   * PR — so on that surface the conditional never arises and the merged arm is
   * what it always computes.
   */
  [BranchMetricId.ListLocPerDollar]: {
    id: BranchMetricId.ListLocPerDollar,
    label: "LOC per $",
    unit: BranchMetricUnit.LinesPerDollar,
    population:
      "verified publication LOC and qualifying Session cost in the filtered scope",
    numerator:
      "per branch, successful-push additions plus deletions deduplicated by push, or admitted merged-PR additions plus deletions deduplicated by change identity when captured pushes do not cover every admitted merged PR",
    denominator:
      "deduplicated total estimated Session cost using the global Branch divisor",
    numeratorEventTime: BranchMetricEventTime.PublicationAt,
    denominatorEventTime: BranchMetricEventTime.SessionCostAt,
    periodBehavior:
      "independently window publication LOC and Session cost activity, then divide their totals",
    applicability:
      "nonempty filtered Branch cohort with a qualifying Session population and defensible evidence totals",
  },
  [BranchMetricId.DetailLocPerDollar]: {
    id: BranchMetricId.DetailLocPerDollar,
    label: "LOC per $",
    unit: BranchMetricUnit.LinesPerDollar,
    population: "selected Branch lifetime",
    numerator:
      "per branch, lifetime successful-push additions plus deletions deduplicated by push, or admitted merged-PR additions plus deletions deduplicated by change identity when captured pushes do not cover every admitted merged PR",
    denominator: "selected Branch lifetime total estimated cost",
    numeratorEventTime: BranchMetricEventTime.SelectedBranchLifetime,
    denominatorEventTime: BranchMetricEventTime.SelectedBranchLifetime,
    periodBehavior: "selected Branch lifetime; list date filter does not apply",
    applicability:
      "qualifying Branch Session population with defensible lifetime publication LOC and positive Branch cost",
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
  /**
   * ISS-9956 acceptance 1 and 2. Its own id rather than
   * {@link BranchMetricId.ListLocPerDollar}: this dictionary is a 1:1 formula
   * contract, and the two entries do not share a denominator. The List entry
   * divides phase-attributed `agent_session_token_events` cost reconciled over
   * an independent population; this one divides TOTAL ESTIMATED COST — the same
   * figure the Sessions listing metrics card headlines, on the same basis.
   */
  [BranchMetricId.CanonicalLocPerDollar]: {
    id: BranchMetricId.CanonicalLocPerDollar,
    label: "LOC per $",
    unit: BranchMetricUnit.LinesPerDollar,
    population:
      "verified publication LOC in the filtered scope over the cohort's total estimated cost",
    numerator:
      "per branch, successful-push additions plus deletions deduplicated by push, or admitted merged-PR additions plus deletions deduplicated by change identity when captured pushes do not cover every admitted merged PR",
    denominator:
      "total estimated cost: each distinct Session's estimated cost counted once, every billing lane included",
    numeratorEventTime: BranchMetricEventTime.PublicationAt,
    denominatorEventTime: BranchMetricEventTime.SessionCostAt,
    periodBehavior:
      "publication LOC in the selected adjacent UTC window over the cohort's total estimated cost",
    applicability:
      "nonempty filtered Branch cohort with publication evidence and positive total estimated cost",
  },
  [BranchMetricId.TotalLocPushed]: {
    id: BranchMetricId.TotalLocPushed,
    label: "Total LOC pushed",
    unit: BranchMetricUnit.Lines,
    population:
      "verified successful-push publication evidence in the filtered scope",
    numerator: "deduplicated successful-push additions plus deletions",
    denominator: null,
    numeratorEventTime: BranchMetricEventTime.PublicationAt,
    denominatorEventTime: null,
    periodBehavior:
      "publication LOC assigned to the selected adjacent UTC window",
    applicability:
      "nonempty filtered Branch cohort with defensible successful-push evidence",
  },
  /**
   * ISS-9958. Its own id rather than {@link BranchMetricId.ListLocPerDollar}:
   * the two carry the same label but not the same formula, and this dictionary
   * is a 1:1 formula contract. Reusing the List id would file this card under
   * an entry documenting the push-or-merged numerator over an independent
   * denominator population — precisely the derivation it was built not to be.
   */
  [BranchMetricId.PushedLocPerDollar]: {
    id: BranchMetricId.PushedLocPerDollar,
    label: "LOC per $",
    unit: BranchMetricUnit.LinesPerDollar,
    population:
      "successful-push publication LOC and the cohort's own qualifying cost in the filtered scope",
    numerator: "deduplicated successful-push additions plus deletions",
    denominator:
      "the estimated cost total the spend figure reports for the same cohort",
    numeratorEventTime: BranchMetricEventTime.PublicationAt,
    denominatorEventTime: BranchMetricEventTime.SessionCostAt,
    periodBehavior:
      "publication LOC and cost activity in the selected adjacent UTC window",
    applicability:
      "nonempty filtered Branch cohort with successful-push evidence and positive estimated cost",
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

/**
 * The metric re-derived over equal sub-windows of the CURRENT window, oldest
 * first (ISS-10363).
 *
 * Every point is the same fold the headline figure performs, run over a slice of
 * the same evidence — not a second derivation that could disagree with the
 * number it sits under. A bucket the producer could not compute is `null`, which
 * is a gap in the line rather than a measured zero.
 *
 * It is deliberately independent of {@link BranchListMetricValue.comparison}: a
 * series says what the period looked like, a comparison says how the period
 * compares to the one before it, and each can be present while the other is not.
 * Dropping the shape of the period because no prior window exists is the defect
 * this field ends.
 *
 * Additive and optional: a producer predating it omits it, and a consumer that
 * does not read it renders today's card.
 */
export type BranchMetricSeries = readonly (number | null)[];

export type BranchListMetricValue = {
  current: BranchMetricResult<number>;
  comparison?: BranchMetricComparison;
  series?: BranchMetricSeries;
};

/**
 * The metrics whose shipped form does not answer the question the selected
 * range asks (ISS-7363, ISS-7364).
 *
 * `activeBranches` counts the date-stripped canonical cohort, so it prints the
 * same lifetime number in every range while its neighbours rescope; here it
 * counts the range's own cohort, using the same retention rule the list SQL
 * applies, so the tile and the pagination footer describe one population.
 *
 * `aiSpendUsd` treats "the cohort holds cost evidence and none of it landed in
 * this range" as indistinguishable from "coverage is incomplete", which
 * publishes a knowable partial zero as an unknown; here that one case keeps the
 * partial state and its disclosure, so a narrower range degrades toward zero
 * instead of vanishing. Evidence that landed in range but could not be READ
 * stays unknown, as does a cohort with no cost telemetry at all.
 *
 * `locPerDollar` is deliberately absent: a ratio whose denominator is unknown is
 * unknown, not zero, so the shipped field is already the honest answer.
 *
 * Additive and optional: a producer predating this field simply omits it, and a
 * consumer that does not read it keeps the shipped values.
 */
export type BranchListWindowScopedMetrics = {
  activeBranches: BranchListMetricValue;
  aiSpendUsd: BranchListMetricValue;
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
  /**
   * ISS-9956: LOC per $ divided by TOTAL ESTIMATED COST — the one dollar basis,
   * shared with Sessions.
   *
   * `locPerDollar` divides phase-attributed `agent_session_token_events` cost,
   * reconciled over a population independent of the visible cohort (ISS-6543),
   * and weighted per branch by `qualifyingBranchCount`. The Sessions listing
   * metrics card headlines `AgentSessionUsageSummary.totalEstimatedCost` — each
   * distinct Session's `SessionDetail.estimatedCost` counted ONCE, every billing
   * lane included. Those are two different numbers off two different tables, so
   * the same window could not render the same dollar figure on both surfaces.
   *
   * This field divides the Sessions basis. It is subscription-INCLUSIVE, which
   * is the whole of `AgentSessionCostSplitFields.totalEstimatedCost`'s contract
   * ("never narrow it to metered-only") — `apiEstimatedCost` is the
   * subscription-exclusive figure and is deliberately NOT what this divides.
   *
   * Additive and optional: a producer predating it omits it and the consumer
   * keeps today's tile, so a version-skewed response degrades to the shipped
   * `locPerDollar` rather than an empty one.
   */
  canonicalLocPerDollar?: BranchListMetricValue;
  /**
   * ISS-9957: total LOC pushed to origin across the cohort in the window.
   *
   * The SuccessfulPush arm alone. `locPerDollar`'s numerator counts push OR
   * merged-PR evidence, so it cannot say which kind of line it counted; this
   * field counts pushed lines and nothing else, which is the single Branches
   * numerator ISS-9956 fixes. It is the same total {@link pushedLocPerDollar}
   * divides, so the card and the ratio reconcile exactly rather than being two
   * independently derived figures that can disagree on one screen.
   *
   * Additive and optional: a producer predating it omits it and the consumer
   * keeps today's row.
   */
  totalLocPushed?: BranchListMetricValue;
  /**
   * ISS-9958: LOC per $ over one basis — pushed lines ÷ the same estimated cost
   * total the spend figure reports.
   *
   * `locPerDollar` divides a push-or-merged numerator by an INDEPENDENT
   * denominator population (ISS-6543), so its two terms need not describe the
   * same branches and its value need not reconcile with the spend shown beside
   * it. This field takes its numerator from {@link totalLocPushed} and its
   * denominator from the cohort's own cost contributions, so both terms span one
   * population and the ratio reconciles with that spend total.
   *
   * Additive and optional: a producer predating it omits it and the consumer
   * keeps today's tile.
   */
  pushedLocPerDollar?: BranchListMetricValue;
  /**
   * ISS-11117: the cohort's Pensero delivery points over the IDENTICAL
   * denominator {@link canonicalLocPerDollar} divides — the one dollar basis —
   * so the two ratios describe one population and only the numerator differs.
   *
   * Additive and optional, and its absence is MEANINGFUL rather than merely
   * version skew, exactly as on {@link BranchDetailMetricBundle}: a producer
   * predating the field omits it, and so does a current producer whose reader is
   * outside the Pensero display rollout or whose cohort has no delivery
   * evidence. Every one of those means the same thing to a consumer — there is
   * no Pensero numerator here, so render LOC/$ unchanged — which is why one
   * absent field serves them all instead of a nullable field that would force a
   * consumer to tell "old server" from "no data" in order to render.
   *
   * CURRENT ONLY, no comparison and no series, for the reason
   * `canonicalLocPerDollar` carries: the denominator is a single scalar the
   * producer folded over the current window, so a prior or per-bucket result
   * would divide that window's points by this window's cost and report a
   * numerator-only movement as a movement in efficiency.
   */
  penseroPointsPerDollar?: BranchListMetricValue;
  windowScoped?: BranchListWindowScopedMetrics;
};

export type BranchDetailMetricBundle = {
  locPerDollar: BranchMetricResult<number>;
  /**
   * ISS-9814: the same branch-lifetime ratio with Pensero delivery points as its
   * numerator instead of publication LOC, over the IDENTICAL denominator
   * {@link locPerDollar} uses.
   *
   * Additive and optional, and its absence is meaningful rather than merely
   * version skew: a producer that predates this field omits it, AND so does a
   * current producer whose reader is outside the Pensero rollout or whose branch
   * has no delivery evidence. Both cases mean the same thing to a consumer —
   * there is no Pensero numerator here, so render LOC/$ — which is why one
   * absent field serves both instead of a nullable field that would force a
   * consumer to tell "old server" from "no data" in order to render.
   *
   * A PRESENT result whose value is `0` is a measured zero and renders as one.
   */
  penseroPointsPerDollar?: BranchMetricResult<number>;
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

/** Selected PR cycle evidence used by both server and cached client projections. */
export type BranchMetricSelectedCycle = {
  cycleId: string;
  openedAt: string | null;
  terminalAt: string | null;
  outcome: BranchMetricPullRequestOutcome;
  successfulPushes: readonly {
    cycleId: string;
    occurredAt: string | null;
  }[];
};
