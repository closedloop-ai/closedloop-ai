import { type Prisma, withDb } from "@repo/database";
import type { LimitFunction } from "p-limit";

/**
 * ISS-12251 D-1 (PLN-2176 T-3.1): the Sessions usage-summary Owner breakdown,
 * grouped by the session artifact's assignee.
 *
 * The sums live on `session_detail` and the assignee on `artifacts`, and a
 * Prisma `groupBy` can only group a model by its own columns. So this reads the
 * population's distinct assignees with ONE `artifact.groupBy`, then each
 * assignee's sums with one aggregate through the caller's `limiter` — the
 * request-wide budget `getUsageSummary` shares across its fan-out (ISS-7598).
 * An unassigned session is in no group, as an unresolvable owner already was
 * (`usage-facet-projections.ts`).
 *
 * lc-debt: one aggregate per distinct assignee in the population (bounded by
 * the org's member count, not its session count); the typed-SQL
 * `sessionFacetCounts` Owner arm answers it in one statement and replaces this
 * when the PLN-1853 shadow is promoted to serve.
 */
export async function readUsageGroupsByAssignee(
  organizationId: string,
  sessionWhere: Prisma.SessionDetailWhereInput,
  limiter: LimitFunction
) {
  const assignees = await limiter(() =>
    withDb((db) =>
      db.artifact.groupBy({
        by: ["assigneeId"],
        where: {
          organizationId,
          assigneeId: { not: null },
          session: { is: sessionWhere },
        },
      })
    )
  );
  const assigneeIds = assignees
    .map((row) => row.assigneeId)
    .filter((id): id is string => id !== null);
  return Promise.all(
    assigneeIds.map((assigneeId) =>
      limiter(async () => {
        const sums = await withDb((db) =>
          db.sessionDetail.aggregate({
            where: {
              AND: [sessionWhere, { artifact: { is: { assigneeId } } }],
            },
            _count: { _all: true },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
              estimatedCost: true,
            },
          })
        );
        return { userId: assigneeId, ...sums };
      })
    )
  );
}
