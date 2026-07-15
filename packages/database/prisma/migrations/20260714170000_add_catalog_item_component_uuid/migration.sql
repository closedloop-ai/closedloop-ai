-- Content-addressed component identity (uuidv5 of source + owner + normalized
-- content). Additive + nullable; the dedup + cloud-analytics join key. Generated
-- offline via `prisma migrate diff` (no local DB in this env); applied by
-- `prisma migrate deploy` in CI/prod.

-- AlterTable
ALTER TABLE "catalog_items" ADD COLUMN     "component_uuid" UUID;

-- CreateIndex
CREATE INDEX "catalog_items_organization_id_component_uuid_idx" ON "catalog_items"("organization_id", "component_uuid");
