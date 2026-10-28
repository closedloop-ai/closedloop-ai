import type {
  BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";

/**
 * ISS-6949 — shared Branch phase-attribution test fixtures for the detail-metric
 * suites, which each grew their own segment builder.
 *
 * The segment builder carries `qualifyingBranchCount` and `costEvents` because
 * `hasCompleteBranchMetricEventCost` returns false without them: a fixture that
 * means "this branch's cost accounting is complete" cannot say so otherwise, and
 * would silently assert a state production never reaches.
 */

type PhaseAttributionSegment = BranchPhaseAttributionResult["segments"][number];

/** Sum of the rollup costs — what the Cost breakdown rows add up to. */
export function rollupTotalUsd(
  attribution: BranchPhaseAttributionResult
): number {
  return attribution.rollups.reduce(
    (total, rollup) => total + rollup.estimatedCostUsd,
    0
  );
}

/**
 * A segment whose identified cost events exactly reconcile with its allocated
 * cost, so `hasCompleteBranchMetricEventCost` holds. Pass `costEvents: []` via
 * {@link unreconciledPhaseAttributionSegment} for the opposite.
 */
export function phaseAttributionSegment(input: {
  sessionId: string;
  phase: BranchVisibleLifecyclePhase;
  startMs: number;
  endMs: number;
  estimatedCostUsd: number;
  qualifyingBranchCount?: number;
}): PhaseAttributionSegment {
  const divisor = input.qualifyingBranchCount ?? 1;
  return {
    sessionId: input.sessionId,
    sequence: 0,
    phase: input.phase,
    startMs: input.startMs,
    endMs: input.endMs,
    estimatedCostUsd: input.estimatedCostUsd,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    evidenceIds: [],
    qualifyingBranchCount: divisor,
    costEvents: [
      {
        sourceEventId: `${input.sessionId}-${input.phase}-${input.startMs}`,
        occurredAtMs: input.startMs,
        costUsd: input.estimatedCostUsd * divisor,
      },
    ],
  };
}

/** Same shape, but with no identified cost events to reconcile against. */
export function unreconciledPhaseAttributionSegment(
  input: Parameters<typeof phaseAttributionSegment>[0]
): PhaseAttributionSegment {
  const { costEvents: _dropped, ...rest } = phaseAttributionSegment(input);
  return rest;
}

/**
 * A segment with no `qualifyingBranchCount`, which is the OTHER way
 * `hasCompleteBranchMetricEventCost` fails — its divisor guard, distinct from
 * the empty-events arm {@link unreconciledPhaseAttributionSegment} exercises.
 */
export function divisorlessPhaseAttributionSegment(
  input: Parameters<typeof phaseAttributionSegment>[0]
): PhaseAttributionSegment {
  const { qualifyingBranchCount: _dropped, ...rest } =
    phaseAttributionSegment(input);
  return rest;
}
