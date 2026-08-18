-- ISS-5826: additive, nullable repository-default authority snapshots.
-- Historical rows intentionally remain NULL; no default, backfill, cleanup, or
-- remediation is performed by this migration.

-- AlterTable
ALTER TABLE "github_installation_repositories" ADD COLUMN     "default_branch_availability" VARCHAR(32),
ADD COLUMN     "default_branch_completeness" VARCHAR(32),
ADD COLUMN     "default_branch_credential_owner_id" UUID,
ADD COLUMN     "default_branch_credential_type" VARCHAR(32),
ADD COLUMN     "default_branch_event_at" TIMESTAMP(3),
ADD COLUMN     "default_branch_mechanism" VARCHAR(32),
ADD COLUMN     "default_branch_name" TEXT,
ADD COLUMN     "default_branch_observation_key" TEXT,
ADD COLUMN     "default_branch_observed_at" TIMESTAMP(3),
ADD COLUMN     "default_branch_reason" VARCHAR(64),
ADD COLUMN     "default_branch_source" VARCHAR(64),
ADD COLUMN     "default_branch_trigger" VARCHAR(32);

-- AlterTable
ALTER TABLE "public_repositories" ADD COLUMN     "default_branch_availability" VARCHAR(32),
ADD COLUMN     "default_branch_completeness" VARCHAR(32),
ADD COLUMN     "default_branch_credential_owner_id" UUID,
ADD COLUMN     "default_branch_credential_type" VARCHAR(32),
ADD COLUMN     "default_branch_event_at" TIMESTAMP(3),
ADD COLUMN     "default_branch_mechanism" VARCHAR(32),
ADD COLUMN     "default_branch_name" TEXT,
ADD COLUMN     "default_branch_observation_key" TEXT,
ADD COLUMN     "default_branch_observed_at" TIMESTAMP(3),
ADD COLUMN     "default_branch_reason" VARCHAR(64),
ADD COLUMN     "default_branch_source" VARCHAR(64),
ADD COLUMN     "default_branch_trigger" VARCHAR(32);

-- AlterTable
ALTER TABLE "pull_request_detail" ADD COLUMN     "head_repository_default_branch_availability" VARCHAR(32),
ADD COLUMN     "head_repository_default_branch_completeness" VARCHAR(32),
ADD COLUMN     "head_repository_default_branch_credential_owner_id" UUID,
ADD COLUMN     "head_repository_default_branch_credential_type" VARCHAR(32),
ADD COLUMN     "head_repository_default_branch_event_at" TIMESTAMP(3),
ADD COLUMN     "head_repository_default_branch_mechanism" VARCHAR(32),
ADD COLUMN     "head_repository_default_branch_name" TEXT,
ADD COLUMN     "head_repository_default_branch_observation_key" TEXT,
ADD COLUMN     "head_repository_default_branch_observed_at" TIMESTAMP(3),
ADD COLUMN     "head_repository_default_branch_reason" VARCHAR(64),
ADD COLUMN     "head_repository_default_branch_source" VARCHAR(64),
ADD COLUMN     "head_repository_default_branch_trigger" VARCHAR(32),
ADD COLUMN     "head_repository_full_name" TEXT,
ADD COLUMN     "head_repository_github_id" TEXT;

-- CreateTable
CREATE TABLE "repository_default_observation_receipts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "target_kind" VARCHAR(64) NOT NULL,
    "target_id" TEXT NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "observation_key" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_default_observation_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repo_default_observation_receipt_dedupe_key" UNIQUE ("organization_id", "target_kind", "target_id", "source", "observation_key")
);

-- AddForeignKey
ALTER TABLE "repository_default_observation_receipts" ADD CONSTRAINT "repo_default_observation_receipt_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
