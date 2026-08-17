import type { AgentSessionProjectFacetOption } from "@repo/api/src/types/agent-session-facet-options";
import type { Prisma } from "@repo/database";
import { withDb } from "@repo/database";
import { SESSION_PROJECT_LINK_WHERE } from "./project-link-where";

/**
 * ISS-5355: options for the Sessions Project filter facet.
 *
 * A session belongs to a project when it LINKED an artifact in that project —
 * the session→document edge the detail view renders as "linked artifacts"
 * (ISS-5236). That definition lives in `project-link-where.ts` and is shared
 * verbatim with the list predicate, so every count here is the row count the
 * same selection produces in the listing. There is no second linkage path, and
 * deliberately no repository→project inference.
 *
 * Two queries, both aggregate — never one per project. The earlier shape issued
 * a `count` per candidate project inside a `Promise.all`, which is exactly the
 * unbounded fan-out `apps/api/AGENTS.md` bans: `withDb` holds no connection, so
 * each concurrent count borrows its own pooled pg connection and an org with
 * more projects than the pool (10 on the `DATABASE_URL` path, 20 on IAM/Vercel)
 * starves every other route. Project cardinality is tenant-controlled, so the
 * fan-out width was chosen by the org's own data. This shape took production
 * down on 2026-07-15 (PRD-528 / FEA-3299).
 *
 *  1. ONE read over the session→document link edge for this population,
 *     selecting only the two uuids the tally needs (the source session's
 *     artifact id, and the target document's project). Counting DISTINCT source
 *     ids per project is what makes the number correct: a session linked to five
 *     documents in the same project is ONE session, and a link-level tally would
 *     report it five times. The dedupe is a `Set` over the same edge the filter
 *     uses, so the count and the filtered row set cannot disagree.
 *  2. ONE `project.findMany` over the ids step 1 found, for their names.
 */
export async function buildProjectFacetOptions(
  organizationId: string,
  sessionWhere: Prisma.SessionDetailWhereInput
): Promise<AgentSessionProjectFacetOption[]> {
  const links = await withDb((db) =>
    db.artifactLink.findMany({
      where: {
        organizationId,
        ...SESSION_PROJECT_LINK_WHERE,
        source: { is: { organizationId, session: { is: sessionWhere } } },
      },
      select: { sourceId: true, target: { select: { projectId: true } } },
    })
  );
  const sessionIdsByProject = new Map<string, Set<string>>();
  for (const link of links) {
    const projectId = link.target?.projectId;
    if (projectId == null) {
      continue;
    }
    const sessionIds = sessionIdsByProject.get(projectId);
    if (sessionIds) {
      sessionIds.add(link.sourceId);
    } else {
      sessionIdsByProject.set(projectId, new Set([link.sourceId]));
    }
  }
  if (sessionIdsByProject.size === 0) {
    return [];
  }
  const projects = await withDb((db) =>
    db.project.findMany({
      where: { organizationId, id: { in: [...sessionIdsByProject.keys()] } },
      select: { id: true, name: true },
    })
  );
  const options: AgentSessionProjectFacetOption[] = [];
  for (const project of projects) {
    // Every id in the map came from a link, so it carries at least one session;
    // a project row that resolves to no name is simply absent from `projects`
    // and so never becomes an option labelled with a raw uuid.
    const sessionCount = sessionIdsByProject.get(project.id)?.size ?? 0;
    if (sessionCount > 0) {
      options.push({
        projectId: project.id,
        projectName: project.name,
        sessionCount,
      });
    }
  }
  // Session-count desc, matching the other facet orders; name breaks ties so
  // the option list is stable across reads instead of following row order.
  return options.sort(
    (left, right) =>
      right.sessionCount - left.sessionCount ||
      left.projectName.localeCompare(right.projectName)
  );
}
