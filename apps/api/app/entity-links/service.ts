import type { JsonObject } from "@repo/api/src/types/common";
import type {
  BatchMoveEntitiesInput,
  BatchMoveEntitiesResult,
  CreateEntityLinkInput,
  EntityLink,
  LinkedEntity,
  ResolvedEntity,
} from "@repo/api/src/types/entity-link";
import {
  EntityType,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/entity-link";
import {
  type ExternalLink,
  ExternalLinkType,
} from "@repo/api/src/types/external-link";
import { Result, Status } from "@repo/api/src/types/result";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { basicUserSelect } from "@/lib/db-utils";
import { assertEntityInOrganization } from "@/lib/entity-validation";
import { schedulePrReadRepair } from "@/lib/pr-read-repair";
import { externalLinksService } from "../external-links/service";

export const entityLinksService = {
  toEntityLink(link: Prisma.EntityLinkModel): EntityLink {
    return {
      ...link,
      metadata: link.metadata as JsonObject | null,
    };
  },

  async createLink(
    organizationId: string,
    input: CreateEntityLinkInput
  ): Promise<EntityLink> {
    await Promise.all([
      assertEntityInOrganization(
        organizationId,
        input.sourceId,
        input.sourceType
      ),
      assertEntityInOrganization(
        organizationId,
        input.targetId,
        input.targetType
      ),
    ]);

    return withDb((db) =>
      db.entityLink.create({
        data: {
          ...input,
          organizationId,
          metadata: input.metadata ?? Prisma.DbNull,
        },
      })
    ).then(this.toEntityLink);
  },

  findLinks(
    organizationId: string,
    entityId: string,
    entityType: EntityType,
    linkType?: LinkType
  ): Promise<EntityLink[]> {
    return withDb((db) =>
      db.entityLink.findMany({
        where: {
          organizationId,
          OR: [
            {
              sourceId: entityId,
              sourceType: entityType,
              ...(linkType ? { linkType } : {}),
            },
            {
              targetId: entityId,
              targetType: entityType,
              ...(linkType ? { linkType } : {}),
            },
          ],
        },
        orderBy: { createdAt: "desc" },
      })
    ).then((links) => links.map(this.toEntityLink));
  },

  /**
   * Find links where the given entity is the target.
   * Returns the source side (e.g., "what produced this entity?").
   */
  findSourceLinks(
    organizationId: string,
    entityId: string,
    entityType: EntityType,
    linkType?: LinkType
  ): Promise<EntityLink[]> {
    return withDb((db) =>
      db.entityLink.findMany({
        where: {
          organizationId,
          targetId: entityId,
          targetType: entityType,
          ...(linkType ? { linkType } : {}),
        },
        orderBy: { createdAt: "desc" },
      })
    ).then((links) => links.map(this.toEntityLink));
  },

  /**
   * Find links where the given entity is the source.
   * Returns the target side (e.g., "what did this entity produce?").
   */
  findTargetLinks(
    organizationId: string,
    entityId: string,
    entityType: EntityType,
    linkType?: LinkType
  ): Promise<EntityLink[]> {
    return withDb((db) =>
      db.entityLink.findMany({
        where: {
          organizationId,
          sourceId: entityId,
          sourceType: entityType,
          ...(linkType ? { linkType } : {}),
        },
        orderBy: { createdAt: "desc" },
      })
    ).then((links) => links.map(this.toEntityLink));
  },

  /**
   * Resolve an entity by ID and type into its full object.
   */
  async resolveEntity(
    organizationId: string,
    id: string,
    entityType: EntityType
  ): Promise<ResolvedEntity | null> {
    switch (entityType) {
      case EntityType.Artifact: {
        const artifact = await withDb((db) =>
          db.artifact.findUnique({
            where: { id, organizationId },
            include: {
              assignee: basicUserSelect,
              approver: basicUserSelect,
            },
          })
        );
        if (!artifact) {
          return null;
        }
        return { type: EntityType.Artifact, entity: artifact };
      }
      case EntityType.Feature: {
        const feature = await withDb((db) =>
          db.feature.findUnique({
            where: { id, organizationId },
            include: {
              assignee: basicUserSelect,
              createdBy: basicUserSelect,
            },
          })
        );
        if (!feature) {
          return null;
        }
        return { type: EntityType.Feature, entity: feature };
      }
      case EntityType.ExternalLink: {
        const link = await withDb((db) =>
          db.externalLink.findUnique({ where: { id, organizationId } })
        );
        if (!link) {
          return null;
        }
        return {
          type: EntityType.ExternalLink,
          entity: externalLinksService.toExternalLink(link),
        };
      }
      default:
        return null;
    }
  },

  /**
   * Traverse the link graph via BFS, collecting all EntityLink records
   * reachable from the starting entity up to maxDepth hops.
   *
   * Each link is annotated with the ID of the BFS node that discovered it,
   * so callers can determine the "other" side for resolution.
   */
  async findLinkTree(
    organizationId: string,
    entityId: string,
    entityType: EntityType,
    direction: LinkDirection,
    maxDepth: number,
    linkType?: LinkType
  ): Promise<AnnotatedLink[]> {
    const visitedEntities = new Set<string>([`${entityId}:${entityType}`]);
    const collectedLinkIds = new Set<string>();
    const collectedLinks: AnnotatedLink[] = [];

    const queue: QueueEntry[] = [{ id: entityId, type: entityType, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) {
        continue;
      }

      const links = await this.findLinksByDirection(
        organizationId,
        current.id,
        current.type,
        direction,
        linkType
      );

      for (const link of links) {
        if (collectedLinkIds.has(link.id)) {
          continue;
        }
        collectedLinkIds.add(link.id);
        collectedLinks.push({ link, fromEntityId: current.id });

        enqueueNeighbors(link, current, visitedEntities, queue);
      }
    }

    return collectedLinks;
  },

  findLinksByDirection(
    organizationId: string,
    entityId: string,
    entityType: EntityType,
    direction: LinkDirection,
    linkType?: LinkType
  ): Promise<EntityLink[]> {
    if (direction === LinkDirection.Source) {
      return this.findSourceLinks(
        organizationId,
        entityId,
        entityType,
        linkType
      );
    }
    if (direction === LinkDirection.Target) {
      return this.findTargetLinks(
        organizationId,
        entityId,
        entityType,
        linkType
      );
    }
    return this.findLinks(organizationId, entityId, entityType, linkType);
  },

  /**
   * Resolve the "other" entity on each link.
   *
   * Each AnnotatedLink carries the ID of the entity that was the "known" side
   * when the link was discovered. For direct queries this is always the queried
   * entityId; for tree traversals it is the BFS node that found the link.
   */
  async resolveLinkedEntities(
    organizationId: string,
    annotatedLinks: AnnotatedLink[]
  ): Promise<LinkedEntity[]> {
    const entityRefs = new Map<string, { id: string; type: EntityType }>();

    for (const { link, fromEntityId } of annotatedLinks) {
      const other = getOtherSide(link, fromEntityId);
      entityRefs.set(`${other.id}:${other.type}`, other);
    }

    const resolved = new Map<string, ResolvedEntity | null>();
    await Promise.all(
      [...entityRefs.entries()].map(async ([key, ref]) => {
        const entity = await this.resolveEntity(
          organizationId,
          ref.id,
          ref.type
        );
        resolved.set(key, entity);
      })
    );

    const result = annotatedLinks.map(({ link, fromEntityId }) => {
      const other = getOtherSide(link, fromEntityId);
      const key = `${other.id}:${other.type}`;
      return { ...link, resolvedEntity: resolved.get(key) ?? null };
    });

    const prLinks = result.flatMap((le) =>
      le.resolvedEntity?.type === EntityType.ExternalLink &&
      le.resolvedEntity.entity.type === ExternalLinkType.PullRequest
        ? [le.resolvedEntity.entity as ExternalLink]
        : []
    );
    schedulePrReadRepair(prLinks, organizationId);

    return result;
  },

  /**
   * Find all downstream entities reachable from the given entity via PRODUCES links.
   * Returns deduplicated array of { id, type } pairs (excludes the starting entity).
   */
  async findDownstreamEntityIds(
    organizationId: string,
    entityId: string,
    entityType: EntityType
  ): Promise<{ id: string; type: EntityType }[]> {
    const annotatedLinks = await this.findLinkTree(
      organizationId,
      entityId,
      entityType,
      LinkDirection.Target,
      50,
      LinkType.Produces
    );

    const seen = new Set<string>();
    const result: { id: string; type: EntityType }[] = [];

    for (const { link, fromEntityId } of annotatedLinks) {
      const other = getOtherSide(link, fromEntityId);
      const key = `${other.id}:${other.type}`;
      if (!seen.has(key) && other.id !== entityId) {
        seen.add(key);
        result.push(other);
      }
    }

    return result;
  },

  /**
   * Move an entity (and optionally all its downstream entities) to a target project.
   * All updates happen in a single transaction.
   */
  async batchMoveEntities(
    organizationId: string,
    input: BatchMoveEntitiesInput
  ): Promise<Result<BatchMoveEntitiesResult>> {
    // Validate both root entity and target project exist in the org
    const [entityExists, targetProject] = await Promise.all([
      assertEntityInOrganization(
        organizationId,
        input.entityId,
        input.entityType
      )
        .then(() => true)
        .catch(() => false),
      withDb((db) =>
        db.project.findUnique({
          where: { id: input.targetProjectId, organizationId },
          select: { id: true },
        })
      ),
    ]);

    if (!entityExists) {
      return Result.err(Status.NotFound);
    }
    if (!targetProject) {
      return Result.err(Status.BadRequest);
    }

    const entitiesToMove: { id: string; type: EntityType }[] = [
      { id: input.entityId, type: input.entityType },
    ];

    const shouldIncludeDownstream = input.includeDownstream;

    if (shouldIncludeDownstream) {
      const downstream = await this.findDownstreamEntityIds(
        organizationId,
        input.entityId,
        input.entityType
      );
      entitiesToMove.push(...downstream);
    }

    const artifactIds: string[] = [];
    const featureIds: string[] = [];
    const externalLinkIds: string[] = [];

    for (const entity of entitiesToMove) {
      if (entity.type === EntityType.Artifact) {
        artifactIds.push(entity.id);
      } else if (entity.type === EntityType.Feature) {
        featureIds.push(entity.id);
      } else if (entity.type === EntityType.ExternalLink) {
        externalLinkIds.push(entity.id);
      }
    }

    const counts = await withDb.tx(async (tx) => {
      let totalUpdated = 0;

      if (artifactIds.length > 0) {
        const { count } = await tx.artifact.updateMany({
          where: { id: { in: artifactIds }, organizationId },
          data: { projectId: input.targetProjectId },
        });
        totalUpdated += count;
      }
      if (featureIds.length > 0) {
        const { count } = await tx.feature.updateMany({
          where: { id: { in: featureIds }, organizationId },
          data: { projectId: input.targetProjectId },
        });
        totalUpdated += count;
      }
      if (externalLinkIds.length > 0) {
        const { count } = await tx.externalLink.updateMany({
          where: { id: { in: externalLinkIds }, organizationId },
          data: { projectId: input.targetProjectId },
        });
        totalUpdated += count;
      }

      return totalUpdated;
    });

    if (counts === 0) {
      return Result.err(Status.NotFound);
    }

    log.info("[entity-links-service] Batch moved entities", {
      organizationId,
      targetProjectId: input.targetProjectId,
      requestedCount: entitiesToMove.length,
      actualCount: counts,
    });

    return Result.ok({ movedEntities: entitiesToMove });
  },

  async deleteLink(id: string, organizationId: string): Promise<void> {
    await withDb((db) =>
      db.entityLink.delete({
        where: { id, organizationId },
      })
    );
  },

  /**
   * Delete all links referencing an entity (as source or target).
   */
  async deleteAllLinks(
    organizationId: string,
    entityId: string,
    entityType: EntityType
  ): Promise<void> {
    await withDb((db) =>
      db.entityLink.deleteMany({
        where: {
          organizationId,
          OR: [
            { sourceId: entityId, sourceType: entityType },
            { targetId: entityId, targetType: entityType },
          ],
        },
      })
    );
  },
};

export type AnnotatedLink = { link: EntityLink; fromEntityId: string };

type QueueEntry = { id: string; type: EntityType; depth: number };

/**
 * Given a link and the entity that was the "known" side, return the other side.
 */
function getOtherSide(
  link: EntityLink,
  fromEntityId: string
): { id: string; type: EntityType } {
  if (link.sourceId === fromEntityId) {
    return { id: link.targetId, type: link.targetType };
  }
  return { id: link.sourceId, type: link.sourceType };
}

function enqueueNeighbors(
  link: EntityLink,
  current: QueueEntry,
  visitedEntities: Set<string>,
  queue: QueueEntry[]
): void {
  const neighbors: { id: string; type: EntityType }[] = [];
  if (link.sourceId === current.id && link.sourceType === current.type) {
    neighbors.push({ id: link.targetId, type: link.targetType });
  }
  if (link.targetId === current.id && link.targetType === current.type) {
    neighbors.push({ id: link.sourceId, type: link.sourceType });
  }

  for (const neighbor of neighbors) {
    const key = `${neighbor.id}:${neighbor.type}`;
    if (!visitedEntities.has(key)) {
      visitedEntities.add(key);
      queue.push({
        id: neighbor.id,
        type: neighbor.type,
        depth: current.depth + 1,
      });
    }
  }
}
