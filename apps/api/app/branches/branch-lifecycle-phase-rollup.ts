import type {
  BranchLifecyclePhaseCostRollup,
  BranchPageDetail,
} from "@repo/api/src/types/branch";
import {
  type BranchAssociatedPullRequestCollection,
  BranchAssociatedPullRequestCompletenessState,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  type BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchPhaseAttributionCompletenessReason as CompletenessReason,
} from "@repo/api/src/types/branch-phase-attribution";
import {
  type BranchPhaseLifecycleEvent,
  projectBranchPhaseAttribution,
} from "@repo/lib/branches/branch-phase-attribution";
import { branchPhaseLifecycleFromAssociatedPullRequests } from "@repo/lib/branches/branch-phase-lifecycle";

/** Thin cloud adapter over the shared Branch phase-attribution policy. */
export function buildBranchPhaseAttribution(input: {
  sessions: readonly BranchPageDetail["sessions"][number][];
  lifecycleEventsBySession: ReadonlyMap<
    string,
    readonly BranchPhaseLifecycleEvent[]
  >;
  associatedPullRequests?: BranchAssociatedPullRequestCollection;
  coverageReasons?: readonly BranchPhaseAttributionCompletenessReason[];
}): BranchPhaseAttributionResult {
  const coverageReasons = [...(input.coverageReasons ?? [])];
  if (
    !input.associatedPullRequests ||
    input.associatedPullRequests.completeness.state !==
      BranchAssociatedPullRequestCompletenessState.Complete
  ) {
    coverageReasons.push(CompletenessReason.LifecycleIncomplete);
  }
  return projectBranchPhaseAttribution({
    sessions: input.sessions.map((session) => ({
      sessionId: session.sessionId,
      participation: session.participation,
      branchCount: session.branchCount,
      estimatedCostUsd: session.estimatedCostUsd,
      activitySegments: session.activitySegments,
      lifecycleEvents: input.lifecycleEventsBySession.get(session.sessionId),
    })),
    ...branchPhaseLifecycleFromAssociatedPullRequests(
      input.associatedPullRequests
    ),
    coverageReasons,
  });
}

/** Keep the legacy stack field as a visible-only projection of the new owner. */
export function lifecycleStacksFromPhaseAttribution(
  result: BranchPhaseAttributionResult
): BranchLifecyclePhaseCostRollup[] {
  return result.rollups.map((rollup) => ({
    phase: rollup.phase,
    estimatedCostUsd: rollup.estimatedCostUsd,
    inputTokens: rollup.inputTokens,
    outputTokens: rollup.outputTokens,
    cacheReadTokens: rollup.cacheReadTokens,
    cacheWriteTokens: rollup.cacheWriteTokens,
    sessionCount: rollup.sessionCount,
  }));
}
