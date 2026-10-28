import type { Prisma } from "@repo/database";
import { withDb } from "@repo/database";
import type { LimitFunction } from "p-limit";
import { chunksOf } from "@/lib/chunks-of";
import { ANALYTICS_QUERY_BATCH_SIZE, findPagedRecords } from "./query-builder";
import {
  type AnalyticsProjectSummaryRecord,
  type AnalyticsSessionRecord,
  analyticsProjectAssignmentSelect,
  analyticsProjectSummarySelect,
  analyticsSessionSelect,
} from "./records";
import { bindParameterChunkSize } from "./write-chunking";

/**
 * ISS-9113 — the analytics session population, read ONCE.
 *
 * ISS-6823 left `/agent-sessions/analytics` keyset-paging `sessionDetail` twice:
 * a project-parented pass carrying the token columns, then a full-population
 * pass carrying the JSON columns. The first predicate is a strict subset of the
 * second (`where AND artifact.projectId != null`), so every project-parented
 * session was selected twice under two disjoint projections.
 *
 * There is only one pass now. The token columns ride the projection the JSON
 * pass already fetches — same rows, same pages, three more scalars — and the
 * Project breakdown's group key is read from the artifact side by
 * {@link readAnalyticsProjectsByArtifactId}.
 *
 * The full-population scan itself is NOT waste and is deliberately preserved:
 * `aggregateByTool` / `aggregateByAgentType` parse JSON columns, which no DB
 * aggregate expresses.
 */
export function readAnalyticsSessions(
  where: Prisma.SessionDetailWhereInput,
  limiter: LimitFunction
): Promise<AnalyticsSessionRecord[]> {
  return findPagedRecords<AnalyticsSessionRecord>((cursorId) =>
    limiter(() =>
      withDb((db) =>
        db.sessionDetail.findMany({
          where,
          select: analyticsSessionSelect,
          orderBy: { artifactId: "asc" },
          take: ANALYTICS_QUERY_BATCH_SIZE,
          ...(cursorId
            ? {
                cursor: { artifactId: cursorId },
                skip: 1,
              }
            : {}),
        })
      )
    )
  );
}

/**
 * ISS-6823's project-parented predicate, stated on the ARTIFACT side.
 *
 * `SessionDetail`→`Artifact` is 1:1, so "sessions matching `where` whose
 * artifact has a project" and "project-carrying artifacts whose session matches
 * `where`" describe the same rows. Stating it here rather than on the session
 * lets the group key be read without re-scanning the sessions.
 *
 * `where` carries its own org scope (through its `artifact` relation filter),
 * so nesting it under `session` transports that scope unchanged — the same
 * reason the predicate it replaces ANDed rather than merged.
 */
export function buildProjectParentedArtifactWhere(
  where: Prisma.SessionDetailWhereInput
): Prisma.ArtifactWhereInput {
  return { projectId: { not: null }, session: { is: where } };
}

/**
 * ISS-9113 — the Project breakdown's group key, in statements bounded by the
 * organization's PROJECT count rather than by its session population.
 *
 * `1 + ceil(distinctProjectIds / bindParameterChunkSize(1, 0))` statements, NOT
 * a constant two: the artifact read is one statement, and the project lookup
 * below is chunked, so it is one statement per chunk of distinct project ids.
 * Both terms are independent of the session population — an org whose distinct
 * project count fits one chunk pays exactly two, which is every real org — but
 * the ceiling is the project count, and this docstring says so rather than
 * promising a constant the code below does not implement.
 *
 * This replaces a keyset-paged `sessionDetail` scan that cost
 * `3 x ceil(parented / ANALYTICS_QUERY_BATCH_SIZE)` statements (a page, plus the
 * artifact and project child statements Prisma issues per page) and materialised
 * every parented session row a second time. What it reads instead is two uuids
 * per parented artifact, then the distinct projects those name.
 *
 * DELIBERATELY UNPAGED, and bounded by construction rather than by a `take`.
 * The population is the same one the paged scan it replaces walked, so this
 * cannot read a row that scan did not; what changes is the projection — two
 * uuids instead of a session row plus its artifact and project children — so it
 * materialises strictly LESS than the read it removes. The caller is already
 * holding the whole session population in memory by the time this resolves
 * (`readAnalyticsSessions`, with each row's `events` relation), so 32 bytes per
 * parented row is not the binding allocation, and paging it back would restore
 * the per-page statement cost this exists to delete. Same tradeoff, same
 * subsystem, as the sibling attribution-lens reads in
 * `lib/agent-session-attribution-read.ts`.
 *
 * The project lookup IS chunked, because its `IN` list is the one predicate
 * whose width is not bounded that way. It is keyed by DISTINCT project id, so
 * the list is bounded by the organization's project count rather than by the
 * session population — but that count is still caller-controlled, and an `IN`
 * wider than the bind-parameter ceiling is a rejected statement, not a slow one.
 */
export async function readAnalyticsProjectsByArtifactId(
  where: Prisma.SessionDetailWhereInput,
  limiter: LimitFunction
): Promise<Map<string, AnalyticsProjectSummaryRecord>> {
  const assignments = await limiter(() =>
    withDb((db) =>
      db.artifact.findMany({
        where: buildProjectParentedArtifactWhere(where),
        select: analyticsProjectAssignmentSelect,
      })
    )
  );
  const projectIds = [
    ...new Set(
      assignments
        .map((assignment) => assignment.projectId)
        .filter((projectId): projectId is string => projectId !== null)
    ),
  ];
  if (projectIds.length === 0) {
    return new Map();
  }

  const projectPages = await Promise.all(
    chunksOf(projectIds, bindParameterChunkSize(1, 0)).map((chunk) =>
      limiter(() =>
        withDb((db) =>
          db.project.findMany({
            where: { id: { in: chunk } },
            select: analyticsProjectSummarySelect,
          })
        )
      )
    )
  );
  const projectsById = new Map(
    projectPages.flat().map((project) => [project.id, project])
  );

  const projectsByArtifactId = new Map<string, AnalyticsProjectSummaryRecord>();
  for (const assignment of assignments) {
    const project = assignment.projectId
      ? projectsById.get(assignment.projectId)
      : undefined;
    // A parented artifact whose project row is missing is dropped rather than
    // counted under a fabricated name — the same drop the fold it replaces made
    // when the nested `project` select came back null.
    if (project) {
      projectsByArtifactId.set(assignment.id, project);
    }
  }
  return projectsByArtifactId;
}
