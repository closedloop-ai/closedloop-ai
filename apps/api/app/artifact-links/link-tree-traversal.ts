import type { ArtifactLink } from "@repo/api/src/types/artifact";
import { LinkDirection, type LinkType } from "@repo/api/src/types/artifact";
import { type Prisma, withDb } from "@repo/database";
import { POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";
import { ARTIFACT_LINK_SELECT, toArtifactLink } from "./link-projections";

export type AnnotatedLink = { link: ArtifactLink; fromArtifactId: string };

/** `organizationId` and the optional `linkType`. */
const FRONTIER_FIXED_BIND_PARAMETERS = 8;

/**
 * Frontier ids per traversal statement.
 *
 * Halved because {@link LinkDirection.Both} binds the id list TWICE — once
 * under `sourceId`, once under `targetId` — so the statement width is twice the
 * frontier, not the frontier.
 */
export const FRONTIER_ID_CHUNK_SIZE = Math.floor(
  (POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS - FRONTIER_FIXED_BIND_PARAMETERS) / 2
);

/**
 * Breadth-first traversal of the artifact-link graph from `artifactId`, reading
 * ONE statement per DEPTH LEVEL rather than one per node (ISS-10041).
 *
 * The per-node shape this replaces is a textbook N+1 whose fan-out follows the
 * tenant's graph, not the request: production APM recorded a single
 * `/artifact-links/resolved?mode=tree` request issuing 14,776 identical
 * `SELECT ... FROM artifact_links WHERE organization_id = $1 AND (source_id =
 * $2 OR target_id = $3)` statements, each with its own pool checkout, for 77s
 * of a 91s request.
 *
 * Emission order is deliberately identical to the per-node walk: levels in
 * order, nodes within a level in discovery order, and a node's own links in
 * `createdAt desc, id desc`. A link touching two frontier nodes is attributed to the
 * earlier one, which is what the per-node walk's dedupe did implicitly.
 */
export async function traverseLinkTree(
  organizationId: string,
  artifactId: string,
  direction: LinkDirection,
  maxDepth: number,
  linkType?: LinkType
): Promise<AnnotatedLink[]> {
  const visited = new Set<string>([artifactId]);
  const collectedIds = new Set<string>();
  const collected: AnnotatedLink[] = [];
  let frontier: string[] = [artifactId];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const linksByNode = await fetchFrontierLinks(
      organizationId,
      frontier,
      direction,
      linkType
    );
    const nextFrontier: string[] = [];

    for (const nodeId of frontier) {
      for (const link of linksByNode.get(nodeId) ?? []) {
        if (collectedIds.has(link.id)) {
          continue;
        }
        collectedIds.add(link.id);
        collected.push({ link, fromArtifactId: nodeId });

        const otherId =
          link.sourceId === nodeId ? link.targetId : link.sourceId;
        if (!visited.has(otherId)) {
          visited.add(otherId);
          nextFrontier.push(otherId);
        }
      }
    }
    frontier = nextFrontier;
  }

  return collected;
}

/**
 * Every link touching any frontier node, grouped under each frontier node it
 * touches and ordered `createdAt desc` within each group.
 *
 * Chunks are read in sequence, never with `Promise.all`: the chunk COUNT
 * follows the frontier size, so awaiting them together would be the unbounded
 * concurrent fan-out `apps/api/AGENTS.md` forbids. A frontier wide enough to
 * split is already the pathological case this function exists to bound.
 */
async function fetchFrontierLinks(
  organizationId: string,
  frontier: readonly string[],
  direction: LinkDirection,
  linkType?: LinkType
): Promise<Map<string, ArtifactLink[]>> {
  const byNode = new Map<string, ArtifactLink[]>();

  for (
    let start = 0;
    start < frontier.length;
    start += FRONTIER_ID_CHUNK_SIZE
  ) {
    const idChunk = frontier.slice(start, start + FRONTIER_ID_CHUNK_SIZE);
    const inChunk = new Set(idChunk);
    const rows = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          ...buildFrontierDirectionFilter(idChunk, direction),
          ...(linkType ? { linkType } : {}),
        },
        // ISS-10102: `id desc` breaks the `createdAt` tie. The emission order
        // below is what a cursor pages through, and two links written in the
        // same millisecond can otherwise swap places between two reads — which
        // for an offset cursor means one row served twice and another never
        // served at all.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: ARTIFACT_LINK_SELECT,
      })
    );

    for (const row of rows) {
      const link = toArtifactLink(row);
      for (const nodeId of attachmentNodeIds(link, direction, inChunk)) {
        const bucket = byNode.get(nodeId);
        if (bucket) {
          bucket.push(link);
        } else {
          byNode.set(nodeId, [link]);
        }
      }
    }
  }

  return byNode;
}

function buildFrontierDirectionFilter(
  ids: readonly string[],
  direction: LinkDirection
): Prisma.ArtifactLinkWhereInput {
  const idFilter = { in: [...ids] };
  if (direction === LinkDirection.Source) {
    return { targetId: idFilter };
  }
  if (direction === LinkDirection.Target) {
    return { sourceId: idFilter };
  }
  return { OR: [{ sourceId: idFilter }, { targetId: idFilter }] };
}

/**
 * Which frontier nodes this link hangs off, mirroring the per-direction `where`
 * above: `Source` looks up incoming edges, so the frontier node is the TARGET.
 */
function attachmentNodeIds(
  link: ArtifactLink,
  direction: LinkDirection,
  frontier: ReadonlySet<string>
): string[] {
  if (direction === LinkDirection.Source) {
    return frontier.has(link.targetId) ? [link.targetId] : [];
  }
  if (direction === LinkDirection.Target) {
    return frontier.has(link.sourceId) ? [link.sourceId] : [];
  }
  const ids: string[] = [];
  if (frontier.has(link.sourceId)) {
    ids.push(link.sourceId);
  }
  if (frontier.has(link.targetId) && link.targetId !== link.sourceId) {
    ids.push(link.targetId);
  }
  return ids;
}
