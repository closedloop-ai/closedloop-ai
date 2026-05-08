import type {
  ArtifactLink,
  ArtifactLinkWithEndpoints,
  BatchMoveArtifactsInput,
  BatchMoveArtifactsResult,
  CreateArtifactLinkInput,
} from "@repo/api/src/types/artifact";
import {
  type ArtifactType,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/artifact";
import type { JsonObject } from "@repo/api/src/types/common";
import { Result, Status } from "@repo/api/src/types/result";
import {
  Prisma,
  type Artifact as PrismaArtifact,
  type ArtifactLink as PrismaArtifactLink,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";

export type AnnotatedLink = { link: ArtifactLink; fromArtifactId: string };

export const artifactLinksService = {
  async createLink(
    organizationId: string,
    input: CreateArtifactLinkInput
  ): Promise<ArtifactLink> {
    await Promise.all([
      assertArtifactInOrg(organizationId, input.sourceId),
      assertArtifactInOrg(organizationId, input.targetId),
    ]);

    const link = await withDb((db) =>
      db.artifactLink.create({
        data: {
          organizationId,
          sourceId: input.sourceId,
          targetId: input.targetId,
          linkType: input.linkType,
          metadata: input.metadata ?? Prisma.DbNull,
        },
      })
    );
    return toArtifactLink(link);
  },

  /**
   * Find links where `artifactId` is either source or target.
   */
  findLinks(
    organizationId: string,
    artifactId: string,
    linkType?: LinkType
  ): Promise<ArtifactLink[]> {
    return withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          OR: [
            { sourceId: artifactId, ...(linkType ? { linkType } : {}) },
            { targetId: artifactId, ...(linkType ? { linkType } : {}) },
          ],
        },
        orderBy: { createdAt: "desc" },
      })
    ).then((links) => links.map(toArtifactLink));
  },

  /**
   * Find links where the given artifact is the target.
   * Returns links whose source side "produced" (or otherwise relates to) it.
   */
  findSourceLinks(
    organizationId: string,
    artifactId: string,
    linkType?: LinkType
  ): Promise<ArtifactLink[]> {
    return withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          targetId: artifactId,
          ...(linkType ? { linkType } : {}),
        },
        orderBy: { createdAt: "desc" },
      })
    ).then((links) => links.map(toArtifactLink));
  },

  /**
   * Find links where the given artifact is the source.
   * Returns what the source "produces" or links to.
   */
  findTargetLinks(
    organizationId: string,
    artifactId: string,
    linkType?: LinkType
  ): Promise<ArtifactLink[]> {
    return withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          sourceId: artifactId,
          ...(linkType ? { linkType } : {}),
        },
        orderBy: { createdAt: "desc" },
      })
    ).then((links) => links.map(toArtifactLink));
  },

  /**
   * Find links by direction (source / target / both).
   */
  findLinksByDirection(
    organizationId: string,
    artifactId: string,
    direction: LinkDirection,
    linkType?: LinkType
  ): Promise<ArtifactLink[]> {
    if (direction === LinkDirection.Source) {
      return artifactLinksService.findSourceLinks(
        organizationId,
        artifactId,
        linkType
      );
    }
    if (direction === LinkDirection.Target) {
      return artifactLinksService.findTargetLinks(
        organizationId,
        artifactId,
        linkType
      );
    }
    return artifactLinksService.findLinks(organizationId, artifactId, linkType);
  },

  /**
   * Return links along with a resolved source/target endpoint object for each.
   * Pairs with the `/artifact-links/resolved` route.
   */
  async findResolvedLinks(
    organizationId: string,
    artifactId: string,
    direction: LinkDirection,
    linkType?: LinkType
  ): Promise<ArtifactLinkWithEndpoints[]> {
    const links = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          ...buildDirectionFilter(artifactId, direction),
          ...(linkType ? { linkType } : {}),
        },
        include: artifactLinkInclude,
        orderBy: { createdAt: "desc" },
      })
    );

    return links.map(toArtifactLinkWithEndpoints);
  },

  /**
   * Tree-mode sibling to `findResolvedLinks`: traverse the link graph via
   * `findLinkTree` then hydrate every collected link with source/target
   * endpoint objects. Used by the `/artifact-links/resolved?mode=tree` route
   * so consumers like BranchesSection / PreviewSection still see transitive
   * edges (feature → plan → PR → deployment).
   */
  async findResolvedLinkTree(
    organizationId: string,
    artifactId: string,
    direction: LinkDirection,
    maxDepth: number,
    linkType?: LinkType
  ): Promise<ArtifactLinkWithEndpoints[]> {
    const annotated = await artifactLinksService.findLinkTree(
      organizationId,
      artifactId,
      direction,
      maxDepth,
      linkType
    );
    if (annotated.length === 0) {
      return [];
    }

    const linkIds = annotated.map((a) => a.link.id);
    const rows = await withDb((db) =>
      db.artifactLink.findMany({
        where: { id: { in: linkIds }, organizationId },
        include: artifactLinkInclude,
      })
    );

    const byId = new Map<string, ArtifactLinkWithEndpoints>();
    for (const row of rows) {
      byId.set(row.id, toArtifactLinkWithEndpoints(row));
    }

    // Preserve traversal order from findLinkTree.
    const out: ArtifactLinkWithEndpoints[] = [];
    for (const { link } of annotated) {
      const hydrated = byId.get(link.id);
      if (hydrated) {
        out.push(hydrated);
      }
    }
    return out;
  },

  /**
   * Traverse the link graph via BFS starting from `artifactId`.
   */
  async findLinkTree(
    organizationId: string,
    artifactId: string,
    direction: LinkDirection,
    maxDepth: number,
    linkType?: LinkType
  ): Promise<AnnotatedLink[]> {
    const visited = new Set<string>([artifactId]);
    const collectedIds = new Set<string>();
    const collected: AnnotatedLink[] = [];
    const queue: QueueEntry[] = [{ id: artifactId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth >= maxDepth) {
        continue;
      }
      const links = await artifactLinksService.findLinksByDirection(
        organizationId,
        current.id,
        direction,
        linkType
      );

      for (const link of links) {
        if (collectedIds.has(link.id)) {
          continue;
        }
        collectedIds.add(link.id);
        collected.push({ link, fromArtifactId: current.id });
        enqueueNeighbors(link, current, visited, queue);
      }
    }
    return collected;
  },

  /**
   * Return all artifacts reachable downstream via PRODUCES links, deduplicated
   * (excludes the starting artifact).
   */
  async findDownstreamArtifactIds(
    organizationId: string,
    artifactId: string
  ): Promise<string[]> {
    const annotated = await artifactLinksService.findLinkTree(
      organizationId,
      artifactId,
      LinkDirection.Target,
      50,
      LinkType.Produces
    );

    const seen = new Set<string>();
    const out: string[] = [];
    for (const { link, fromArtifactId } of annotated) {
      const otherId = getOtherSide(link, fromArtifactId);
      if (otherId !== artifactId && !seen.has(otherId)) {
        seen.add(otherId);
        out.push(otherId);
      }
    }
    return out;
  },

  async batchMoveArtifacts(
    organizationId: string,
    input: BatchMoveArtifactsInput
  ): Promise<Result<BatchMoveArtifactsResult>> {
    // Validation + graph traversal + write run inside a single transaction
    // so the downstream set and target project are read from the same
    // snapshot as the updateMany. Prevents TOCTOU where a concurrent caller
    // deletes the source artifact or reparents a downstream link between
    // our validation and our write.
    const result = await withDb.tx(
      async (tx): Promise<Result<BatchMoveArtifactsResult>> => {
        const [source, targetProject] = await Promise.all([
          tx.artifact.findFirst({
            where: { id: input.artifactId, organizationId },
            select: { id: true, type: true },
          }),
          tx.project.findUnique({
            where: { id: input.targetProjectId, organizationId },
            select: { id: true },
          }),
        ]);
        if (!source) {
          return Result.err(Status.NotFound);
        }
        if (!targetProject) {
          return Result.err(Status.BadRequest);
        }

        const idsToMove = [source.id];
        if (input.includeDownstream) {
          // findDownstreamArtifactIds uses withDb(); inside this tx callback
          // the AsyncLocalStorage-backed tx propagates automatically, so the
          // BFS reads from the same snapshot.
          const downstream =
            await artifactLinksService.findDownstreamArtifactIds(
              organizationId,
              source.id
            );
          idsToMove.push(...downstream);
        }

        const rows = await tx.artifact.findMany({
          where: { id: { in: idsToMove }, organizationId },
          select: { id: true, type: true },
        });
        await tx.artifact.updateMany({
          where: { id: { in: idsToMove }, organizationId },
          data: { projectId: input.targetProjectId },
        });
        const moved = rows.map((r) => ({
          id: r.id,
          type: r.type as ArtifactType,
        }));

        if (moved.length === 0) {
          return Result.err(Status.NotFound);
        }

        return Result.ok({ movedArtifacts: moved });
      }
    );

    if (result.ok) {
      log.info("[artifact-links-service] Batch moved artifacts", {
        organizationId,
        targetProjectId: input.targetProjectId,
        actualCount: result.value.movedArtifacts.length,
      });
    }

    return result;
  },

  async deleteLink(id: string, organizationId: string): Promise<void> {
    await withDb((db) =>
      db.artifactLink.deleteMany({ where: { id, organizationId } })
    );
  },

  /**
   * Delete all links referencing an artifact (as source or target).
   */
  async deleteAllLinks(
    organizationId: string,
    artifactId: string
  ): Promise<void> {
    await withDb((db) =>
      db.artifactLink.deleteMany({
        where: {
          organizationId,
          OR: [{ sourceId: artifactId }, { targetId: artifactId }],
        },
      })
    );
  },
};

