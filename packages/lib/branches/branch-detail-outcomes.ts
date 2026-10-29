import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import type {
  BranchAssociatedPullRequest,
  BranchAssociatedPullRequestCollection,
} from "@repo/api/src/types/branch-associated-pull-request";
import { isUnobservedPullRequest } from "@repo/api/src/types/branch-associated-pull-request";
import {
  type BranchDetailMetricBundle,
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricPullRequestOutcome,
  type BranchMetricResult,
  type BranchMetricSelectedCycle,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import { BRANCH_PUSH_METHODS } from "@repo/api/src/types/session-artifact-link";
import { locPerDollarFromPopulation } from "@repo/api/src/utils/loc-per-dollar";
import {
  type ResolvedPhaseTotal,
  resolveDetailPhaseTotal,
} from "./branch-detail-cost-reconciliation";
import {
  type BranchPenseroPointsInput,
  calculateDetailPenseroPointsPerDollar,
} from "./branch-detail-pensero-points";
import type { BranchPhaseLifecycleEvent } from "./branch-phase-attribution";
import {
  type BranchMetricLocContribution,
  BranchPublicationLocSource,
  reconcileBranchPublicationLoc,
  sumBranchPublicationLoc,
} from "./branch-publication-loc";

export type { BranchMetricSelectedCycle } from "@repo/api/src/types/branch-metrics";

export type BranchDetailMetricInput = {
  selectedPrAdditions: number | null;
  selectedPrDeletions: number | null;
  selectedPrLocComplete: boolean;
  /** Canonical lifetime publication LOC; selected PR does not scope this set. */
  lifetimeLocContributions?: readonly BranchMetricLocContribution[];
  lifetimeLocCoverageComplete?: boolean;
  /** Distinct qualifying Branch-attributed Sessions before cost availability. */
  qualifyingSessionCount?: number;
  /**
   * ISS-6949 — the branch's canonical attributed cost from the SAME payload
   * (`resolveAttributedBranchCost`), which is the figure the Sessions & timeline
   * tab takes as authoritative. Required, not optional: an optional field lets a
   * new producer silently reintroduce the phase-rollup residue as the branch
   * total, which is the defect this exists to close. `null` means the payload
   * carries no attributed cost.
   */
  attributedCostUsd: number | null;
  phaseAttribution: BranchPhaseAttributionResult;
  selectedCycle: BranchMetricSelectedCycle | null;
  /** ISS-9814 — see {@link BranchPenseroPointsInput} for the state contract. */
  penseroPoints?: BranchPenseroPointsInput | null;
};

/** Normalize the selected persisted PR cycle without consulting live GitHub. */
export function branchMetricCycleFromPullRequest(
  pullRequest: BranchAssociatedPullRequest | null,
  successfulPushAt: string | null
): BranchMetricSelectedCycle | null {
  // ISS-8422: an unobserved pull request has no cycle, and the fallthrough was
  // not merely a null-shaped one. `outcomeWithoutMerge` reads the placeholder
  // OPEN its column default produced beside a falsy `isDraft` and answers
  // `Open`; `calculateOutcome` takes the Open/Draft early return and hands back
  // `notApplicable()` for leadTimeMs and abandonmentTimeMs; `metricPresentation`
  // renders that as "N/A" plus "Not applicable to the selected pull request's
  // latest cycle". So Cycle Time and Abandonment Duration each printed a
  // POSITIVE claim that the cycle is open, about a pull request nobody looked
  // at, on both surfaces. `branchPullRequestCycleAbsence` cannot rescue it
  // either: `selectedId` is set, so it returns null. Returning null here reaches
  // `calculateOutcome(null)` and its `unavailable()` instead — "Unavailable /
  // Evidence is unavailable", which is the same ruling the phase-lifecycle guard
  // in `branch-phase-lifecycle.ts` already applies to the rollup.
  if (pullRequest === null || isUnobservedPullRequest(pullRequest)) {
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
  const costs = phaseCosts(input.phaseAttribution, input.attributedCostUsd);
  // ISS-9732: ONE denominator for LOC/$ everywhere — the attributed cost the
  // Sessions listing shows. The phase breakdown reads that same figure as its
  // total and sums its per-phase rows separately; neither may decide whether
  // the ratio can be computed. The Pensero companion takes the SAME
  // denominator (ISS-9814 AC4), so the two ratios describe one population.
  const denominator = locPerDollarDenominator(input.attributedCostUsd);
  const penseroPointsPerDollar = calculateDetailPenseroPointsPerDollar(
    input.penseroPoints,
    denominator
  );
  return {
    locPerDollar: calculateDetailLocPerDollar(input, denominator),
    // OMITTED, not set to `undefined`: a branch with no Pensero numerator must
    // produce the same object a producer predating the field produced, key set
    // included. `JSON.stringify` would hide the difference on the wire, but a
    // structural comparison in a test or a `hasOwn` check in a consumer would
    // not, and "absent" is the state the whole AC2 fallback keys on.
    ...(penseroPointsPerDollar ? { penseroPointsPerDollar } : {}),
    phaseCostUsd: costs.byPhase,
    totalCostUsd: costs.total,
    ...calculateBranchSelectedCycleMetrics(
      input.phaseAttribution,
      input.selectedCycle
    ),
  };
}

type PhaseCosts = {
  byPhase: BranchDetailMetricBundle["phaseCostUsd"];
  total: BranchMetricResult<number>;
};

function phaseCosts(
  attribution: BranchPhaseAttributionResult,
  attributedCostUsd: number | null
): PhaseCosts {
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
  const rollupTotalUsd =
    values[BranchVisibleLifecyclePhase.Build] +
    values[BranchVisibleLifecyclePhase.Review] +
    values[BranchVisibleLifecyclePhase.Rework];
  // Each operand was checked, but the accumulation can still overflow to
  // Infinity, which would make the display-precision comparison NaN and never
  // reconcile instead of declining.
  if (
    !isValidNonnegative(rollupTotalUsd) ||
    attribution.coverage.completeness ===
      BranchPhaseAttributionCompleteness.Unavailable
  ) {
    return unavailablePhaseCosts();
  }
  const resolved = resolveDetailPhaseTotal(
    attribution,
    attributedCostUsd,
    rollupTotalUsd
  );
  return resolved === null
    ? unavailablePhaseCosts()
    : buildPhaseCosts(values, resolved);
}

/**
 * The one LOC/$ denominator: attributed cost, straight from the same field the
 * Sessions listing renders. `null` is Unavailable and NOT NoData — ISS-6949
 * settled that a branch whose attributed cost could not be established has no
 * presentable total, so the ratio declines rather than claiming there was
 * nothing to divide by. A `0` is a priced zero, which
 * {@link calculateDetailLocPerDollar} answers NotApplicable.
 *
 * Phase attribution is deliberately absent: `phaseCosts` reads this same figure
 * as the breakdown's total and sums its per-phase rows independently, and
 * neither of those answers may decide whether the ratio can be computed.
 */
function locPerDollarDenominator(
  attributedCostUsd: number | null
): BranchMetricResult<number> {
  if (!isValidNonnegative(attributedCostUsd)) {
    return unavailable();
  }
  return complete(attributedCostUsd);
}

function calculateDetailLocPerDollar(
  input: BranchDetailMetricInput,
  totalCost: BranchMetricResult<number>
): BranchMetricResult<number> {
  // ISS-9732: the denominator answers FIRST, so no phase-attribution state can
  // reach the ratio. The zero-qualifying-Session arm below used to read
  // `phaseAttribution.coverage` — which is how attribution still decided LOC/$
  // on a branch with no qualifying Sessions, in both cloud and desktop.
  if (
    totalCost.state === BranchMetricAvailability.Unavailable ||
    totalCost.value === null
  ) {
    return unavailable();
  }
  const qualifyingSessionCount = input.qualifyingSessionCount ?? 1;
  if (qualifyingSessionCount === 0) {
    return noData();
  }
  const loc = resolveDetailPublicationLoc(input);
  if (loc === null) {
    return unavailable();
  }
  if (totalCost.value <= 0) {
    return notApplicable();
  }
  const value = locPerDollarFromPopulation({
    lines: loc.total,
    cost: totalCost.value,
    coverageComplete: true,
  });
  if (value === null) {
    return unavailable();
  }
  // ISS-9732: `locPerDollarDenominator` returns only Unavailable or a Complete
  // number, so the denominator can no longer arrive Partial and LOC coverage is
  // the sole remaining source of incompleteness here.
  if (!loc.coverageComplete) {
    return partial(value, 1, 2, BranchMetricDisclosure.LocIncomplete);
  }
  return complete(value);
}

function resolveDetailPublicationLoc(
  input: BranchDetailMetricInput
): { total: number; coverageComplete: boolean } | null {
  const locEvidence = reconcileBranchPublicationLoc(
    input.lifetimeLocContributions ?? legacySelectedPrLoc(input)
  );
  const legacyCoverageComplete =
    input.selectedPrLocComplete &&
    isValidNonnegative(input.selectedPrAdditions) &&
    isValidNonnegative(input.selectedPrDeletions);
  const coverageComplete =
    (input.lifetimeLocCoverageComplete ?? legacyCoverageComplete) &&
    !locEvidence.conflicted &&
    !locEvidence.malformed &&
    locEvidence.values.every(
      (item) => parseTimestamp(item.occurredAt) !== null
    );
  if (locEvidence.values.length === 0 && !coverageComplete) {
    return null;
  }
  return {
    total: sumBranchPublicationLoc(locEvidence.values),
    coverageComplete,
  };
}

function legacySelectedPrLoc(
  input: BranchDetailMetricInput
): BranchMetricLocContribution[] {
  if (
    !(
      isValidNonnegative(input.selectedPrAdditions) &&
      isValidNonnegative(input.selectedPrDeletions)
    )
  ) {
    return [];
  }
  return [
    {
      sourceEventId: "legacy-selected-pr",
      changeIdentity: "legacy-selected-pr",
      branchId: "legacy-selected-branch",
      occurredAt: "1970-01-01T00:00:00.000Z",
      additions: input.selectedPrAdditions,
      deletions: input.selectedPrDeletions,
      source: BranchPublicationLocSource.MergedPullRequest,
    },
  ];
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

function buildPhaseCosts(
  values: Record<BranchVisibleLifecyclePhase, number>,
  resolved: ResolvedPhaseTotal
): PhaseCosts {
  const rowDisclosure = rowShortfallDisclosure(resolved);
  return {
    byPhase: {
      [BranchVisibleLifecyclePhase.Build]: costResult(
        values[BranchVisibleLifecyclePhase.Build],
        resolved.rowsComplete,
        rowDisclosure
      ),
      [BranchVisibleLifecyclePhase.Review]: costResult(
        values[BranchVisibleLifecyclePhase.Review],
        resolved.rowsComplete,
        rowDisclosure
      ),
      [BranchVisibleLifecyclePhase.Rework]: costResult(
        values[BranchVisibleLifecyclePhase.Rework],
        resolved.rowsComplete,
        rowDisclosure
      ),
    },
    total: costResult(
      resolved.totalUsd,
      resolved.totalComplete,
      BranchMetricDisclosure.CostIncomplete
    ),
  };
}

/**
 * `CostIncomplete` asserts that activity with unavailable cost was excluded, so
 * it may only be attached where cost evidence really is short. Rows whose
 * evidence is whole and merely disagrees with the canonical total exclude no
 * unpriced activity, and take the cause-neutral sentence instead — a selection
 * between two approved sentences, never a new one (tamsinb review, PR #7912).
 *
 * The total's only failing arm is an incomplete-coverage settled zero, which is
 * always the evidence shortfall, so it does not go through here.
 */
function rowShortfallDisclosure(
  resolved: ResolvedPhaseTotal
): BranchMetricDisclosure {
  return resolved.rowEvidenceComplete
    ? BranchMetricDisclosure.DefaultIncomplete
    : BranchMetricDisclosure.CostIncomplete;
}

function costResult(
  value: number,
  isComplete: boolean,
  disclosure: BranchMetricDisclosure
): BranchMetricResult<number> {
  return isComplete
    ? complete(value)
    : partial(value, undefined, undefined, disclosure);
}

/** Derive selected-cycle outcomes against the branch evidence actually rendered. */
export function calculateBranchSelectedCycleMetrics(
  attribution: BranchPhaseAttributionResult | undefined,
  cycle: BranchMetricSelectedCycle | null
): Pick<
  BranchDetailMetricBundle,
  "leadTimeMs" | "abandonmentTimeMs" | "idleTimeMs"
> {
  const outcome = calculateOutcome(cycle);
  return {
    leadTimeMs: outcome.leadTimeMs,
    abandonmentTimeMs: outcome.abandonmentTimeMs,
    idleTimeMs: attribution
      ? calculateIdle(attribution, outcome.span, outcome.idleApplicable)
      : unavailable(),
  };
}
