/*
  Warnings:

  - The `@unique` constraint on the column `clerk_id` on the table `users` will be removed. The composite unique constraint on `[clerk_id, organization_id]` remains.
  - A unique constraint covering the columns `[clerk_id,organization_id]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "users_clerk_id_key";

-- CreateIndex
CREATE INDEX "users_clerk_id_idx" ON "users"("clerk_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_clerk_id_organization_id_key" ON "users"("clerk_id", "organization_id");

-- RenameIndex
ALTER INDEX "github_installation_repositories_installation_id_github_repo_id" RENAME TO "github_installation_repositories_installation_id_github_rep_key";
