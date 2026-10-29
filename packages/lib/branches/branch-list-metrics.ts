import {
  type BranchListMetricBundle,
  type BranchListMetricValue,
  type BranchListWindowScopedMetrics,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  type BranchMetricResult,
  type BranchMetricSeries,
  type BranchMetricWindow,
} from "@repo/api/src/types/branch-metrics";
import { locPerDollarFromPopulation } from "@repo/api/src/utils/loc-per-dollar";
import {
  type BranchMetricCostContribution,
  costCoverageFlagHolds,
  costEvidenceIsComplete,
  reconcileAllocatedCost,
} from "./branch-cost-evidence";
import type { BranchMetricCostFacts } from "./branch-cost-facts";
import type { BranchPenseroPointsInput } from "./branch-detail-pensero-points";
import {
  memoizedPushedChangeIdentities,
  reconcilePublicationLoc,
  reconcileStatusSnapshots,
} from "./branch-list-metric-reconcilers";
import { canonicalPenseroPointsPerDollarResult } from "./branch-list-pensero-points";
import {
  complete,
  emptyCohortResult,
  noData,
  notApplicable,
  partial,
  unavailable,
} from "./branch-metric-results";
import {
  bucketSeries,
  buildBranchMetricSeriesWindows,
} from "./branch-metric-series";
import {
  type AdjacentBranchMetricWindows,
  branchIsInMetricCohortWindow,
  branchMetricWindowOverlapsInterval,
  buildBranchMetricComparison,
  isTimestampInBranchMetricWindow,
  locEvidenceAffectsWindow,
  parseInstantMs,
  timestampIsTrustworthy,
} from "./branch-metric-windows";
import {
  type BranchMetricLocContribution,
  type BranchMetricLocCoverageGap,
  sumBranchPublicationLoc,
} from "./branch-publication-loc";
import {
  type BranchMetricPullRequestFacts,
  branchMetricWindowKey,
  calculateMedianPrSize,
  calculateMergeRate,
} from "./branch-pull-request-metrics";
import {
  hasPushedLocEvidence,
  pushedLocEvidenceIsComplete,
} from "./branch-pushed-loc";

export type { BranchMetricCostContribution } from "./branch-cost-evidence";
export type { BranchMetricLocContribution } from "./branch-publication-loc";

export type BranchMetricActivityEvidence = {
  sourceEventId: string;
  occurredAt: string | null;
};

export type BranchMetricStatusSnapshot = {
  branchId: string;
  currentActive: boolean | null;
  priorActive: boolean | null;
  /**
   * Latest activity instant, or null when Last active is unavailable. Optional:
   * only the range-scoped count reads it, and a producer that omits it gets the
   * retention arm of {@link branchIsInMetricCohortWindow}, which is the same
   * answer the list SQL gives a row with no activity.
   */
  lastActivityAt?: string | null;
};

export type BranchMetricPullRequestEvidence = {
  identity: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number | null;
  deletions: number | null;
  /**
   * ISS-11589: the authority arm of the twin tie-break in
   * `../pull-requests/merged-pr-twin-resolution`, read only when two rows for
   * one pull request are both sized and disagree. OPTIONAL because only the
   * App/webhook path ever writes a `githubId`: a producer with no App-owned
   * rows to distinguish — the desktop store — omits it and gets the sized-beats-
   * unsized arm alone, which is the whole rule that applies to it.
   */
  githubId?: string | null;
};

/**
 * One shortfall in the cohort's associated-pull-request evidence, placed at the
 * instant of the event it describes — and only when that event was OBSERVED.
 *
 * `occurredAt` is emphatically not a branch's latest known activity. The pull
 * request a shortfall describes is one the producer failed to read, and the
 * `missing_terminal_timestamp` case is a pull request that WAS decided while its
 * instant never was; the activity ledger emits no atom for a terminal event with
 * no timestamp, so a branch can read "last active in June" while the unread
 * merge landed in July. Treating that activity as an upper bound published a
 * confident merge rate quietly missing a merge, so only an instant the producer
 * actually observed may be put here — the same rule the LOC sibling
 * ({@link BranchMetricLocCoverageGap}) already follows, which is why both share
 * {@link locEvidenceAffectsWindow}. `null` means unplaceable, and poisons every
 * window.
 *
 * WHICH shortfalls reach the kernel at all is the producer's call, made by
 * `associatedPullRequestsWithholdDecisions`: one that hides no merge and no
 * unmerged close is not a gap and is simply omitted.
 */
export type BranchMetricPullRequestCoverageGap = {
  /**
   * The branch the gap belongs to, for legibility only — the kernel reads just
   * the instant. Omitted when the cause is not attributable to any one branch,
   * such as a repository-scoped pull-request response that was capped or failed.
   */
  branchId?: string;
  occurredAt: string | null;
};

