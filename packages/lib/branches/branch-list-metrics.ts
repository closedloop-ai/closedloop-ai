import {
  type BranchListMetricBundle,
  type BranchListMetricValue,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  type BranchMetricResult,
  type BranchMetricWindow,
} from "@repo/api/src/types/branch-metrics";
import type { BranchVisibleLifecyclePhase } from "@repo/api/src/types/branch-phase-attribution";
import {
  type AdjacentBranchMetricWindows,
  buildBranchMetricComparison,
  isTimestampInBranchMetricWindow,
} from "./branch-metric-windows";

export type BranchMetricActivityEvidence = {
  sourceEventId: string;
  occurredAt: string | null;
};

export type BranchMetricStatusSnapshot = {
  branchId: string;
  currentActive: boolean | null;
  priorActive: boolean | null;
};

export type BranchMetricLocContribution = {
  sourceEventId: string;
  branchId: string;
  occurredAt: string | null;
  additions: number | null;
  deletions: number | null;
};

export type BranchMetricPullRequestEvidence = {
  identity: string;
  mergedAt: string | null;
  closedAt: string | null;
  isDraft: boolean;
  additions: number | null;
  deletions: number | null;
};

export type BranchMetricCostContribution = {
  sourceEventId: string;
  branchId: string;
  sessionId: string;
  occurredAt: string | null;
  /** Null when persisted evidence cannot defensibly classify Build/Review/Rework. */
  phase: BranchVisibleLifecyclePhase | null;
  costUsd: number | null;
  qualifyingBranchCount: number | null;
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
  locCompleteBranchIds: readonly string[];
  pullRequests: readonly BranchMetricPullRequestEvidence[];
  pullRequestCoverageComplete: boolean;
  costContributions: readonly BranchMetricCostContribution[];
  costCompleteBranchIds: readonly string[];
};

/** Calculate the canonical List bundle from normalized persisted evidence. */
export function calculateBranchListMetrics(
  input: BranchListMetricInput,
  windows: AdjacentBranchMetricWindows
): BranchListMetricBundle {
  const current = calculateWindowMetrics(input, windows.current);
  const prior = windows.prior
    ? calculateWindowMetrics(input, windows.prior, true)
    : null;
  return {
    period: windows.period,
    label: windows.label,
    window: windows.current,
    cohortSize: input.cohortSize,
    lastActiveAt: calculateLastActive(input),
    activeBranches: metricValue(
      current.activeBranches,
      prior?.activeBranches,
      windows
    ),
    locPerDollar: metricValue(
      current.locPerDollar,
      prior?.locPerDollar,
      windows
    ),
    medianPrSize: metricValue(
      current.medianPrSize,
      prior?.medianPrSize,
      windows
    ),
    aiSpendUsd: metricValue(current.aiSpendUsd, prior?.aiSpendUsd, windows),
    mergeRatePct: metricValue(
      current.mergeRatePct,
      prior?.mergeRatePct,
      windows
    ),
  };
}

type WindowMetrics = {
  activeBranches: BranchMetricResult<number>;
  locPerDollar: BranchMetricResult<number>;
  medianPrSize: BranchMetricResult<number>;
  aiSpendUsd: BranchMetricResult<number>;
  mergeRatePct: BranchMetricResult<number>;
};

