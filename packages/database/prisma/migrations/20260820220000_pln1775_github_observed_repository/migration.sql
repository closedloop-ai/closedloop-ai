-- PLN-1775 M0 (ISS-7403): desktop-observed repository candidates for orgs with no
-- GitHub App installation. Purely additive: one new table, no backfill and no
-- change to any existing table. Rows accrue from the next desktop sync.

-- CreateTable
CREATE TABLE "github_observed_repository" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "verification_state" TEXT NOT NULL DEFAULT 'pending',
    "first_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observed_session_count" INTEGER NOT NULL DEFAULT 0,
    "last_verification_attempt_at" TIMESTAMP(3),
    "consecutive_verification_failure_count" INTEGER NOT NULL DEFAULT 0,
    "consecutive_no_access_count" INTEGER NOT NULL DEFAULT 0,
    "next_verification_at" TIMESTAMP(3),
    "denied_reason" VARCHAR(64),
    "github_repo_id" TEXT,
    "owner" TEXT,
    "name" TEXT,
    "html_url" TEXT,
    "is_private" BOOLEAN,
    "last_pushed_at" TIMESTAMP(3),
    "default_branch_name" TEXT,
    "default_branch_availability" VARCHAR(32),
    "default_branch_completeness" VARCHAR(32),
    "default_branch_reason" VARCHAR(64),
    "default_branch_source" VARCHAR(64),
    "default_branch_mechanism" VARCHAR(32),
    "default_branch_trigger" VARCHAR(32),
    "default_branch_credential_type" VARCHAR(32),
    "default_branch_credential_owner_id" UUID,
    "default_branch_observation_key" TEXT,
    "default_branch_observed_at" TIMESTAMP(3),
    "default_branch_event_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_observed_repository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- index-lock-ok(github_observed_repository): table is created empty in this same migration so both the observation identity unique and the verifier's due-query index build lock zero rows before any writer can reach them, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "github_observed_repository_organization_id_repository_full__key" ON "github_observed_repository"("organization_id", "repository_full_name");

-- CreateIndex
-- index-lock-ok(github_observed_repository): table is created empty in this same migration so both the observation identity unique and the verifier's due-query index build lock zero rows before any writer can reach them, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "github_observed_repository_organization_id_verification_sta_idx" ON "github_observed_repository"("organization_id", "verification_state", "next_verification_at");

-- AddForeignKey
ALTER TABLE "github_observed_repository" ADD CONSTRAINT "github_observed_repository_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