export type BranchListMetricInput = {
  cohortSize: number;
  /**
   * False when the producer could not establish WHICH branches belong in the
   * cohort, as opposed to establishing that none do.
   *
   * An incomplete cohort has two important forms. When `cohortSize` is 0,
   * "we looked, and no branch qualifies" is No data, while "we could not
   * qualify the branches at all" is Unavailable. A non-empty cohort can also be
   * incomplete when known siblings qualify but one candidate remains typed and
   * unresolved. In that case every aggregate is still Unavailable because the
   * omitted candidate could change its value; the known rows remain visible.
   *
   * Optional, defaulting to complete: a producer with no such qualification step
   * (the cloud read, and every fixture that builds a cohort directly) is telling
   * the truth by omission.
   */
  cohortCoverageComplete?: boolean;
  lastActiveEvents: readonly BranchMetricActivityEvidence[];
  lastActiveCoverageComplete: boolean;
  statusSnapshots: readonly BranchMetricStatusSnapshot[];
  locContributions: readonly BranchMetricLocContribution[];
  /** Known omitted publication evidence, with time when it is trustworthy. */
  locCoverageGaps?: readonly BranchMetricLocCoverageGap[];
  /** True only when every qualifying publication contribution is represented. */
  locCoverageComplete?: boolean;
  locCompleteBranchIds: readonly string[];
  /**
   * Pull-request evidence for a producer that does not fold its own
   * {@link pullRequestFacts}. Both fields are read together: either one missing
   * leaves Median PR size and Merge rate Unavailable.
   */
  pullRequests?: readonly BranchMetricPullRequestEvidence[];
  pullRequestCoverageComplete?: boolean;
  /**
   * Shortfalls in associated-pull-request evidence that genuinely hide a decided
   * pull request, each placed at an observed instant or `null` when unplaceable.
   *
   * Optional and additive. OMITTED, `pullRequestCoverageComplete` alone decides,
   * which is the pre-ISS-9959 behaviour byte for byte. SUPPLIED — an EMPTY array
   * included — it is what makes the answer PER WINDOW: that flag is one
   * cohort-wide `every(...)`, so a single branch anywhere in the org carrying any
   * completeness reason starred every non-count card in every window,
   * permanently.
   */
  pullRequestCoverageGaps?: readonly BranchMetricPullRequestCoverageGap[];
  /**
   * Median PR size and Merge rate folded by the producer. When present the
   * kernel reads these and never `pullRequests` for either metric.
   */
  pullRequestFacts?: BranchMetricPullRequestFacts;
  /**
   * AI spend folded by the producer (ISS-12346). When present the spend fold
   * reads this and never the cost contribution lists, and every LOC per $ is
   * Pushed LOC per $ over it.
   */
  costFacts?: BranchMetricCostFacts;
  /**
   * AI spend folded by the producer for the spend metric ALONE (ISS-12361).
   * Unlike {@link costFacts} it leaves every LOC per $ on the evidence path, for
   * a producer with no pushed LOC yet.
   */
  aiSpendFacts?: BranchMetricCostFacts;
  costContributions: readonly BranchMetricCostContribution[];
  costCompleteBranchIds: readonly string[];
  /** Independent publication-gated denominator contributions for LOC per $. */
  locPerDollarCostContributions?: readonly BranchMetricCostContribution[];
  /** Every qualifying Session in the denominator authority population. */
  locPerDollarQualifyingSessionIds?: readonly string[];
  /** True only when cost and global-divisor coverage are complete. */
  locPerDollarCostCoverageComplete?: boolean;
  /**
   * ISS-9956 — TOTAL ESTIMATED COST for this cohort: each distinct Session's
   * estimated cost counted ONCE, every billing lane included.
   *
   * The one dollar basis, and deliberately NOT a fold over
   * {@link costContributions}. Those are `agent_session_token_events` rows,
   * phase-attributed and split across branches by `qualifyingBranchCount`; this
   * is the Session-grain total the Sessions listing metrics card headlines
   * (`AgentSessionUsageSummary.totalEstimatedCost`) and the same figure
   * `/branches/usage` already publishes. Both producers already compute it —
   * cloud via `sumDistinctSessionUsage`, desktop via its session-deduped
   * `totalSpendUsd` — so this threads an existing number in rather than
   * introducing a third derivation of the same money.
   *
   * Subscription-INCLUSIVE. `undefined` means "this producer did not send one",
   * never zero: an absent basis withholds the ratio instead of dividing by 0.
   */
  canonicalEstimatedCostUsd?: number;
  /**
   * ISS-11117 — the COHORT's Pensero delivery points. Absent, never zero, when
   * this listing has no Pensero numerator: see `branch-list-pensero-points.ts`.
   */
  penseroPoints?: BranchPenseroPointsInput | null;
  /**
   * The producer's evaluation instant, so a Last active AHEAD of it is retained
   * by the range-scoped cohort exactly as the list SQL retains it.
   */
  evaluationNow?: string;
};