function calculateWindowMetrics(
  input: BranchListMetricInput,
  window: BranchMetricWindow,
  prior = false
): WindowMetrics {
  if (input.cohortCoverageComplete === false) {
    return {
      activeBranches: unavailable(),
      locPerDollar: unavailable(),
      medianPrSize: unavailable(),
      aiSpendUsd: unavailable(),
      mergeRatePct: unavailable(),
    };
  }
  return {
    activeBranches: calculateActiveBranches(input, prior),
    locPerDollar: calculateLocPerDollar(input, window),
    medianPrSize: calculateMedianPrSize(input, window),
    aiSpendUsd: calculateAiSpend(input, window),
    mergeRatePct: calculateMergeRate(input, window),
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
  prior: boolean
): BranchMetricResult<number> {
  if (input.cohortSize === 0) {
    return emptyCohortResult(input);
  }
  if (
    input.statusSnapshots.some((item) =>
      prior ? item.priorActive === null : item.currentActive === null
    )
  ) {
    return unavailable();
  }
  const value = input.statusSnapshots.filter((item) =>
    prior ? item.priorActive === true : item.currentActive
  ).length;
  return input.statusSnapshots.length === input.cohortSize
    ? complete(value)
    : partial(value, input.statusSnapshots.length, input.cohortSize);
}

function calculateLocPerDollar(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): BranchMetricResult<number> {
  if (input.cohortSize === 0) {
    return emptyCohortResult(input);
  }
  const locEvidence = reconcileByIdentity(
    input.locContributions,
    (contribution) =>
      `${contribution.sourceEventId}\u0000${contribution.branchId}`
  );
  const costEvidence = reconcileByIdentity(
    input.costContributions,
    (contribution) =>
      `${contribution.sourceEventId}\u0000${contribution.branchId}`
  );
  const locByBranch = sumLocByBranch(
    locEvidence.values.filter((contribution) =>
      locEvidenceFallsInWindow(contribution.occurredAt, window)
    )
  );
  const locWindowCoverageComplete = locEvidence.values.every((contribution) =>
    locEvidenceTimestampIsTrustworthy(contribution.occurredAt, window)
  );
  const costByBranch = sumCostByBranch(
    costEvidence.values.filter((contribution) =>
      evidenceFallsInWindow(contribution.occurredAt, window)
    )
  );
  const locComplete = new Set(input.locCompleteBranchIds);
  const costComplete = new Set(input.costCompleteBranchIds);
  const pairs = input.statusSnapshots.flatMap(({ branchId }) => {
    const loc = locByBranch.get(branchId);
    if (
      !(
        loc !== undefined &&
        locComplete.has(branchId) &&
        costComplete.has(branchId)
      )
    ) {
      return [];
    }
    return [{ loc, costUsd: costByBranch.get(branchId) ?? 0 }];
  });
  if (pairs.length === 0) {
    // A finite window with no qualifying event-time LOC cannot distinguish
    // zero work from missing history. Fail closed instead of reporting N/A.
    return window.startAt === null ? notApplicable() : unavailable();
  }
  const totalCost = pairs.reduce((sum, pair) => sum + pair.costUsd, 0);
  if (totalCost <= 0) {
    return notApplicable();
  }
  const totalLoc = pairs.reduce((sum, pair) => sum + pair.loc, 0);
  const value = totalLoc / totalCost;
  const completeCoverage =
    pairs.length === input.cohortSize &&
    !locEvidence.conflicted &&
    !costEvidence.conflicted &&
    locWindowCoverageComplete;
  return completeCoverage
    ? complete(value)
    : partial(
        value,
        pairs.length,
        input.cohortSize,
        BranchMetricDisclosure.LocIncomplete
      );
}

function calculateMedianPrSize(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): BranchMetricResult<number> {
  if (input.cohortSize === 0) {
    return emptyCohortResult(input);
  }
  const reconciled = reconcilePullRequests(input.pullRequests);
  const merged = reconciled.values.filter((pullRequest) =>
    isTimestampInBranchMetricWindow(pullRequest.mergedAt, window)
  );
  if (merged.length === 0) {
    return input.pullRequestCoverageComplete ? noData() : unavailable();
  }
  const knownSizes = merged.flatMap((pullRequest) => {
    if (
      !(
        isValidNonnegative(pullRequest.additions) &&
        isValidNonnegative(pullRequest.deletions)
      )
    ) {
      return [];
    }
    return [pullRequest.additions + pullRequest.deletions];
  });
  if (knownSizes.length === 0) {
    return unavailable();
  }
  knownSizes.sort((left, right) => left - right);
  const middle = Math.floor(knownSizes.length / 2);
  const value =
    knownSizes.length % 2 === 0
      ? (knownSizes[middle - 1] + knownSizes[middle]) / 2
      : knownSizes[middle];
  const completeCoverage =
    input.pullRequestCoverageComplete &&
    !reconciled.conflicted &&
    knownSizes.length === merged.length;
  return completeCoverage
    ? complete(value)
    : partial(value, knownSizes.length, merged.length);
}

function calculateAiSpend(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): BranchMetricResult<number> {
  if (input.cohortSize === 0) {
    return emptyCohortResult(input);
  }
  const reconciled = reconcileByIdentity(
    input.costContributions,
    (contribution) =>
      `${contribution.sourceEventId}\u0000${contribution.branchId}`
  );
  const contributions = reconciled.values.filter((contribution) =>
    evidenceFallsInWindow(contribution.occurredAt, window)
  );
  const windowCoverageComplete = reconciled.values.every((contribution) =>
    evidenceTimestampIsTrustworthy(contribution.occurredAt, window)
  );
  let total = 0;
  let included = 0;
  for (const contribution of contributions) {
    if (
      !(
        contribution.sourceEventId &&
        contribution.phase !== null &&
        isValidNonnegative(contribution.costUsd) &&
        isValidDivisor(contribution.qualifyingBranchCount)
      )
    ) {
      continue;
    }
    total += contribution.costUsd / contribution.qualifyingBranchCount;
    included += 1;
  }
  const completeCoverage =
    input.costCompleteBranchIds.length === input.cohortSize &&
    !reconciled.conflicted &&
    windowCoverageComplete &&
    included === contributions.length;
  if (included === 0) {
    return completeCoverage ? complete(0) : unavailable();
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

function calculateMergeRate(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): BranchMetricResult<number> {
  if (input.cohortSize === 0) {
    return emptyCohortResult(input);
  }
  const reconciled = reconcilePullRequests(input.pullRequests);
  const pullRequests = reconciled.values;
  const merged = pullRequests.filter((pullRequest) =>
    isTimestampInBranchMetricWindow(pullRequest.mergedAt, window)
  );
  const closedUnmerged = pullRequests.filter(
    (pullRequest) =>
      pullRequest.mergedAt === null &&
      !pullRequest.isDraft &&
      isTimestampInBranchMetricWindow(pullRequest.closedAt, window)
  );
  const decided = merged.length + closedUnmerged.length;
  if (decided === 0) {
    return input.pullRequestCoverageComplete && !reconciled.conflicted
      ? notApplicable()
      : unavailable();
  }
  const value = (merged.length / decided) * 100;
  return input.pullRequestCoverageComplete && !reconciled.conflicted
    ? complete(value)
    : partial(value);
}

function metricValue(
  current: BranchMetricResult<number>,
  prior: BranchMetricResult<number> | undefined,
  windows: AdjacentBranchMetricWindows
): BranchListMetricValue {
  if (!windows.prior || prior === undefined) {
    return { current };
  }
  if (windows.label === BranchMetricComparisonLabel.AllTime) {
    return { current };
  }
  return {
    current,
    comparison: buildBranchMetricComparison(
      windows.label,
      windows.prior,
      current,
      prior
    ),
  };
}

function reconcilePullRequests(
  pullRequests: readonly BranchMetricPullRequestEvidence[]
): ReconciledEvidence<BranchMetricPullRequestEvidence> {
  return reconcileByIdentity(
    pullRequests,
    (pullRequest) => pullRequest.identity
  );
}

type ReconciledEvidence<Value> = {
  values: Value[];
  conflicted: boolean;
};

function reconcileByIdentity<Value>(
  values: readonly Value[],
  keyFor: (value: Value) => string
): ReconciledEvidence<Value> {
  const deduped = new Map<string, Value>();
  const conflictedKeys = new Set<string>();
  let conflicted = false;
  for (const value of values) {
    const key = keyFor(value);
    if (!key) {
      conflicted = true;
      continue;
    }
    if (conflictedKeys.has(key)) {
      continue;
    }
    const existing = deduped.get(key);
    if (existing === undefined) {
      deduped.set(key, value);
      continue;
    }
    if (stableValue(existing) !== stableValue(value)) {
      conflicted = true;
      conflictedKeys.add(key);
      deduped.delete(key);
    }
  }
  return { values: [...deduped.values()], conflicted };
}

function stableValue(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

function sumLocByBranch(
  contributions: readonly BranchMetricLocContribution[]
): Map<string, number> {
  const values = new Map<string, number>();
  for (const contribution of contributions) {
    if (
      !(
        isValidNonnegative(contribution.additions) &&
        isValidNonnegative(contribution.deletions)
      )
    ) {
      continue;
    }
    values.set(
      contribution.branchId,
      (values.get(contribution.branchId) ?? 0) +
        contribution.additions +
        contribution.deletions
    );
  }
  return values;
}

function sumCostByBranch(
  contributions: readonly BranchMetricCostContribution[]
): Map<string, number> {
  const values = new Map<string, number>();
  for (const contribution of contributions) {
    if (
      !(
        isValidNonnegative(contribution.costUsd) &&
        isValidDivisor(contribution.qualifyingBranchCount) &&
        contribution.phase !== null
      )
    ) {
      continue;
    }
    values.set(
      contribution.branchId,
      (values.get(contribution.branchId) ?? 0) +
        contribution.costUsd / contribution.qualifyingBranchCount
    );
  }
  return values;
}

function evidenceFallsInWindow(
  occurredAt: string | null,
  window: BranchMetricWindow
): boolean {
  if (occurredAt === null) {
    return false;
  }
  return isTimestampInBranchMetricWindow(occurredAt, window);
}

function evidenceTimestampIsTrustworthy(
  occurredAt: string | null,
  window: BranchMetricWindow
): boolean {
  if (occurredAt === null) {
    return false;
  }
  const occurredAtMs = Date.parse(occurredAt);
  const endAtMs = Date.parse(window.endAt);
  return (
    !(Number.isNaN(occurredAtMs) || Number.isNaN(endAtMs)) &&
    occurredAtMs < endAtMs
  );
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

function locEvidenceTimestampIsTrustworthy(
  occurredAt: string | null,
  window: BranchMetricWindow
): boolean {
  if (occurredAt === null) {
    return window.startAt === null;
  }
  return evidenceTimestampIsTrustworthy(occurredAt, window);
}

function isValidNonnegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function isValidDivisor(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function complete<Value>(value: Value): BranchMetricResult<Value> {
  return { state: BranchMetricAvailability.Complete, value };
}

function partial<Value>(
  value: Value,
  included?: number,
  total?: number,
  disclosure: BranchMetricDisclosure = BranchMetricDisclosure.DefaultIncomplete
): BranchMetricResult<Value> {
  return {
    state: BranchMetricAvailability.Partial,
    value,
    ...(included === undefined || total === undefined
      ? {}
      : { coverage: { included, total } }),
    disclosure,
  };
}

function unavailable<Value>(): BranchMetricResult<Value> {
  return { state: BranchMetricAvailability.Unavailable, value: null };
}

function notApplicable<Value>(): BranchMetricResult<Value> {
  return { state: BranchMetricAvailability.NotApplicable, value: null };
}

function noData<Value>(): BranchMetricResult<Value> {
  return { state: BranchMetricAvailability.NoData, value: null };
}

/**
 * What an empty cohort means for every metric that short-circuits on it.
 *
 * No data only when the producer actually established the cohort is empty. When
 * it could not qualify the population at all
 * ({@link BranchListMetricInput.cohortCoverageComplete} false), the honest answer
 * is Unavailable — the metric is unknown, not zero.
 */
function emptyCohortResult<Value>(
  input: BranchListMetricInput
): BranchMetricResult<Value> {
  return input.cohortCoverageComplete === false ? unavailable() : noData();
}