type PrismaArtifactLinkWithArtifacts = PrismaArtifactLink & {
  source: PrismaArtifact;
  target: PrismaArtifact;
};

function toArtifactLink(link: PrismaArtifactLink): ArtifactLink {
  return {
    id: link.id,
    organizationId: link.organizationId,
    sourceId: link.sourceId,
    targetId: link.targetId,
    linkType: link.linkType,
    metadata: link.metadata as JsonObject | null,
    createdAt: link.createdAt,
  };
}

function toArtifactLinkWithEndpoints(
  link: PrismaArtifactLinkWithArtifacts
): ArtifactLinkWithEndpoints {
  return {
    ...toArtifactLink(link),
    source: link.source,
    target: link.target,
  };
}

const artifactLinkInclude = {
  source: true,
  target: true,
} as const;

async function assertArtifactInOrg(
  organizationId: string,
  artifactId: string
): Promise<void> {
  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: { id: artifactId, organizationId },
      select: { id: true },
    })
  );
  if (!artifact) {
    throw new Error(`Artifact ${artifactId} not found in organization`);
  }
}

type QueueEntry = { id: string; depth: number };

function buildDirectionFilter(
  artifactId: string,
  direction: LinkDirection
): Prisma.ArtifactLinkWhereInput {
  if (direction === LinkDirection.Source) {
    return { targetId: artifactId };
  }
  if (direction === LinkDirection.Target) {
    return { sourceId: artifactId };
  }
  return { OR: [{ sourceId: artifactId }, { targetId: artifactId }] };
}

function getOtherSide(link: ArtifactLink, fromArtifactId: string): string {
  return link.sourceId === fromArtifactId ? link.targetId : link.sourceId;
}

function enqueueNeighbors(
  link: ArtifactLink,
  current: QueueEntry,
  visited: Set<string>,
  queue: QueueEntry[]
): void {
  const otherId = link.sourceId === current.id ? link.targetId : link.sourceId;
  if (!visited.has(otherId)) {
    visited.add(otherId);
    queue.push({ id: otherId, depth: current.depth + 1 });
  }
}
