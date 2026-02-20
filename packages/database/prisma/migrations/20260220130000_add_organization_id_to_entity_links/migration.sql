-- Add organization scoping to entity_links for tenant isolation.
ALTER TABLE "entity_links"
ADD COLUMN "organization_id" UUID;

-- Backfill from source entities first, then target entities as fallback.
UPDATE "entity_links" el
SET "organization_id" = a."organization_id"
FROM "artifacts" a
WHERE el."source_type" = 'ARTIFACT'
  AND el."source_id" = a."id"
  AND el."organization_id" IS NULL;

UPDATE "entity_links" el
SET "organization_id" = i."organization_id"
FROM "issues" i
WHERE el."source_type" = 'ISSUE'
  AND el."source_id" = i."id"
  AND el."organization_id" IS NULL;

UPDATE "entity_links" el
SET "organization_id" = ex."organization_id"
FROM "external_links" ex
WHERE el."source_type" = 'EXTERNAL_LINK'
  AND el."source_id" = ex."id"
  AND el."organization_id" IS NULL;

UPDATE "entity_links" el
SET "organization_id" = a."organization_id"
FROM "artifacts" a
WHERE el."target_type" = 'ARTIFACT'
  AND el."target_id" = a."id"
  AND el."organization_id" IS NULL;

UPDATE "entity_links" el
SET "organization_id" = i."organization_id"
FROM "issues" i
WHERE el."target_type" = 'ISSUE'
  AND el."target_id" = i."id"
  AND el."organization_id" IS NULL;

UPDATE "entity_links" el
SET "organization_id" = ex."organization_id"
FROM "external_links" ex
WHERE el."target_type" = 'EXTERNAL_LINK'
  AND el."target_id" = ex."id"
  AND el."organization_id" IS NULL;

CREATE INDEX "entity_links_organization_id_source_id_source_type_link_type_idx"
ON "entity_links" ("organization_id", "source_id", "source_type", "link_type");

CREATE INDEX "entity_links_organization_id_target_id_target_type_link_type_idx"
ON "entity_links" ("organization_id", "target_id", "target_type", "link_type");
