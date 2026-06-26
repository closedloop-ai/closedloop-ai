-- DropIndex (case-sensitive)
DROP INDEX IF EXISTS "tags_organization_id_name_key";

-- CreateIndex (case-insensitive uniqueness)
CREATE UNIQUE INDEX "tags_organization_id_name_ci_key" ON "tags"("organization_id", lower("name"));
