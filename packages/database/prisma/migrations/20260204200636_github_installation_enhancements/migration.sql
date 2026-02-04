-- CreateEnum
CREATE TYPE "GitHubInstallationStatus" AS ENUM ('PENDING_CLAIM', 'ACTIVE', 'SUSPENDED', 'REMOVED', 'UNINSTALLED');

-- AlterTable: Make organization_id nullable and add new columns
ALTER TABLE "github_installations" ALTER COLUMN "organization_id" DROP NOT NULL;

ALTER TABLE "github_installations" ADD COLUMN "account_id" INTEGER;
ALTER TABLE "github_installations" ADD COLUMN "sender_login" TEXT;
ALTER TABLE "github_installations" ADD COLUMN "sender_id" INTEGER;
ALTER TABLE "github_installations" ADD COLUMN "status" "GitHubInstallationStatus" NOT NULL DEFAULT 'PENDING_CLAIM';
ALTER TABLE "github_installations" ADD COLUMN "permissions" JSONB;
ALTER TABLE "github_installations" ADD COLUMN "events" JSONB;
ALTER TABLE "github_installations" ADD COLUMN "repository_selection" TEXT;
ALTER TABLE "github_installations" ADD COLUMN "suspended_at" TIMESTAMP(3);
ALTER TABLE "github_installations" ADD COLUMN "suspended_by" TEXT;
ALTER TABLE "github_installations" ADD COLUMN "claimed_at" TIMESTAMP(3);
ALTER TABLE "github_installations" ADD COLUMN "claimed_by_user_id" UUID;

-- Backfill existing rows: Set account_id from installation_id, sender fields to placeholder values
-- (Existing rows must have these required fields populated)
UPDATE "github_installations" SET
    "account_id" = "installation_id",
    "sender_login" = 'unknown',
    "sender_id" = 0
WHERE "account_id" IS NULL;

-- Now make the required columns NOT NULL
ALTER TABLE "github_installations" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "github_installations" ALTER COLUMN "sender_login" SET NOT NULL;
ALTER TABLE "github_installations" ALTER COLUMN "sender_id" SET NOT NULL;

-- CreateTable: GitHubInstallationRepository
CREATE TABLE "github_installation_repositories" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "github_repo_id" INTEGER NOT NULL,
    "full_name" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_installation_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "github_installations_organization_id_idx" ON "github_installations"("organization_id");

-- CreateIndex
CREATE INDEX "github_installations_status_idx" ON "github_installations"("status");

-- CreateIndex
CREATE INDEX "github_installations_account_id_idx" ON "github_installations"("account_id");

-- CreateIndex
CREATE INDEX "github_installation_repositories_installation_id_idx" ON "github_installation_repositories"("installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_installation_repositories_installation_id_github_repo_id_key" ON "github_installation_repositories"("installation_id", "github_repo_id");
