import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import type {
  BranchAssociatedPullRequest,
  BranchAssociatedPullRequestCollection,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  type BranchDetailMetricBundle,
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricPullRequestOutcome,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import { BRANCH_PUSH_METHODS } from "@repo/api/src/types/session-artifact-link";
import type { BranchPhaseLifecycleEvent } from "./branch-phase-attribution";

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

export type BranchDetailMetricInput = {
  selectedPrAdditions: number | null;
  selectedPrDeletions: number | null;
  selectedPrLocComplete: boolean;
  phaseAttribution: BranchPhaseAttributionResult;
  selectedCycle: BranchMetricSelectedCycle | null;
};

/** Normalize the selected persisted PR cycle without consulting live GitHub. */
export function branchMetricCycleFromPullRequest(
  pullRequest: BranchAssociatedPullRequest | null,
  successfulPushAt: string | null
): BranchMetricSelectedCycle | null {
  if (pullRequest === null) {
    return null;
  }
  const outcome = pullRequest.mergedAt
    ? BranchMetricPullRequestOutcome.Merged
    : outcomeWithoutMerge(pullRequest);
  const terminalAt = pullRequest.mergedAt ?? pullRequest.closedAt;
  return {
    cycleId: pullRequest.id,
    openedAt: pullRequest.openedAt,
    terminalAt,
    outcome,
    successfulPushes: successfulPushAt
      ? [
          {
            cycleId: pullRequest.id,
            occurredAt: successfulPushAt,
          },
        ]
      : [],
  };
}

/**
 * Resolve the earliest persisted successful push in the selected PR's sequential
 * cycle. This consumes existing provider-neutral lifecycle evidence only; it
 * never fetches or refreshes GitHub data.
 */
export function selectedCycleSuccessfulPushAt(
  collection: BranchAssociatedPullRequestCollection | undefined,
  lifecycleEvents: readonly BranchPhaseLifecycleEvent[],
  firstBranchPushAt: string | null = null
): string | null {
  const pullRequests = collection?.items ?? [];
  const selected = pullRequests.find(
    (pullRequest) => pullRequest.id === collection?.selectedId
  );
  if (!selected) {
    return null;
  }
  const terminalMs = parseTimestamp(selected.mergedAt ?? selected.closedAt);
  if (terminalMs === null) {
    return null;
  }
  const openedMs = parseTimestamp(selected.openedAt);
  const priorTerminalMs = Math.max(
    ...pullRequests.flatMap((pullRequest) => {
      if (pullRequest.id === selected.id) {
        return [];
      }
      const candidate = parseTimestamp(
        pullRequest.mergedAt ?? pullRequest.closedAt
      );
      const beforeSelected =
        candidate !== null &&
        candidate < terminalMs &&
        (openedMs === null || candidate <= openedMs);
      return beforeSelected ? [candidate] : [];
    }),
    Number.NEGATIVE_INFINITY
  );
  const candidates = lifecycleEvents.flatMap((event) => {
    if (
      event.kind !== BranchLifecycleBoundaryKind.BranchWrite ||
      !event.method ||
      !BRANCH_PUSH_METHODS.has(event.method)
    ) {
      return [];
    }
    const occurredAt = event.observedAt;
    if (!occurredAt) {
      return [];
    }
    const occurredAtMs = parseTimestamp(occurredAt);
    return occurredAtMs !== null &&
      occurredAtMs > priorTerminalMs &&
      occurredAtMs <= terminalMs
      ? [{ occurredAt, occurredAtMs }]
      : [];
  });
  const fallbackMs = parseTimestamp(firstBranchPushAt);
  if (
    priorTerminalMs === Number.NEGATIVE_INFINITY &&
    firstBranchPushAt &&
    fallbackMs !== null &&
    fallbackMs <= terminalMs
  ) {
    candidates.push({
      occurredAt: firstBranchPushAt,
      occurredAtMs: fallbackMs,
    });
  }
  candidates.sort((left, right) => left.occurredAtMs - right.occurredAtMs);
  return candidates[0]?.occurredAt ?? null;
}

/** Calculate lifetime selected-Branch metrics and latest-cycle outcomes. */
export function calculateBranchDetailMetrics(
  input: BranchDetailMetricInput
): BranchDetailMetricBundle {
  const costs = phaseCosts(input.phaseAttribution);
  const outcome = calculateOutcome(input.selectedCycle);
  return {
    locPerDollar: calculateDetailLocPerDollar(input, costs.total),
    phaseCostUsd: costs.byPhase,
    totalCostUsd: costs.total,
    leadTimeMs: outcome.leadTimeMs,
    abandonmentTimeMs: outcome.abandonmentTimeMs,
    idleTimeMs: calculateIdle(
      input.phaseAttribution,
      outcome.span,
      outcome.idleApplicable
    ),
  };
}

type PhaseCosts = {
  byPhase: BranchDetailMetricBundle["phaseCostUsd"];
  total: BranchMetricResult<number>;
};

function phaseCosts(attribution: BranchPhaseAttributionResult): PhaseCosts {
  const values = {
    [BranchVisibleLifecyclePhase.Build]: 0,
    [BranchVisibleLifecyclePhase.Review]: 0,
    [BranchVisibleLifecyclePhase.Rework]: 0,
  };
  for (const rollup of attribution.rollups) {
    if (!isValidNonnegative(rollup.estimatedCostUsd)) {
      return unavailablePhaseCosts();
    }
    values[rollup.phase] += rollup.estimatedCostUsd;
  }
  if (
    attribution.coverage.completeness ===
    BranchPhaseAttributionCompleteness.Unavailable
  ) {
    return {
      byPhase: {
        [BranchVisibleLifecyclePhase.Build]: unavailable(),
        [BranchVisibleLifecyclePhase.Review]: unavailable(),
        [BranchVisibleLifecyclePhase.Rework]: unavailable(),
      },
      total: unavailable(),
    };
  }
  const resultFor = (value: number): BranchMetricResult<number> =>
    attribution.coverage.completeness ===
    BranchPhaseAttributionCompleteness.Partial
      ? partial(
          value,
          undefined,
          undefined,
          BranchMetricDisclosure.CostIncomplete
        )
      : complete(value);
  return {
    byPhase: {
      [BranchVisibleLifecyclePhase.Build]: resultFor(
        values[BranchVisibleLifecyclePhase.Build]
      ),
      [BranchVisibleLifecyclePhase.Review]: resultFor(
        values[BranchVisibleLifecyclePhase.Review]
      ),
      [BranchVisibleLifecyclePhase.Rework]: resultFor(
        values[BranchVisibleLifecyclePhase.Rework]
      ),
    },
    total: resultFor(
      values[BranchVisibleLifecyclePhase.Build] +
        values[BranchVisibleLifecyclePhase.Review] +
        values[BranchVisibleLifecyclePhase.Rework]
    ),
  };
}

function calculateDetailLocPerDollar(
  input: BranchDetailMetricInput,
  totalCost: BranchMetricResult<number>
): BranchMetricResult<number> {
  if (
    !(
      isValidNonnegative(input.selectedPrAdditions) &&
      isValidNonnegative(input.selectedPrDeletions)
    )
  ) {
    return unavailable();
  }
  if (totalCost.state === BranchMetricAvailability.Unavailable) {
    return unavailable();
  }
  if (totalCost.state === BranchMetricAvailability.NotApplicable) {
    return notApplicable();
  }
  if (totalCost.state === BranchMetricAvailability.NoData) {
    return noData();
  }
  if (totalCost.value === null) {
    return unavailable();
  }
  if (
    totalCost.state === BranchMetricAvailability.Partial &&
    totalCost.value === 0
  ) {
    return unavailable();
  }
  if (totalCost.value <= 0) {
    return notApplicable();
  }
  const value =
    (input.selectedPrAdditions + input.selectedPrDeletions) / totalCost.value;
  if (
    !input.selectedPrLocComplete ||
    totalCost.state === BranchMetricAvailability.Partial
  ) {
    const coverage =
      totalCost.state === BranchMetricAvailability.Partial
        ? totalCost.coverage
        : { included: 1, total: 2 };
    const disclosure = input.selectedPrLocComplete
      ? BranchMetricDisclosure.CostIncomplete
      : BranchMetricDisclosure.DefaultIncomplete;
    return partial(value, coverage?.included, coverage?.total, disclosure);
  }
  return complete(value);
}

type OutcomeSpan = {
  startMs: number;
  endMs: number;
};

type OutcomeMetrics = {
  leadTimeMs: BranchMetricResult<number>;
  abandonmentTimeMs: BranchMetricResult<number>;
  span: OutcomeSpan | null;
  idleApplicable: boolean;
};

function calculateOutcome(
  cycle: BranchMetricSelectedCycle | null
): OutcomeMetrics {
  if (cycle === null) {
    return {
      leadTimeMs: unavailable(),
      abandonmentTimeMs: unavailable(),
      span: null,
      idleApplicable: false,
    };
  }
  if (
    cycle.outcome === BranchMetricPullRequestOutcome.Open ||
    cycle.outcome === BranchMetricPullRequestOutcome.Draft
  ) {
    return {
      leadTimeMs: notApplicable(),
      abandonmentTimeMs: notApplicable(),
      span: null,
      idleApplicable: false,
    };
  }
  const terminalAtMs = parseTimestamp(cycle.terminalAt);
  if (terminalAtMs === null) {
    return unavailableOutcome(cycle.outcome);
  }
  const anchors = cycle.successfulPushes
    .filter((push) => push.cycleId === cycle.cycleId)
    .flatMap((push) => {
      const timestamp = parseTimestamp(push.occurredAt);
      return timestamp === null || timestamp > terminalAtMs ? [] : [timestamp];
    });
  const startMs = Math.min(...anchors);
  if (!Number.isFinite(startMs) || terminalAtMs < startMs) {
    return unavailableOutcome(cycle.outcome);
  }
  const value = complete(terminalAtMs - startMs);
  return cycle.outcome === BranchMetricPullRequestOutcome.Merged
    ? {
        leadTimeMs: value,
        abandonmentTimeMs: notApplicable(),
        span: { startMs, endMs: terminalAtMs },
        idleApplicable: true,
      }
    : {
        leadTimeMs: notApplicable(),
        abandonmentTimeMs: value,
        span: { startMs, endMs: terminalAtMs },
        idleApplicable: true,
      };
}

function outcomeWithoutMerge(
  pullRequest: BranchAssociatedPullRequest
): BranchMetricPullRequestOutcome {
  if (pullRequest.state === GitHubPRState.Closed) {
    return BranchMetricPullRequestOutcome.ClosedUnmerged;
  }
  return pullRequest.isDraft
    ? BranchMetricPullRequestOutcome.Draft
    : BranchMetricPullRequestOutcome.Open;
}

function calculateIdle(
  attribution: BranchPhaseAttributionResult,
  span: OutcomeSpan | null,
  applicable: boolean
): BranchMetricResult<number> {
  if (span === null) {
    return applicable ? unavailable() : notApplicable();
  }
  if (
    attribution.coverage.completeness ===
    BranchPhaseAttributionCompleteness.Unavailable
  ) {
    return unavailable();
  }
  if (
    attribution.coverage.completeness ===
      BranchPhaseAttributionCompleteness.Partial &&
    attribution.coverage.reason !==
      BranchPhaseAttributionCompletenessReason.PricingIncomplete
  ) {
    return unavailable();
  }
  if (
    attribution.segments.some(
      (segment) =>
        !(Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs)) ||
        segment.endMs < segment.startMs
    )
  ) {
    return unavailable();
  }
  const intervals = attribution.segments
    .map((segment) => ({
      startMs: Math.max(span.startMs, segment.startMs),
      endMs: Math.min(span.endMs, segment.endMs),
    }))
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((left, right) => left.startMs - right.startMs);
  const activeMs = unionDuration(intervals);
  const idleMs = Math.max(0, span.endMs - span.startMs - activeMs);
  return complete(idleMs);
}

