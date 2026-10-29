import type { BranchSession } from "@repo/api/src/types/branch";

/**
 * The producers' shared answer for the left edge of a branch's activity span.
 *
 * Two producers fill `BranchLeadTimeActivity`, and ISS-8821 measured them
 * disagreeing on what the field means: the desktop projection
 * (`apps/desktop/src/main/branch/branch-lead-time-projection.ts`) walks every
 * captured session EVENT instant and takes the minimum, while the cloud
 * projection filled `firstActivityT` from the branch's canonical LAST-active
 * instant, so every cloud-served branch claimed its first activity happened at
 * the moment of its last. Cloud has no event instants at the projection site;
 * the linked sessions' own start times are its earliest activity evidence, and
 * `leadTimeWaterfallSegments` already anchors the rendered track on exactly that
 * derivation.
 *
 * Desktop keeps its event walk: it holds strictly finer evidence, and moving it
 * onto session starts would coarsen a value that is already correct.
 */

/**
 * Earliest parseable session start, in epoch ms, or `null` when no session
 * carries one. An unparseable `startedAt` is skipped rather than folded in as a
 * `NaN` that would poison the minimum.
 */
export function earliestSessionStartMs(
  sessions: readonly Pick<BranchSession, "startedAt">[]
): number | null {
  let earliest: number | null = null;
  for (const session of sessions) {
    const ms = Date.parse(session.startedAt);
    if (Number.isNaN(ms)) {
      continue;
    }
    if (earliest == null || ms < earliest) {
      earliest = ms;
    }
  }
  return earliest;
}

/**
 * `firstActivityT` for a producer whose earliest evidence is the linked
 * sessions' start instants, or `null` when no session carries one.
 *
 * `null` means one thing here and nothing else: nothing was measured. An
 * earlier draft also returned `null` when the derived instant postdated the
 * producer's `lastActivityT`, on the grounds that an inverted span is
 * impossible — but cloud's two ends come off two different evidence lanes by
 * construction, so folding their disagreement into the same `null` the
 * no-sessions case uses would make a measured inconsistency indistinguishable
 * from an absence of evidence. That is the lossy fold
 * `apps/api/app/branches/branch-last-active-instant-report.ts` exists to argue
 * against, and this projection is a pure mapper with nowhere to report it from.
 * Both instants are published as measured; a consumer comparing them can see
 * the disagreement.
 */
export function firstActivityTFromSessions(
  sessions: readonly Pick<BranchSession, "startedAt">[]
): string | null {
  const earliestMs = earliestSessionStartMs(sessions);
  return earliestMs === null ? null : new Date(earliestMs).toISOString();
}
