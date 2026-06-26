/**
 * @file session-maintenance.ts
 * @description FEA-1791 / PLN-886 Phase 3 — standalone session-maintenance
 * write transactions on the single `DesktopPrisma` client. Kept out of the
 * electron-tainted sqlite.ts module so it (and its test) can import only the
 * Prisma facade and run electron-free.
 */
import type { DesktopPrisma } from "./prisma-client.js";

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
