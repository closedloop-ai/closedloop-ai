import { EntityType, withDb } from "@repo/database";

export class EntityOrganizationMismatchError extends Error {
  constructor(entityType: string, id: string) {
    super(`${entityType} ${id} not found in the authenticated organization`);
    this.name = "EntityOrganizationMismatchError";
  }
}

/**
 * Asserts that an entity exists within the given organization.
 * Throws EntityOrganizationMismatchError if the entity is not found.
 */
export async function assertEntityInOrganization(
  organizationId: string,
  entityId: string,
  entityType: EntityType
): Promise<void> {
  const exists = await withDb((db) => {
    switch (entityType) {
      case EntityType.ARTIFACT:
        return db.artifact.findFirst({
          where: { id: entityId, organizationId },
          select: { id: true },
        });
      case EntityType.FEATURE:
        return db.feature.findFirst({
          where: { id: entityId, organizationId },
          select: { id: true },
        });
      case EntityType.EXTERNAL_LINK:
        return db.externalLink.findFirst({
          where: { id: entityId, organizationId },
          select: { id: true },
        });
      default:
        return null;
    }
  });

  if (!exists) {
    throw new EntityOrganizationMismatchError(entityType, entityId);
  }
}