function unionDuration(intervals: readonly OutcomeSpan[]): number {
  let total = 0;
  let current: OutcomeSpan | null = null;
  for (const interval of intervals) {
    if (current === null) {
      current = { ...interval };
      continue;
    }
    if (interval.startMs <= current.endMs) {
      current.endMs = Math.max(current.endMs, interval.endMs);
      continue;
    }
    total += current.endMs - current.startMs;
    current = { ...interval };
  }
  return current === null ? total : total + current.endMs - current.startMs;
}

function unavailableOutcome(
  outcome: BranchMetricPullRequestOutcome
): OutcomeMetrics {
  const merged = outcome === BranchMetricPullRequestOutcome.Merged;
  return {
    leadTimeMs: merged ? unavailable() : notApplicable(),
    abandonmentTimeMs: merged ? notApplicable() : unavailable(),
    span: null,
    idleApplicable: true,
  };
}

function unavailablePhaseCosts(): PhaseCosts {
  return {
    byPhase: {
      [BranchVisibleLifecyclePhase.Build]: unavailable(),
      [BranchVisibleLifecyclePhase.Review]: unavailable(),
      [BranchVisibleLifecyclePhase.Rework]: unavailable(),
    },
    total: unavailable(),
  };
}

function isValidNonnegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
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