/** Calculate the canonical List bundle from normalized persisted evidence. */
export function calculateBranchListMetrics(
  input: BranchListMetricInput,
  windows: AdjacentBranchMetricWindows
): BranchListMetricBundle {
  const current = calculateWindowMetrics(
    input,
    windows.current,
    false,
    windows.requested
  );
  const prior = windows.prior
    ? calculateWindowMetrics(input, windows.prior, true)
    : null;
  // ISS-10363: the same fold, re-run over equal slices of the SAME window and
  // the SAME evidence. Nothing is loaded for it and no second derivation exists
  // to drift from the headline — a point IS the headline's fold, narrowed.
  const buckets = buildBranchMetricSeriesWindows(windows.current).map(
    (bucket) => calculateWindowMetrics(input, bucket)
  );
  // ISS-11117 (H4, davetho review on #8791): the denominator rides the
  // REQUESTED range, which on a non-preset range is not `windows.current` —
  // that one is all-time. `cohortPenseroReaderForRequest` windows the numerator
  // to the request's own bounds, so reading the all-time spend here divided a
  // range-filtered numerator by all-history money and shrank the ratio by
  // whatever was spent before the range.
  const penseroSpendWindow = windows.requested ?? windows.current;
  const penseroPointsPerDollar = canonicalPenseroPointsPerDollarResult(
    input,
    input.costFacts ? calculateAiSpend(input, penseroSpendWindow) : undefined
  );
  return {
    period: windows.period,
    label: windows.label,
    window: windows.current,
    cohortSize: input.cohortSize,
    lastActiveAt: calculateLastActive(input),
    // ISS-10363: NO series, and deliberately not an empty one. This metric is a
    // boundary SNAPSHOT — `calculateActiveBranches` reads status at the window's
    // edge and never folds evidence inside it — so every bucket returns the
    // identical figure. That line is flat for every cohort in every period, and
    // a flat line is a claim about the period, not an absence of one.
    activeBranches: metricValue(
      current.activeBranches,
      prior?.activeBranches,
      windows
    ),
    locPerDollar: metricValue(
      current.locPerDollar,
      prior?.locPerDollar,
      windows,
      bucketSeries(buckets, (bucket) => bucket.locPerDollar)
    ),
    medianPrSize: metricValue(
      current.medianPrSize,
      prior?.medianPrSize,
      windows,
      bucketSeries(buckets, (bucket) => bucket.medianPrSize)
    ),
    // ISS-10363 (tamsinb review on #7448): NO CARD ON THE ROW SELECTS THIS
    // TODAY — ISS-9957 took AI spend off the row, and ISS-10636 left that row
    // the only one. It is folded anyway, and deliberately: the bucket fold
    // computes every metric in `WindowMetrics` whether or not its series is
    // published, so omitting this one saves no work, only about twelve numbers
    // on the wire — and the field is the additive, optional kind a later AI
    // spend card would read without a producer change. Withholding a computable
    // series to save that is the deletion AGENTS.md forbids, not a saving.
    aiSpendUsd: metricValue(
      current.aiSpendUsd,
      prior?.aiSpendUsd,
      windows,
      bucketSeries(buckets, (bucket) => bucket.aiSpendUsd)
    ),
    mergeRatePct: metricValue(
      current.mergeRatePct,
      prior?.mergeRatePct,
      windows,
      bucketSeries(buckets, (bucket) => bucket.mergeRatePct)
    ),
    // ISS-9956 (#7021 review, codex + whitlockk): CURRENT ONLY — deliberately not
    // through `metricValue`. Every sibling above re-derives both terms per
    // window, but this metric's denominator is a single scalar the producer
    // folded over the CURRENT window alone, so a prior result would divide
    // prior-window LOC by current-window cost and the delta would report a
    // LOC-only change as a change in efficiency. A comparison that cannot be
    // computed honestly is withheld rather than rendered.
    canonicalLocPerDollar: {
      current: canonicalLocPerDollarResult(input, windows.current),
      // ISS-10363: no series, for the reason stated directly above. A bucket
      // would divide that bucket's LOC by the WHOLE window's cost scalar, so the
      // line would report a LOC-only change as a change in efficiency — the same
      // dishonesty the withheld comparison avoids, drawn twelve times.
      //
      // THE UNCOVERED OPERAND IS THE PER-BUCKET DENOMINATOR (tamsinb review on
      // #7448). This is the AGENTS.md carve-out and not the rule it looks like:
      // the shortfall sits BETWEEN the two operands and biases the ratio rather
      // than narrowing its sample, so a footnote could not unbias it. It does
      // reach the reader, because the LOC per $ card prefers this field
      // whenever the producer sends it — which both producers do — so that
      // card draws no mark on any current producer. Giving it
      // one takes a per-bucket cost basis from the producer, not a change here.
    },
    // ISS-11117: OMITTED, never `undefined` — a consumer's AC2 fallback keys on
    // the field's ABSENCE. Same shape as the detail bundle's sibling.
    ...(penseroPointsPerDollar
      ? { penseroPointsPerDollar: { current: penseroPointsPerDollar } }
      : {}),
    totalLocPushed: metricValue(
      current.totalLocPushed,
      prior?.totalLocPushed,
      windows,
      bucketSeries(buckets, (bucket) => bucket.totalLocPushed)
    ),
    pushedLocPerDollar: metricValue(
      current.pushedLocPerDollar,
      prior?.pushedLocPerDollar,
      windows,
      bucketSeries(buckets, (bucket) => bucket.pushedLocPerDollar)
    ),
    windowScoped: calculateWindowScopedMetrics(input, windows),
  };
}

