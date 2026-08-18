import type { BranchLifecycleEventRow } from "../database/branch-reads.js";

/**
 * Group lifecycle event rows by session, preserving each session's row order.
 *
 * One binding for what was two byte-identical private copies —
 * `shared-branches-api.ts`'s `lifecycleEventsBySession` and
 * `branch-canonical-metric-projection.ts`'s `groupLifecycleEvents`. Both feed
 * the same `lifecycleEvents` field on the phase-attribution input, so a change
 * to one that missed the other would have made the detail and canonical-metric
 * projections disagree about the same branch.
 */
export function groupBranchLifecycleEventsBySession(
  rows: readonly BranchLifecycleEventRow[]
): Map<string, BranchLifecycleEventRow[]> {
  const bySession = new Map<string, BranchLifecycleEventRow[]>();
  for (const row of rows) {
    const events = bySession.get(row.sessionId) ?? [];
    events.push(row);
    bySession.set(row.sessionId, events);
  }
  return bySession;
}
