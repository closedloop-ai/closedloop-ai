import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  type BranchAssociatedPullRequestCollection,
  BranchAssociatedPullRequestCompletenessState,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  type BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchPhaseAttributionCompletenessReason as PhaseCompletenessReason,
} from "@repo/api/src/types/branch-phase-attribution";
import { projectBranchPhaseAttribution } from "@repo/lib/branches/branch-phase-attribution";
import { branchPhaseLifecycleFromAssociatedPullRequests } from "@repo/lib/branches/branch-phase-lifecycle";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { BranchLifecycleEventRow } from "../database/branch-reads.js";

type DesktopPhaseAttributionInput = {
  sessions: readonly BranchPageDetail["sessions"][number][];
  lifecycleEventsBySession: ReadonlyMap<
    string,
    readonly BranchLifecycleEventRow[]
  >;
  associatedPullRequests: BranchAssociatedPullRequestCollection;
  loadedSessions: readonly SyncedAgentSession[];
};

/** Project detail phase attribution from loaded session and PR evidence. */
export function buildDesktopPhaseAttribution(
  input: DesktopPhaseAttributionInput
): BranchPhaseAttributionResult {
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
    coverageReasons: desktopPhaseCoverageReasons(input),
  });
}

function desktopPhaseCoverageReasons(
  input: DesktopPhaseAttributionInput
): BranchPhaseAttributionCompletenessReason[] {
  const reasons = new Set<BranchPhaseAttributionCompletenessReason>();
  if (
    input.associatedPullRequests.completeness.state !==
    BranchAssociatedPullRequestCompletenessState.Complete
  ) {
    reasons.add(PhaseCompletenessReason.LifecycleIncomplete);
  }
  const loadedSessionIds = new Set(
    input.loadedSessions.map((session) => session.externalSessionId)
  );
  if (
    input.sessions.some(
      (session) =>
        !loadedSessionIds.has(session.sessionId) ||
        session.activitySegments === undefined ||
        session.activitySegments.length === 0
    )
  ) {
    reasons.add(PhaseCompletenessReason.MissingActivitySegments);
  }
  for (const session of input.loadedSessions) {
    if (session.activitySegmentRows?.some(isMalformedActivitySegmentRow)) {
      reasons.add(PhaseCompletenessReason.MalformedEvidence);
    }
    if (session.tokenEvents?.some(isMalformedActivitySpendEvent)) {
      reasons.add(PhaseCompletenessReason.PricingIncomplete);
    }
  }
  return [...reasons];
}

function isMalformedActivitySegmentRow(
  row: NonNullable<SyncedAgentSession["activitySegmentRows"]>[number]
): boolean {
  return !(
    Number.isFinite(row.startMs) &&
    Number.isFinite(row.endMs) &&
    row.endMs > row.startMs
  );
}

function isMalformedActivitySpendEvent(
  event: NonNullable<SyncedAgentSession["tokenEvents"]>[number]
): boolean {
  return !(
    Number.isFinite(Date.parse(event.createdAt)) &&
    (event.estimatedCostUsd === null ||
      event.estimatedCostUsd === undefined ||
      (Number.isFinite(event.estimatedCostUsd) &&
        event.estimatedCostUsd >= 0)) &&
    event.inputTokens >= 0 &&
    event.outputTokens >= 0 &&
    event.cacheReadTokens >= 0 &&
    event.cacheWriteTokens >= 0
  );
}
