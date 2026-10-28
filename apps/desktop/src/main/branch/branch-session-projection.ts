import type {
  BranchLifecyclePhaseSegment,
  BranchSession,
} from "@repo/api/src/types/branch";
import {
  type ActivitySegmentSpan,
  type ActivitySpendEvent,
  attributeBranchSessionActivity,
} from "@repo/lib/branches/activity-attribution";
import { DESKTOP_LOCAL_SESSION_AUTHOR_LABEL } from "../../shared/shared-agent-sessions-contract.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { BranchSessionTokenRow } from "../database/branch-reads.js";
import { priceSyncedBranchSession } from "./branch-session-pricing.js";

/** Project one hydrated local session into canonical Branch detail usage. */
export function toEnrichedBranchSession(
  session: SyncedAgentSession,
  isPrimary: boolean,
  branchCount: number,
  phaseSegments: readonly BranchLifecyclePhaseSegment[] | undefined,
  tokenRow: BranchSessionTokenRow | undefined
): BranchSession {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const usage of session.tokenUsageByModel) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
  }
  const activitySegments = buildBranchActivitySegments(session);
  return {
    sessionId: session.externalSessionId,
    slug: null,
    name: session.name ?? null,
    harness: session.harness ?? "",
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    isPrimary,
    branchCount,
    estimatedCostUsd: priceSyncedBranchSession(session),
    ...(tokenRow ? { evenSplitCostUsd: tokenRow.evenSplitCostUsd } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(phaseSegments && phaseSegments.length > 0 ? { phaseSegments } : {}),
    ownerUserName: DESKTOP_LOCAL_SESSION_AUTHOR_LABEL,
    ...(activitySegments === undefined ? {} : { activitySegments }),
  };
}

/** Attribute persisted event spend to the session's classifier spans. */
function buildBranchActivitySegments(
  session: SyncedAgentSession
): BranchSession["activitySegments"] {
  const rows = session.activitySegmentRows;
  if (rows == null) {
    return undefined;
  }
  const spans: ActivitySegmentSpan[] = rows.map((row) => ({
    phase: row.phase,
    startMs: row.startMs,
    endMs: row.endMs,
    confidence: row.confidence,
  }));
  const events: ActivitySpendEvent[] = (session.tokenEvents ?? []).map(
    (event) => ({
      tMs: Date.parse(event.createdAt),
      costUsd: event.estimatedCostUsd ?? null,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      sourceId: event.externalEventId,
    })
  );
  return attributeBranchSessionActivity(spans, events);
}
