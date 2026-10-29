import type { BranchMetricResult } from "@repo/api/src/types/branch-metrics";
import {
  type BranchMetricActivityEvidence,
  calculateBranchLastActiveMetric,
} from "./branch-list-metrics";

/**
 * A linked Session's own last-activity instant, as the Branch Last-active
 * fallback reads it. Cloud passes `session_detail.last_activity_at`; Desktop
 * passes `sessions.last_activity_at`.
 */
export type BranchLinkedSessionActivity = {
  sessionId: string;
  lastActivityAt: Date | string | null | undefined;
};

/**
 * The instant a Session's last activity holds before it has been computed.
 * Desktop's `sessions.last_activity_at` column defaults to the Unix epoch
 * (`SESSION_EPOCH_TIMESTAMP`), so a session caught mid-import reads as 1970.
 */
export const UNCOMPUTED_SESSION_LAST_ACTIVITY_MS = 0;

/**
 * The ONE Branch Last-active definition, shared by the cloud (`apps/api`) and
 * Desktop producers (ISS-11915, operator ruling 2026-10-08: "they should be
 * coming from a shared data layer").
 *
 * The latest of the Branch's own activity evidence wins. Only when that
 * evidence yields no instant does the Branch fall back to the latest computed
 * last activity of its linked Sessions, so a session-only Branch reports the
 * same Last active on both surfaces.
 */
export function resolveBranchLastActiveMetric(
  branchEvents: readonly BranchMetricActivityEvidence[],
  linkedSessions: readonly BranchLinkedSessionActivity[]
): BranchMetricResult<string> {
  const branchLastActive = calculateBranchLastActiveMetric(branchEvents, false);
  if (branchLastActive.value !== null) {
    return branchLastActive;
  }
  const sessionEvents = linkedSessions.flatMap((session) => {
    const occurredAt = computedSessionLastActivityIso(session.lastActivityAt);
    return occurredAt === null
      ? []
      : [{ sourceEventId: `session:${session.sessionId}`, occurredAt }];
  });
  return sessionEvents.length === 0
    ? branchLastActive
    : calculateBranchLastActiveMetric(sessionEvents, false);
}

function computedSessionLastActivityIso(
  value: Date | string | null | undefined
): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms) || ms === UNCOMPUTED_SESSION_LAST_ACTIVITY_MS) {
    return null;
  }
  return new Date(ms).toISOString();
}
