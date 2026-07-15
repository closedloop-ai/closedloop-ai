/**
 * @file session-maintenance.ts
 * @description Standalone session-maintenance write transactions on the single
 * `DesktopPrisma` client. Kept out of the electron-tainted sqlite.ts module so
 * it (and its test) can import only the Prisma facade and run electron-free.
 */
import type { DesktopPrisma } from "./prisma-client.js";

// Terminal session statuses: a session in any of these is finished and is the
// only retention-sweep candidate. Kept as local literals (not imported) so this
// module stays electron-free; mirrors `TERMINAL_STATUS_SET` in sqlite.ts.
const TERMINAL_STATUSES = ["completed", "abandoned", "error"];

// Default data-governance retention window, in days. Terminal sessions whose
// last activity predates this window are purged outright — see
// `sweepExpiredSessions`. 90 days bounds how long the local store keeps full
// session history (transcripts, tool calls, token usage, agents).
const DEFAULT_RETENTION_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60_000;

// Gap 8: Orphaned session cleanup — marks stale 'active' sessions as
// 'abandoned' and their non-terminal agents as 'completed'. Called during
// boot import to clean up sessions interrupted by process kill / laptop
// close that never received a SessionEnd hook.
export function sweepOrphanedSessions(
  prisma: DesktopPrisma,
  now: string,
  staleMinutes = 180
): Promise<number> {
  const cutoff = new Date(
    new Date(now).valueOf() - staleMinutes * 60_000
  ).toISOString();
  // One atomic write transaction on the single client (serialized through the
  // shared queue via `write`). Typed throughout: the prior per-session UPDATE
  // loop becomes two set-based updateManys over the stale id set — the agent
  // arm's per-row `status NOT IN ('completed','error')` guard rides in the
  // where-clause, so the effect is identical with fewer statements.
  return prisma.write((client) =>
    client.$transaction(async (tx) => {
      const stale = await tx.session.findMany({
        where: { status: "active", updatedAt: { lt: cutoff } },
        select: { id: true },
      });
      if (stale.length === 0) {
        return 0;
      }
      const staleIds = stale.map((row) => row.id);
      await tx.agent.updateMany({
        where: {
          sessionId: { in: staleIds },
          status: { notIn: ["completed", "error"] },
        },
        data: { status: "completed", endedAt: now, updatedAt: now },
      });
      await tx.session.updateMany({
        where: { id: { in: staleIds } },
        data: { status: "abandoned", endedAt: now, updatedAt: now },
      });
      return stale.length;
    })
  );
}

// Privacy / data-governance retention sweep. Deletes terminal
// (completed/abandoned/error) sessions whose last activity predates the
// governance window, together with EVERY session-keyed child row —
// events/transcripts, token usage/events, codex trace spans, claude-code OTel
// rows, artifact links, pull-request detail and the derived analytics rollups —
// with agents removed via the sessions(id) FK cascade. Active/running sessions
// are never touched (re-checked by the status filter inside the same
// transaction). Returns the number of sessions deleted.
//
// Unlike the inline delete paths in sqlite.ts (this module stays electron-free
// and cannot import that electron-tainted one), the sweep must leave NOTHING
// session-attributable behind: a retention purge has no reimport to rebuild
// derived state from. So the set is the union of every session-keyed table the
// codebase deletes — `deleteSessionRow`'s child set plus `pull_requests` /
// `pr_backfill_seen` (cleared by `rebuildSessionFromParse`) plus the
// `session_analytics` / `session_tool_analytics` rollups (which deleteSessionRow
// leaves for ingest-time rebuild) and the `session_turn_bucket` per-turn rollup.
// The rollups matter because the cost-KPI reads
// scan `session_analytics` standalone, so an orphaned rollup would otherwise leak
// a purged session's cost/token totals into the dashboard. One atomic write
// transaction on the single client, matching `sweepOrphanedSessions` above.
export function sweepExpiredSessions(
  prisma: DesktopPrisma,
  now: string,
  retentionDays = DEFAULT_RETENTION_DAYS
): Promise<number> {
  const cutoff = new Date(
    new Date(now).valueOf() - retentionDays * MS_PER_DAY
  ).toISOString();
  return prisma.write((client) =>
    client.$transaction(async (tx) => {
      // `lastActivityAt` is NOT NULL (epoch floor default, maintained at
      // ingest), so it is the robust age anchor for the cutoff.
      const expired = await tx.session.findMany({
        where: {
          status: { in: TERMINAL_STATUSES },
          lastActivityAt: { lt: cutoff },
        },
        select: { id: true },
      });
      if (expired.length === 0) {
        return 0;
      }
      const expiredIds = expired.map((row) => row.id);
      const where = { sessionId: { in: expiredIds } };
      await tx.event.deleteMany({ where });
      // token_events is @@ignore'd (no PK → no typed delegate); delete it raw,
      // with one positional placeholder per id, inside the same transaction.
      await tx.$executeRawUnsafe(
        `DELETE FROM token_events WHERE session_id IN (${expiredIds
          .map((_, index) => `$${index + 1}`)
          .join(", ")})`,
        ...expiredIds
      );
      // FEA-2267: session_activity_segments has no FK cascade, so purge it with
      // the session so the activity-timing rows do not outlive it.
      await tx.sessionActivitySegment.deleteMany({ where });
      // FEA-3132: session_turn_bucket has no FK cascade (buckets are re-derived
      // per import); a retention purge has no reimport, so clear it too so the
      // per-turn rows do not outlive the purged session.
      await tx.sessionTurnBucket.deleteMany({ where });
      await tx.tokenUsage.deleteMany({ where });
      await tx.codexTraceSpan.deleteMany({ where });
      await tx.claudeCodeCostEvent.deleteMany({ where });
      await tx.claudeCodePermissionEvent.deleteMany({ where });
      await tx.claudeCodeApiRequest.deleteMany({ where });
      await tx.sessionArtifactLink.deleteMany({ where });
      await tx.artifactLinkBackfillSeen.deleteMany({ where });
      await tx.activitySegmentBackfillSeen.deleteMany({ where });
      // Pull-request lifecycle detail (no FK cascade): session_id rows carry
      // identifying repo/branch/title/url, so purge them with the session.
      await tx.pullRequest.deleteMany({ where });
      await tx.prBackfillSeen.deleteMany({ where });
      // Derived rollups (no FK cascade): clear them too so a purged session
      // leaves no cost/token aggregates behind.
      await tx.sessionAnalytics.deleteMany({ where });
      await tx.sessionToolAnalytics.deleteMany({ where });
      // agents cascade via the sessions(id) FK (foreign_keys=ON on the adapter
      // connection); the explicit deletes above cover the no-cascade tables.
      await tx.session.deleteMany({ where: { id: { in: expiredIds } } });
      return expired.length;
    })
  );
}
