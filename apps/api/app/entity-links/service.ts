import {
  type CreateEntityLinkInput,
  type EntityLink,
  EntityType,
  LinkDirection,
  type LinkedEntity,
  type LinkType,
  type ResolvedEntity,
} from "@repo/api/src/types/entity-link";
import type { ExternalLink } from "@repo/api/src/types/external-link";
import { Prisma, withDb } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";

export const entityLinksService = {
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
    ) as Promise<EntityLink>;
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
    ) as Promise<EntityLink[]>;
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
    ) as Promise<EntityLink[]>;
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
    ) as Promise<EntityLink[]>;
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
      case EntityType.Issue: {
        const issue = await withDb((db) =>
          db.issue.findUnique({
            where: { id, organizationId },
            include: {
              assignee: basicUserSelect,
              createdBy: basicUserSelect,
            },
          })
        );
        if (!issue) {
          return null;
        }
        return { type: EntityType.Issue, entity: issue };
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
          entity: link as ExternalLink,
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

    return annotatedLinks.map(({ link, fromEntityId }) => {
      const other = getOtherSide(link, fromEntityId);
      const key = `${other.id}:${other.type}`;
      return { ...link, resolvedEntity: resolved.get(key) ?? null };
    });
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

export class EntityOrganizationMismatchError extends Error {
  constructor(entityType: EntityType, id: string) {
    super(`${entityType} ${id} not found in the authenticated organization`);
    this.name = "EntityOrganizationMismatchError";
  }
}

export type AnnotatedLink = { link: EntityLink; fromEntityId: string };

async function assertEntityInOrganization(
  organizationId: string,
  id: string,
  entityType: EntityType
): Promise<void> {
  const exists = await withDb((db) => {
    switch (entityType) {
      case EntityType.Artifact:
        return db.artifact.findFirst({
          where: { id, organizationId },
          select: { id: true },
        });
      case EntityType.Issue:
        return db.issue.findFirst({
          where: { id, organizationId },
          select: { id: true },
        });
      case EntityType.ExternalLink:
        return db.externalLink.findFirst({
          where: { id, organizationId },
          select: { id: true },
        });
      default:
        return null;
    }
  });

  if (!exists) {
    throw new EntityOrganizationMismatchError(entityType, id);
  }
}

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
