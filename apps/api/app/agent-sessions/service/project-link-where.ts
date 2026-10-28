import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { Prisma } from "@repo/database";

/**
 * ISS-5355 — the definition of "this session touched an artifact in this
 * project", for the Project facet's PREDICATE (`query-builder.ts`) and its
 * COUNTS (`project-facet-options.ts`).
 *
 * A session's project is NOT its own artifact's `projectId`: a synced
 * SessionDetail artifact is created unparented, so that column is null for
 * essentially every session and a facet built on it would be permanently empty.
 * The real linkage is the session→artifact edge the session detail view already
 * renders as "linked artifacts" (ISS-5236): `Artifact.sourceLinks` from the
 * session artifact, narrowed exactly as {@link toLinkedArtifactProjection}
 * narrows them — `linkType = RELATES_TO` (the only link type `records.ts`
 * selects, and the only one `slug-links.ts` persists for this lane) AND a
 * DOCUMENT-typed target. Both halves matter: a PRODUCES or BLOCKS edge to a
 * document in the project is reachable on the `artifact_links` table and would
 * count a session the linked-artifacts projection never shows, so the facet
 * number would exceed what the session detail can account for.
 *
 * The live path spells the edge twice, both here: as a Prisma `where` for the
 * predicate, and as SQL for the counts, because a per-project DISTINCT-session
 * count is a GROUP BY Prisma cannot express (ISS-11895). Two copies of this
 * shape is how a facet's number ends up disagreeing with the rows it filters
 * to, so they sit side by side and `project-facet-options.integration.test.ts`
 * asserts every count equals the row count of the list filtered to that
 * project. The TypedSQL shadow (`sessionFacetCounts.sql`) carries its own copy.
 */
export function buildProjectLinkWhere(
  projectIds: readonly string[]
): Prisma.ArtifactLinkWhereInput {
  return {
    linkType: LinkType.RelatesTo,
    target: {
      is: {
        type: ArtifactType.Document,
        projectId: { in: [...projectIds] },
      },
    },
  };
}

/**
 * ISS-11895: the same edge as one aggregate — for each project the given
 * sessions reach, how many DISTINCT sessions reached it, with its name. Five
 * documents in one project are one session, which is why this counts distinct
 * (project, session) pairs rather than links.
 *
 * The inner join to `projects` also requires a non-null `project_id`, and
 * drops a project that resolves to no name in this org.
 */
export function sessionProjectCountsSql(
  organizationId: string,
  sessionArtifactIds: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    SELECT pair.project_id AS "projectId",
           pair.project_name AS "projectName",
           count(*)::int AS "sessionCount"
      FROM (
        SELECT DISTINCT doc.project_id, project.name AS project_name, link.source_id
          FROM artifact_links AS link
          JOIN artifacts AS doc
            ON doc.id = link.target_id
           AND doc.type = ${ArtifactType.Document}::"ArtifactType"
          JOIN projects AS project
            ON project.id = doc.project_id
           AND project.organization_id = ${organizationId}::uuid
         WHERE link.organization_id = ${organizationId}::uuid
           AND link.link_type = ${LinkType.RelatesTo}::"LinkType"
           AND link.source_id = ANY(${[...sessionArtifactIds]}::uuid[])
      ) AS pair
     GROUP BY pair.project_id, pair.project_name
  `;
}