type WindowMetrics = {
  activeBranches: BranchMetricResult<number>;
  locPerDollar: BranchMetricResult<number>;
  medianPrSize: BranchMetricResult<number>;
  aiSpendUsd: BranchMetricResult<number>;
  mergeRatePct: BranchMetricResult<number>;
  totalLocPushed: BranchMetricResult<number>;
  pushedLocPerDollar: BranchMetricResult<number>;
};

function calculateWindowMetrics(
  input: BranchListMetricInput,
  window: BranchMetricWindow,
  prior = false,
  pullRequestWindow: BranchMetricWindow = window
): WindowMetrics {
  if (input.cohortCoverageComplete === false) {
    return {
      activeBranches: unavailable(),
      locPerDollar: unavailable(),
      medianPrSize: unavailable(),
      aiSpendUsd: unavailable(),
      mergeRatePct: unavailable(),
      totalLocPushed: unavailable(),
      pushedLocPerDollar: unavailable(),
    };
  }
  return {
    activeBranches: calculateActiveBranches(input, prior),
    locPerDollar: input.costFacts
      ? calculatePushedLocPerDollar(input, window)
      : calculateLocPerDollar(input, window),
    medianPrSize: calculateMedianPrSize(input, pullRequestWindow),
    aiSpendUsd: calculateAiSpend(input, window),
    mergeRatePct: calculateMergeRate(input, pullRequestWindow),
    totalLocPushed: calculateTotalLocPushed(input, window),
    pushedLocPerDollar: calculatePushedLocPerDollar(input, window),
  };
}

function calculateLastActive(
  input: BranchListMetricInput
): BranchMetricResult<string> {
  if (input.cohortCoverageComplete === false) {
    return unavailable();
  }
  if (input.cohortSize === 0) {
    return emptyCohortResult(input);
  }
  return calculateBranchLastActiveMetric(
    input.lastActiveEvents,
    input.lastActiveCoverageComplete
  );
}

/** Calculate Last active for one Branch or an already-scoped Branch cohort. */
export function calculateBranchLastActiveMetric(
  events: readonly BranchMetricActivityEvidence[],
  coverageComplete: boolean
): BranchMetricResult<string> {
  const bySource = new Map<string, number>();
  let malformedEvidence = false;
  for (const event of events) {
    const timestamp = parseTimestamp(event.occurredAt);
    if (!event.sourceEventId || timestamp === null) {
      malformedEvidence = true;
      continue;
    }
    bySource.set(
      event.sourceEventId,
      Math.max(bySource.get(event.sourceEventId) ?? timestamp, timestamp)
    );
  }
  let latest = Number.NEGATIVE_INFINITY;
  for (const timestamp of bySource.values()) {
    latest = Math.max(latest, timestamp);
  }
  if (!Number.isFinite(latest)) {
    return unavailable();
  }
  const value = new Date(latest).toISOString();
  if (!coverageComplete) {
    return partial(value);
  }
  return malformedEvidence
    ? partial(value, bySource.size, events.length)
    : complete(value);
}

function calculateActiveBranches(
  input: BranchListMetricInput,
  prior: boolean,
  cohortWindow?: BranchMetricWindow
): BranchMetricResult<number> {
  if (input.cohortSize === 0) {
    return emptyCohortResult(input);
  }
  const reconciled = reconcileStatusSnapshots(input.statusSnapshots);
  if (reconciled.conflicted) {
    return unavailable();
  }
  const scoped =
    cohortWindow === undefined
      ? reconciled.values
      : reconciled.values.filter((snapshot) =>
          branchIsInMetricCohortWindow(
            snapshot.lastActivityAt,
            cohortWindow,
            input.evaluationNow
          )
        );
  const resolvedState = (item: BranchMetricStatusSnapshot) =>
    prior ? item.priorActive : item.currentActive;
  // An unresolved status outside the range cannot change the count inside it.
  if (scoped.some((item) => resolvedState(item) === null)) {
    return unavailable();
  }
  // `[].some()` is false, so an EMPTY scope would otherwise walk past the
  // fail-closed guard above and publish a fabricated zero. The prior window is
  // where that bites: no producer supplies `priorActive`, so "0 active last
  // week" would be asserted from a cohort that says nothing about last week.
  if (
    scoped.length === 0 &&
    reconciled.values.some((item) => resolvedState(item) === null)
  ) {
    return unavailable();
  }
  const value = scoped.filter((item) => resolvedState(item) === true).length;
  if (reconciled.values.length !== input.cohortSize) {
    // No coverage pair on a range-scoped count: `reconciled.values.length` and
    // `cohortSize` both describe the lifetime cohort, and publishing them beside
    // a windowed value would caption it with a population it never counted.
    return cohortWindow === undefined
      ? partial(value, reconciled.values.length, input.cohortSize)
      : partial(value);
  }
  return complete(value);
}

