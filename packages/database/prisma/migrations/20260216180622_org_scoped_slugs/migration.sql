/*
  Warnings:

  - A unique constraint covering the columns `[organization_id,slug]` on the table `artifacts` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[organization_id,slug]` on the table `issues` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "artifacts_slug_key";

-- DropIndex
DROP INDEX "issues_slug_key";

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_organization_id_slug_key" ON "artifacts"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "issues_organization_id_slug_key" ON "issues"("organization_id", "slug");
