import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { Prisma } from "@repo/database";

/**
 * ISS-5355 — the ONE definition of "this session touched an artifact in this
 * project", shared by the Project facet's PREDICATE (`query-builder.ts`) and its
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
 * Lives in its own module so the predicate and the counts cannot drift: two
 * hand-written copies of this shape is precisely how a facet's number ends up
 * disagreeing with the rows it filters to.
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
 * The same edge, unfiltered by project — every session→document link that lands
 * in SOME project. Used to enumerate which projects the current population
 * reaches (and how many distinct sessions reached each) in one read, so the
 * facet lists only projects that actually have sessions.
 */
export const SESSION_PROJECT_LINK_WHERE: Prisma.ArtifactLinkWhereInput = {
  linkType: LinkType.RelatesTo,
  target: {
    is: {
      type: ArtifactType.Document,
      projectId: { not: null },
    },
  },
};