function calculateLocPerDollar(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): BranchMetricResult<number> {
  if (input.cohortSize === 0) {
    return emptyCohortResult(input);
  }
  const denominatorContributions =
    input.locPerDollarCostContributions ?? input.costContributions;
  const qualifyingSessions = new Set(
    input.locPerDollarQualifyingSessionIds ??
      denominatorContributions.map((item) => item.sessionId)
  );
  const costCoverageComplete =
    input.locPerDollarCostCoverageComplete ?? costCoverageFlagHolds(input);
  if (qualifyingSessions.size === 0) {
    return costCoverageComplete ? noData() : unavailable();
  }

  const locEvidence = reconcilePublicationLoc(input.locContributions);
  const windowedLoc = locEvidence.values.filter((contribution) =>
    locEvidenceFallsInWindow(contribution.occurredAt, window)
  );
  const locCoverageComplete =
    locCoverageIsComplete(input, window) &&
    !locEvidence.conflicted &&
    !locEvidence.malformed &&
    locEvidence.values.every((contribution) =>
      timestampIsTrustworthy(contribution.occurredAt)
    );
  const costEvidence = reconcileAllocatedCost(denominatorContributions, window);
  const completeCost = costEvidenceIsComplete(
    costCoverageComplete,
    costEvidence
  );
  if (costEvidence.included === 0) {
    return noCostEvidence(completeCost);
  }
  if (costEvidence.total <= 0) {
    return completeCost ? notApplicable() : unavailable();
  }
  if (windowedLoc.length === 0 && !locCoverageComplete) {
    return unavailable();
  }

  // Each population WHOLE. This is what this field's Complete state has always
  // meant. ISS-9972 deleted the flag-selected population-matched alternate:
  // which arithmetic a shipped ratio performs is not a flag's decision, so
  // there is one denominator and one answer.
  const eachPopulationComplete = locCoverageComplete && completeCost;
  const value = locPerDollarFromPopulation({
    lines: sumBranchPublicationLoc(windowedLoc),
    cost: costEvidence.total,
    coverageComplete: true,
  });
  if (value === null) {
    return unavailable();
  }
  if (eachPopulationComplete) {
    return complete(value);
  }
  return partial(
    value,
    undefined,
    undefined,
    BranchMetricDisclosure.LocIncomplete
  );
}

function calculateAiSpend(
  input: BranchListMetricInput,
  window: BranchMetricWindow,
  publishKnowableZero = false
): BranchMetricResult<number> {
  if (input.cohortSize === 0) {
    return emptyCohortResult(input);
  }
  const fold = foldAiSpendCost(input, window);
  const {
    total,
    included,
    completeCoverage,
    rangeHoldsNoQualifyingEvidence,
    windowHoldsUnpricedEvents,
  } = fold;
  // ISS-12346 C6 (ruling, Cosimo Corrigan, 2026-10-12): "An unknown price makes
  // the figure Partial rather than hiding it." A window the producer READ, whose
  // events carry no price, is therefore published as the spend it could see with
  // `CostIncomplete` beside it — not withheld. Only a window the producer never
  // reached, or a cohort with no cost telemetry at all, stays Unavailable.
  if (
    included === 0 &&
    !(
      completeCoverage ||
      windowHoldsUnpricedEvents ||
      (publishKnowableZero && rangeHoldsNoQualifyingEvidence)
    )
  ) {
    return unavailable();
  }
  return completeCoverage
    ? complete(total)
    : partial(
        total,
        undefined,
        undefined,
        BranchMetricDisclosure.CostIncomplete
      );
}

/**
 * The estimated-cost total the AI spend figure publishes, as a reusable fold.
 *
 * Extracted (ISS-9958) so the LOC per $ denominator can be THIS total rather
 * than a second derivation of the same money. The ratio and the spend figure
 * then reconcile by construction instead of by coincidence — which is the whole
 * of ISS-9958 acceptance 3, and is not something two independent folds over two
 * different populations could promise.
 */
function foldAiSpendCost(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): AiSpendFold {
  const facts = input.costFacts ?? input.aiSpendFacts;
  return facts ? aiSpendFromFacts(facts, window) : NO_AI_SPEND_FACTS;
}

