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
      case "ARTIFACT": {
        const artifact = await withDb((db) =>
          db.artifact.findUnique({
            where: { id, organizationId },
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
        return { type: "ISSUE", entity: issue };
      }
      case "EXTERNAL_LINK": {
        const link = await withDb((db) =>
          db.externalLink.findUnique({ where: { id, organizationId } })
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

async function assertEntityInOrganization(
  organizationId: string,
  id: string,
  entityType: EntityType
): Promise<void> {
  const exists = await withDb((db) => {
    switch (entityType) {
      case "ARTIFACT":
        return db.artifact.findFirst({
          where: { id, organizationId },
          select: { id: true },
        });
      case "ISSUE":
        return db.issue.findFirst({
          where: { id, organizationId },
          select: { id: true },
        });
      case "EXTERNAL_LINK":
        return db.externalLink.findFirst({
          where: { id, organizationId },
          select: { id: true },
        });
      default:
        return null;
    }
  });

  if (!exists) {
    throw new Error(
      `${entityType} ${id} not found in the authenticated organization`
    );
  }
}
