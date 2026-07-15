-- Pack authoring (component container): link child component CatalogItems to
-- their parent Pack. Additive + nullable; cascade so archiving/deleting a Pack
-- removes its authored components. Generated offline via `prisma migrate diff`
-- (no local DB in this env); applied by `prisma migrate deploy` in CI/prod.

-- AlterTable
ALTER TABLE "catalog_items" ADD COLUMN     "parent_pack_id" UUID;

-- CreateIndex
CREATE INDEX "catalog_items_parent_pack_id_idx" ON "catalog_items"("parent_pack_id");

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_parent_pack_id_fkey" FOREIGN KEY ("parent_pack_id") REFERENCES "catalog_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
