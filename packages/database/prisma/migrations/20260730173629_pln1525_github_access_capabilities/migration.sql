-- AlterTable
ALTER TABLE "github_user_connections" ADD COLUMN     "backoff_until" TIMESTAMP(3),
ADD COLUMN     "health_state" TEXT NOT NULL DEFAULT 'healthy',
ADD COLUMN     "observed_limit" INTEGER,
ADD COLUMN     "observed_remaining" INTEGER,
ADD COLUMN     "observed_reset_at" TIMESTAMP(3),
ADD COLUMN     "rate_limit_tier" INTEGER,
ADD COLUMN     "window_spend" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "github_access_capabilities" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "github_user_connection_id" UUID NOT NULL,
    "target_owner" TEXT NOT NULL,
    "normalized_target_owner" TEXT NOT NULL,
    "target_repo" TEXT,
    "credential_kind" TEXT NOT NULL,
    "denial_reason" TEXT,
    "installation_id" TEXT,
    "checked_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_access_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Full FK-support indexes: the partial uniques below cannot serve
-- predicate-less lookups (revocation deleteMany by connection, org/connection
-- cascade deletes), which would otherwise seq-scan as the cache grows.
CREATE INDEX "github_access_capabilities_github_user_connection_id_idx" ON "github_access_capabilities"("github_user_connection_id");

-- CreateIndex
CREATE INDEX "github_access_capabilities_organization_id_idx" ON "github_access_capabilities"("organization_id");

-- CreateIndex
CREATE INDEX "github_access_capabilities_normalized_target_owner_idx" ON "github_access_capabilities"("normalized_target_owner");

-- CreateIndex
CREATE INDEX "github_access_capabilities_expires_at_idx" ON "github_access_capabilities"("expires_at");

-- AddForeignKey
ALTER TABLE "github_access_capabilities" ADD CONSTRAINT "github_access_capabilities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_access_capabilities" ADD CONSTRAINT "github_access_capabilities_github_user_connection_id_fkey" FOREIGN KEY ("github_user_connection_id") REFERENCES "github_user_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex (manual — PLN-1525)
-- Row identity for capability verdicts. Prisma cannot express partial unique
-- indexes, and a plain unique over the nullable "target_repo" would not
-- enforce owner-level uniqueness (Postgres treats NULLs as distinct), so two
-- partial uniques split the identity by row kind (mirrors the
-- distribution_target_status / desktop_commands partial-unique pattern):
--   * owner-level rows (target_repo IS NULL) — verdicts for owner-only
--     (repo-less) targets, one per (connection, owner);
--   * repo-level rows (target_repo IS NOT NULL) — verdicts for repo-bearing
--     targets in both lanes, one per (connection, owner, repo).
-- The capability-store write helper relies on these for its
-- create-catch-P2002-update path. Brand-new table, so no preflight of
-- existing rows is needed.
CREATE UNIQUE INDEX "github_access_capabilities_conn_owner_key" ON "github_access_capabilities"("github_user_connection_id", "normalized_target_owner") WHERE "target_repo" IS NULL;

-- CreateIndex (manual — PLN-1525, see above)
CREATE UNIQUE INDEX "github_access_capabilities_conn_owner_repo_key" ON "github_access_capabilities"("github_user_connection_id", "normalized_target_owner", "target_repo") WHERE "target_repo" IS NOT NULL;
