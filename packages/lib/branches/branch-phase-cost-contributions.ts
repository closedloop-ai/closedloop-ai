import type { BranchPhaseAttributionResult } from "@repo/api/src/types/branch-phase-attribution";
import { usdToMicroCents } from "./activity-attribution";
import type { BranchMetricCostContribution } from "./branch-list-metrics";

/** Normalize phase-attribution event evidence for the shared metric kernel. */
export function branchMetricCostContributions(
  phaseByBranch: ReadonlyMap<string, BranchPhaseAttributionResult>
): BranchMetricCostContribution[] {
  return [...phaseByBranch].flatMap(([branchId, attribution]) =>
    attribution.segments.flatMap((segment) =>
      (segment.costEvents ?? []).map((event) => ({
        sourceEventId: event.sourceEventId,
        branchId,
        sessionId: segment.sessionId,
        occurredAt: new Date(event.occurredAtMs).toISOString(),
        costUsd: event.costUsd,
        qualifyingBranchCount: segment.qualifyingBranchCount ?? null,
      }))
    )
  );
}

/** Prove identified event cost exactly reconciles with allocated phase cost. */
export function hasCompleteBranchMetricEventCost(
  attribution: BranchPhaseAttributionResult
): boolean {
  const segmentsBySession = new Map<
    string,
    BranchPhaseAttributionResult["segments"][number][]
  >();
  for (const segment of attribution.segments) {
    const segments = segmentsBySession.get(segment.sessionId) ?? [];
    segments.push(segment);
    segmentsBySession.set(segment.sessionId, segments);
  }
  return [...segmentsBySession.values()].every(sessionEventCostReconciles);
}

function sessionEventCostReconciles(
  segments: BranchPhaseAttributionResult["segments"][number][]
): boolean {
  const divisor = segments[0]?.qualifyingBranchCount;
  if (!(Number.isSafeInteger(divisor) && divisor && divisor > 0)) {
    return false;
  }
  if (segments.some((segment) => segment.qualifyingBranchCount !== divisor)) {
    return false;
  }
  const events = new Map<
    string,
    { occurredAtMs: number; costMicroCents: number }
  >();
  for (const segment of segments) {
    for (const event of segment.costEvents ?? []) {
      const normalized = {
        occurredAtMs: event.occurredAtMs,
        costMicroCents: usdToMicroCents(event.costUsd),
      };
      const existing = events.get(event.sourceEventId);
      if (
        existing &&
        (existing.occurredAtMs !== normalized.occurredAtMs ||
          existing.costMicroCents !== normalized.costMicroCents)
      ) {
        return false;
      }
      events.set(event.sourceEventId, normalized);
    }
  }
  const identifiedMicroCents = Math.round(
    [...events.values()].reduce(
      (total, event) => total + event.costMicroCents,
      0
    ) / divisor
  );
  const allocatedMicroCents = segments.reduce(
    (total, segment) => total + usdToMicroCents(segment.estimatedCostUsd),
    0
  );
  return identifiedMicroCents === allocatedMicroCents;
}
