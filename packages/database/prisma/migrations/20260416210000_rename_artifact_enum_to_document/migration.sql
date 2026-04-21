-- Rename the legacy "ARTIFACT" enum value to "DOCUMENT" on both EntityType
-- and CustomFieldEntityType. The Prisma schema no longer uses @map, so the
-- DB label must match the Prisma identifier.

ALTER TYPE "EntityType" RENAME VALUE 'ARTIFACT' TO 'DOCUMENT';
ALTER TYPE "CustomFieldEntityType" RENAME VALUE 'ARTIFACT' TO 'DOCUMENT';
