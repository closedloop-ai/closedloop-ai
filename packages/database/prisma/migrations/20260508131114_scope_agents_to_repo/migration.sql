/*
  Warnings:

  - A unique constraint covering the columns `[organization_id,source_repo,role]` on the table `agents` will be added. If there are existing duplicate values, this will fail.
  - Made the column `source_repo` on table `agents` required. This step will fail if there are existing NULL values in that column.

*/
-- Backfill existing NULL source_repo values to empty string
UPDATE "agents" SET "source_repo" = '' WHERE "source_repo" IS NULL;

-- DropIndex
DROP INDEX "agents_organization_id_role_key";

-- AlterTable
ALTER TABLE "agents" ALTER COLUMN "source_repo" SET NOT NULL,
ALTER COLUMN "source_repo" SET DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "agents_organization_id_source_repo_role_key" ON "agents"("organization_id", "source_repo", "role");
