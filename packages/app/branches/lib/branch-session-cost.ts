import type { BranchSession } from "@repo/api/src/types/branch";
import { resolveAttributedBranchCost } from "@repo/api/src/types/branch-cost";
import type { SessionTimelineDetail } from "@repo/api/src/types/document-sessions";

/**
 * Dedups branch session rows by session id so duplicate branch links do not
 * over-attribute cost or token activity.
 */
export function distinctBranchSessions(
  sessions: readonly BranchSession[]
): BranchSession[] {
  const seen = new Set<string>();
  const distinct: BranchSession[] = [];
  for (const session of sessions) {
    if (seen.has(session.sessionId)) {
      continue;
    }
    seen.add(session.sessionId);
    distinct.push(session);
  }
  return distinct;
}

/**
 * Maps unstamped raw session costs onto the branch residual left after stamped
 * even-split costs are applied.
 */
export function resolveBranchSessionFallbackCostScale(
  detail: SessionTimelineDetail,
  sessions: readonly BranchSession[]
): number {
  const branchTotal = resolveAttributedBranchCost(detail);
  if (branchTotal == null || branchTotal < 0) {
    return 1;
  }
  let stampedTotal = 0;
  let unstampedRawTotal = 0;
  for (const session of sessions) {
    if (session.evenSplitCostUsd != null) {
      stampedTotal += session.evenSplitCostUsd;
      continue;
    }
    unstampedRawTotal += session.estimatedCostUsd ?? 0;
  }
  if (unstampedRawTotal <= 0) {
    return 1;
  }
  return Math.max(0, branchTotal - stampedTotal) / unstampedRawTotal;
}

/**
 * Resolves this branch's share of one session's spend, preferring server-stamped
 * even-split cost and using residual scaling for legacy unstamped rows.
 */
export function resolveBranchSessionCost(
  session: BranchSession,
  fallbackScale: number,
  branchCostUnavailable: boolean
): number {
  if (branchCostUnavailable) {
    return 0;
  }
  if (session.evenSplitCostUsd != null) {
    return session.evenSplitCostUsd;
  }
  return (session.estimatedCostUsd ?? 0) * fallbackScale;
}

/**
 * Resolves a subtotal with the same residual scale `buildSessionTimeline` uses.
 *
 * `costScaleSessions` may be a fuller source set than `sessions` when trace
 * hydration filters the rendered rows. That keeps missing stamped rows in the
 * residual math without rendering their unavailable bars.
 */
export function resolveBranchSessionCostSubtotal(
  detail: SessionTimelineDetail,
  sessions: readonly BranchSession[],
  costScaleSessions: readonly BranchSession[] = sessions
): number {
  const fallbackScale = resolveBranchSessionFallbackCostScale(
    detail,
    distinctBranchSessions(costScaleSessions)
  );
  const branchCostUnavailable = detail.attributedCostUsd === null;
  return distinctBranchSessions(sessions).reduce(
    (sum, session) =>
      sum +
      resolveBranchSessionCost(session, fallbackScale, branchCostUnavailable),
    0
  );
}

/**
 * Resolves a subtotal only when every loaded row includes explicit cost
 * evidence. A numeric zero is otherwise ambiguous: it can be known zero spend,
 * or just the sum produced when one loaded row was unavailable.
 */
export function resolveKnownBranchSessionCostSubtotal(
  detail: SessionTimelineDetail,
  sessions: readonly BranchSession[],
  costScaleSessions: readonly BranchSession[] = sessions
): number | null {
  if (!hasKnownBranchSessionCost(detail, sessions)) {
    return null;
  }
  return resolveBranchSessionCostSubtotal(detail, sessions, costScaleSessions);
}

function hasKnownBranchSessionCost(
  detail: SessionTimelineDetail,
  sessions: readonly BranchSession[]
): boolean {
  if (detail.attributedCostUsd === null) {
    return false;
  }
  const distinctSessions = distinctBranchSessions(sessions);
  if (distinctSessions.length === 0) {
    return false;
  }
  return distinctSessions.every(
    (session) =>
      session.evenSplitCostUsd != null || session.estimatedCostUsd != null
  );
}
