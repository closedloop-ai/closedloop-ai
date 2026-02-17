import type {
  CreateEntityLinkInput,
  EntityLink,
  EntityType,
  LinkType,
  ResolvedEntity,
} from "@repo/api/src/types/entity-link";
import type { ExternalLink } from "@repo/api/src/types/external-link";
import { Prisma, withDb } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";

export const entityLinksService = {
  createLink(input: CreateEntityLinkInput): Promise<EntityLink> {
    return withDb((db) =>
      db.entityLink.create({
        data: {
          ...input,
          metadata: input.metadata ?? Prisma.DbNull,
        },
      })
    ) as Promise<EntityLink>;
  },

  findLinks(
    entityId: string,
    entityType: EntityType,
    linkType?: LinkType
  ): Promise<EntityLink[]> {
    return withDb((db) =>
      db.entityLink.findMany({
        where: {
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
    entityId: string,
    entityType: EntityType,
    linkType?: LinkType
  ): Promise<EntityLink[]> {
    return withDb((db) =>
      db.entityLink.findMany({
        where: {
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
    entityId: string,
    entityType: EntityType,
    linkType?: LinkType
  ): Promise<EntityLink[]> {
    return withDb((db) =>
      db.entityLink.findMany({
        where: {
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
    id: string,
    entityType: EntityType
  ): Promise<ResolvedEntity | null> {
    switch (entityType) {
      case "ARTIFACT": {
        const artifact = await withDb((db) =>
          db.artifact.findUnique({
            where: { id },
            include: {
              owner: basicUserSelect,
              approver: basicUserSelect,
            },
          })
        );
        if (!artifact) {
          return null;
        }
        return { type: "ARTIFACT", entity: artifact };
      }
      case "ISSUE": {
        const issue = await withDb((db) =>
          db.issue.findUnique({
            where: { id },
            include: {
              assignee: basicUserSelect,
              createdBy: basicUserSelect,
            },
          })
        );
        if (!issue) {
          return null;
        }
        return { type: "ISSUE", entity: issue };
      }
      case "EXTERNAL_LINK": {
        const link = await withDb((db) =>
          db.externalLink.findUnique({ where: { id } })
        );
        if (!link) {
          return null;
        }
        return {
          type: "EXTERNAL_LINK",
          entity: link as ExternalLink,
        };
      }
      default:
        return null;
    }
  },

  async deleteLink(id: string): Promise<void> {
    await withDb((db) => db.entityLink.delete({ where: { id } }));
  },

  /**
   * Delete all links referencing an entity (as source or target).
   */
  async deleteAllLinks(
    entityId: string,
    entityType: EntityType
  ): Promise<void> {
    await withDb((db) =>
      db.entityLink.deleteMany({
        where: {
          OR: [
            { sourceId: entityId, sourceType: entityType },
            { targetId: entityId, targetType: entityType },
          ],
        },
      })
    );
  },
};