type AiSpendFold = {
  total: number;
  included: number;
  completeCoverage: boolean;
  rangeHoldsNoQualifyingEvidence: boolean;
  /**
   * The producer READ this window and it holds events whose price is unknown.
   * Distinct from an unread window and from a cohort with no telemetry: those
   * two carry no figure at all, while this one carries the spend that WAS
   * priced — $0 when nothing was — and is published Partial (ISS-12346 C6).
   */
  windowHoldsUnpricedEvents: boolean;
};

const NO_AI_SPEND_FACTS: AiSpendFold = {
  total: 0,
  included: 0,
  completeCoverage: false,
  rangeHoldsNoQualifyingEvidence: false,
  windowHoldsUnpricedEvents: false,
};

function aiSpendFromFacts(
  facts: BranchMetricCostFacts,
  window: BranchMetricWindow
): AiSpendFold {
  const windowFacts = facts.windows.get(branchMetricWindowKey(window));
  if (!windowFacts) {
    return NO_AI_SPEND_FACTS;
  }
  const completeCoverage =
    facts.cohortHoldsEvents && windowFacts.unusable === 0;
  return {
    total: windowFacts.spendUsd,
    included: windowFacts.included,
    completeCoverage,
    rangeHoldsNoQualifyingEvidence:
      completeCoverage && windowFacts.included === 0,
    windowHoldsUnpricedEvents: windowFacts.unusable > 0,
  };
}

function metricValue(
  current: BranchMetricResult<number>,
  prior: BranchMetricResult<number> | undefined,
  windows: AdjacentBranchMetricWindows,
  series?: BranchMetricSeries
): BranchListMetricValue {
  // ISS-10363: the series rides along on every arm. It answers a different
  // question from the comparison — what the period looked like, not how it
  // compares to the one before it — so a window with no prior keeps its shape.
  const shape = series === undefined ? {} : { series };
  if (!windows.prior || prior === undefined) {
    return { current, ...shape };
  }
  if (windows.label === BranchMetricComparisonLabel.AllTime) {
    return { current, ...shape };
  }
  return {
    current,
    ...shape,
    comparison: buildBranchMetricComparison(
      windows.label,
      windows.prior,
      current,
      prior
    ),
  };
}

function noCostEvidence(coverageComplete: boolean): BranchMetricResult<number> {
  return coverageComplete ? noData() : unavailable();
}

function locEvidenceFallsInWindow(
  occurredAt: string | null,
  window: BranchMetricWindow
): boolean {
  if (occurredAt === null) {
    return window.startAt === null;
  }
  return isTimestampInBranchMetricWindow(occurredAt, window);
}

function locCoverageIsComplete(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): boolean {
  const gaps = input.locCoverageGaps ?? [];
  if (gaps.some((gap) => locGapAffectsWindow(gap, window))) {
    return false;
  }
  if (input.locCoverageComplete === false && gaps.length === 0) {
    return false;
  }
  if (gaps.length > 0) {
    return true;
  }
  return (
    input.locCoverageComplete ??
    input.locCompleteBranchIds.length === input.cohortSize
  );
}

/**
 * Whether a coverage gap reaches this window.
 *
 * A gap carrying `affectsUntil` describes a shortfall that SPANS time rather
 * than happening at an instant — ISS-10009's pre-capture era is the first — so a
 * window lying wholly inside it is affected while containing neither bound. Any
 * gap without that field keeps the instant semantics every producer, desktop
 * included, already relies on.
 */
