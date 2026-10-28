import type { AgentSessionProjectFacetOption } from "@repo/api/src/types/agent-session-facet-options";
import type { Prisma } from "@repo/database";
import { withDb } from "@repo/database";
import type { LimitFunction } from "p-limit";
import { createDbFanoutLimiter } from "@/lib/db-fanout";
import { sessionProjectCountsSql } from "./project-link-where";

/**
 * ISS-5355: options for the Sessions Project filter facet.
 *
 * A session belongs to a project when it LINKED an artifact in that project —
 * the session→document edge the detail view renders as "linked artifacts"
 * (ISS-5236). That definition lives in `project-link-where.ts` beside the list
 * predicate, so every count here is the row count the same selection produces
 * in the listing. There is no second linkage path, and deliberately no
 * repository→project inference.
 *
 * Two queries, never one per project. The earlier shape issued a `count` per
 * candidate project inside a `Promise.all`, which is exactly the unbounded
 * fan-out `apps/api/AGENTS.md` bans: `withDb` holds no connection, so each
 * concurrent count borrows its own pooled pg connection and an org with more
 * projects than the pool (10 on the `DATABASE_URL` path, 20 on IAM/Vercel)
 * starves every other route. Project cardinality is tenant-controlled, so the
 * fan-out width was chosen by the org's own data. This shape took production
 * down on 2026-07-15 (PRD-528 / FEA-3299).
 *
 *  1. The population's session artifact ids, read through `sessionWhere` so the
 *     facet's population is the listing's.
 *  2. ONE aggregate over the session→document edge for those ids: distinct
 *     sessions per project, with the project's name.
 *
 * ISS-11895: step 2 used to be a row read of every link with its target's
 * project, deduped in memory. On production's largest org a 90-day window is
 * 96,751 links, so the facet shipped ~97k rows plus a ~97k-id `IN` for the
 * targets to return 63 counts, and was the last read of its stage to finish in
 * 26 of the 27 requests over 3 s in the 7 days to 2026-10-19 (p50 2,637 ms). The
 * population read returns one row per in-window session instead (20,282 for
 * that window), and the aggregate returns one row per project.
 *
 * ISS-7598: the two reads stay sequential, but each is submitted through
 * `limiter` so the one connection this path holds at a time counts against a
 * caller-shared budget rather than being invisible to it. The usage-summary
 * composition root runs this concurrently with a wider fan-out and needs the
 * COMBINED in-flight count bounded — see `db-fanout.ts`.
 */
export async function buildProjectFacetOptions(
  organizationId: string,
  sessionWhere: Prisma.SessionDetailWhereInput,
  limiter: LimitFunction = createDbFanoutLimiter()
): Promise<AgentSessionProjectFacetOption[]> {
  const sessions = await limiter(() =>
    withDb((db) =>
      db.artifact.findMany({
        where: { organizationId, session: { is: sessionWhere } },
        select: { id: true },
      })
    )
  );
  if (sessions.length === 0) {
    return [];
  }
  const projects = await limiter(() =>
    withDb((db) =>
      db.$queryRaw<AgentSessionProjectFacetOption[]>(
        sessionProjectCountsSql(
          organizationId,
          sessions.map((session) => session.id)
        )
      )
    )
  );
  // Session-count desc, matching the other facet orders; name then id breaks
  // ties so the option list is stable across reads instead of following row
  // order. Id is what makes it TOTAL (ISS-10851): `Project` carries only
  // `@@unique([organizationId, slug])`, so two projects in one org can share a
  // name, and the aggregate above has no `ORDER BY` — a name-only tie
  // therefore followed whatever row order Postgres returned, which is not the
  // order `projectByProject`'s `UNION ALL` candidate emits.
  return projects.sort(
    (left, right) =>
      right.sessionCount - left.sessionCount ||
      left.projectName.localeCompare(right.projectName) ||
      left.projectId.localeCompare(right.projectId)
  );
}