function locGapAffectsWindow(
  gap: BranchMetricLocCoverageGap,
  window: BranchMetricWindow
): boolean {
  if (gap.affectsUntil == null) {
    return locEvidenceAffectsWindow(gap.occurredAt, window);
  }
  return branchMetricWindowOverlapsInterval(
    gap.occurredAt,
    gap.affectsUntil,
    window
  );
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const timestamp = parseInstantMs(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

/**
 * The additive range-scoped companion described by
 * {@link BranchListWindowScopedMetrics} — computed from the same evidence, so the
 * two answers can be compared on one screen rather than one replacing the other.
 */
function calculateWindowScopedMetrics(
  input: BranchListMetricInput,
  windows: AdjacentBranchMetricWindows
): BranchListWindowScopedMetrics {
  const current = windowScopedResults(input, windows.current, false);
  const prior = windows.prior
    ? windowScopedResults(input, windows.prior, true)
    : null;
  return {
    activeBranches: metricValue(
      current.activeBranches,
      prior?.activeBranches,
      windows
    ),
    aiSpendUsd: metricValue(current.aiSpendUsd, prior?.aiSpendUsd, windows),
  };
}

function windowScopedResults(
  input: BranchListMetricInput,
  window: BranchMetricWindow,
  prior: boolean
): Pick<WindowMetrics, "activeBranches" | "aiSpendUsd"> {
  if (input.cohortCoverageComplete === false) {
    return {
      activeBranches: unavailable(),
      aiSpendUsd: unavailable(),
    };
  }
  return {
    activeBranches: calculateActiveBranches(input, prior, window),
    aiSpendUsd: calculateAiSpend(input, window, true),
  };
}

/**
 * ISS-9956: LOC per $ over the ONE dollar basis — publication LOC divided by
 * total estimated cost.
 *
 * The numerator is the same reconciled publication evidence `locPerDollar`
 * counts, so the two differ ONLY in denominator and a reader comparing them is
 * comparing bases, not populations. The denominator is
 * {@link BranchListMetricInput.canonicalEstimatedCostUsd} — threaded in whole
 * from the producer, never re-folded here, so this cannot derive a second
 * version of a number Sessions and `/branches/usage` already publish.
 *
 * Withheld rather than guessed in three reachable cases, each a different
 * absence: no basis sent (a producer predating this field), a basis that is not
 * a usable number (a non-finite or negative total is corrupt input, not a
 * measurement), and a zero basis with no money to divide by. Only the last is
 * `NotApplicable` — the cohort really did cost nothing — while the first two are
 * `Unavailable`, because "we were not told" must not render as "not applicable".
 *
 * Called for the CURRENT window only. `window` still bounds the NUMERATOR, but
 * the denominator is window-independent, so see
 * {@link canonicalLocPerDollarResult} for why no prior result is produced.
 */
function calculateCanonicalLocPerDollar(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): BranchMetricResult<number> {
  if (input.cohortSize === 0) {
    return emptyCohortResult(input);
  }
  const cost = input.canonicalEstimatedCostUsd;
  if (!(typeof cost === "number" && Number.isFinite(cost) && cost >= 0)) {
    return unavailable();
  }
  const locEvidence = reconcilePublicationLoc(input.locContributions);
  const windowedLoc = locEvidence.values.filter((contribution) =>
    locEvidenceFallsInWindow(contribution.occurredAt, window)
  );
  const locCoverageComplete =
    locCoverageIsComplete(input, window) &&
    !(locEvidence.conflicted || locEvidence.malformed) &&
    locEvidence.values.every((contribution) =>
      timestampIsTrustworthy(contribution.occurredAt)
    );
  if (cost === 0) {
    // A measured zero, not an unknown: the cohort's Sessions cost nothing, so
    // the ratio genuinely does not apply. Incomplete LOC coverage cannot change
    // that — the denominator is what makes it inapplicable.
    return locCoverageComplete ? notApplicable() : unavailable();
  }
  if (windowedLoc.length === 0 && !locCoverageComplete) {
    return unavailable();
  }
  // COHORT-scoped, so a verified zero is an ANSWER, not an unknown.
  // `locPerDollarFromLines` is the SESSION rule, where `lines <= 0` means "no
  // measurable output" and must not divide; using it here turned "these
  // branches published nothing in range and you spent $X" into Unavailable.
  // `calculateLocPerDollar` divides this same cohort shape through the
  // population rule, and the two helpers live one export apart precisely so the
  // choice is visible. Coverage is judged below rather than inside the helper,
  // so the flag is passed true and the incomplete case keeps its disclosure.
  const value = locPerDollarFromPopulation({
    lines: sumBranchPublicationLoc(windowedLoc),
    cost,
    coverageComplete: true,
  });
  if (value === null) {
    return unavailable();
  }
  return locCoverageComplete
    ? complete(value)
    : partial(
        value,
        undefined,
        undefined,
        BranchMetricDisclosure.LocIncomplete
      );
}

/**
 * The canonical LOC per $ for ONE window — the current one.
 *
 * ISS-9956 (#7021 review, codex + whitlockk). This metric is the one member of the
 * bundle whose two terms are not both re-derived per window:
 * {@link BranchListMetricInput.canonicalEstimatedCostUsd} arrives as a single
 * scalar that the producer folded over the REQUEST window, while every sibling
 * denominator is a contribution list this module filters by window itself. Run
 * over `windows.prior` the numerator would narrow to the prior window and the
 * denominator would not, so the published delta would read a pure LOC movement
 * as a movement in efficiency — worst on exactly the 7/30/90-day comparisons the
 * chip exists for, and most wrong when spend changed between the periods.
 *
 * Supplying a prior-window denominator instead would mean a second producer
 * fold and a second wire field; until that exists the honest answer is no
 * comparison, so this returns a bare result and the caller publishes only
 * `current`. Kept as its own helper so `calculateWindowMetrics` — which IS run
 * per window — cannot acquire this metric by accident.
 *
 * Carries the cohort-coverage guard that the per-window path applies to its own
 * members: a producer that could not qualify the population has not established
 * anything to divide.
 */
function canonicalLocPerDollarResult(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): BranchMetricResult<number> {
  if (input.cohortCoverageComplete === false) {
    return unavailable();
  }
  return input.costFacts
    ? calculatePushedLocPerDollar(input, window)
    : calculateCanonicalLocPerDollar(input, window);
}

/**
 * ISS-9957: gross lines pushed to origin across the cohort in the window.
 *
 * Filtered to the push arm BEFORE reconciliation, because reconciliation fuses a
 * push and a merged-PR observation of one commit and discards the tag doing it.
 * A commit that was both pushed and merged is still counted once, and
 * pushed-but-unmerged lines, which a merged-only count never sees, are included.
 * (Pre-ISS-10009-part-2 the single-count came from the two arms sharing a
 * `repo:sha` identity; the cloud producer now gives a push a RANGE identity and
 * drops the merged-PR row a push covers, so they never meet here.)
 *
 * Evidence carrying NO push observation is Unavailable, never `0`: the desktop
 * local projection emits merged-PR rows only, and summing those to zero would
 * assert "nothing was pushed" from evidence that cannot speak to pushes.
 */
function calculateTotalLocPushed(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): BranchMetricResult<number> {
  if (input.cohortSize === 0) {
    return emptyCohortResult(input);
  }
  if (!hasPushedLocEvidence(input.locContributions)) {
    return unavailable();
  }
  // Reconcile the WHOLE evidence set, THEN keep the changes a push observed.
  // Filtering first would hide a push/merged disagreement about one commit from
  // `reconcileBranchPublicationLoc`, which is the only thing that detects it:
  // the push row would be summed as fact exactly where the full reconciliation
  // drops the change and reports the conflict.
  const evidence = reconcilePublicationLoc(input.locContributions);
  const pushedIdentities = memoizedPushedChangeIdentities(
    input.locContributions
  );
  const pushed = evidence.values.filter((contribution) =>
    pushedIdentities.has(contribution.changeIdentity)
  );
  // Push evidence existed but reconciliation kept none of it — every pushed
  // change was contested or malformed. Summing the survivors to `0` would
  // report "nothing was pushed" from evidence that contradicts itself, which is
  // a different answer from a quiet window (`pushed` non-empty, none in range)
  // and the same conflation the spend fold refuses one metric over.
  if (pushed.length === 0) {
    return unavailable();
  }
  const windowed = pushed.filter((contribution) =>
    locEvidenceFallsInWindow(contribution.occurredAt, window)
  );
  const value = sumBranchPublicationLoc(windowed);
  const coverageComplete =
    locCoverageIsComplete(input, window) &&
    pushedLocEvidenceIsComplete(input.locContributions, (contribution) =>
      locEvidenceAffectsWindow(contribution.occurredAt, window)
    ) &&
    !(evidence.conflicted || evidence.malformed) &&
    pushed.every((contribution) =>
      timestampIsTrustworthy(contribution.occurredAt)
    );
  return coverageComplete
    ? complete(value)
    : partial(
        value,
        undefined,
        undefined,
        BranchMetricDisclosure.PushedLocIncomplete
      );
}

/**
 * ISS-9958: LOC per $ on one basis — pushed lines over the estimated cost the
 * spend figure reports.
 *
 * Both terms come from one place each: the numerator IS
 * {@link calculateTotalLocPushed}, the denominator IS {@link foldAiSpendCost}.
 * Neither is re-derived here, so the ratio cannot disagree with the LOC total
 * or the spend total rendered beside it.
 *
 * Incomplete evidence yields a disclosed Partial rather than a refusal: the
 * shipped companion returns `null` on incomplete coverage, and a hidden card is
 * what ISS-9958 exists to stop. The value is still withheld where it would be
 * fabricated — no push evidence, or no money to divide by.
 */
function calculatePushedLocPerDollar(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): BranchMetricResult<number> {
  const lines = calculateTotalLocPushed(input, window);
  if (
    lines.state !== BranchMetricAvailability.Complete &&
    lines.state !== BranchMetricAvailability.Partial
  ) {
    return lines;
  }
  const cost = foldAiSpendCost(input, window);
  if (!(Number.isFinite(cost.total) && cost.total > 0)) {
    return cost.completeCoverage ? notApplicable() : unavailable();
  }
  const value = locPerDollarFromPopulation({
    lines: lines.value,
    cost: cost.total,
    // Completeness is carried by this result's own state, not by refusing to
    // divide. The helper's `null`-on-incomplete arm is the behaviour ISS-9958
    // removes, so the verdict is applied below instead of suppressing the value.
    coverageComplete: true,
  });
  if (value === null) {
    return unavailable();
  }
  if (
    lines.state === BranchMetricAvailability.Complete &&
    cost.completeCoverage
  ) {
    return complete(value);
  }
  // Name the term that was actually short. One `*` carries one sentence, so a
  // fixed disclosure would explain the numerator on a card whose denominator is
  // the incomplete half, and the reader would go looking for the wrong gap.
  return partial(
    value,
    undefined,
    undefined,
    lines.state === BranchMetricAvailability.Partial
      ? BranchMetricDisclosure.PushedLocIncomplete
      : BranchMetricDisclosure.CostIncomplete
  );
}
