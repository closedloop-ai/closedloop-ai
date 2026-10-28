-- ISS-8463: the capture table the one-shot unresolvable-PR-stub backfill
-- writes its pre-image into.
--
-- THIS MIGRATION CLEARS NOTHING. It creates an empty table and is safe to
-- deploy on its own. The destructive half is deliberately NOT a migration:
-- `prisma migrate deploy` runs on every deploy, and this backfill steps the
-- org-wide delivery-coverage KPI (ISS-8263), so it must be an announced
-- operator action rather than a side effect of shipping code. It lives in
-- `apps/api/scripts/backfill-unresolvable-pr-stubs.ts`, is dry-run by default,
-- and must not be run before ISS-8462 / PR #6214 has landed.

-- CreateTable
CREATE TABLE "pull_request_verification_stamp_backfill" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "pull_request_detail_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "prior_last_verified_at" TIMESTAMP(3) NOT NULL,
    "prior_pr_state" "GitHubPRState" NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reverted_at" TIMESTAMP(3),

    CONSTRAINT "pull_request_verification_stamp_backfill_pkey" PRIMARY KEY ("id")
);

-- index-lock-ok(pull_request_verification_stamp_backfill): table is created empty in this same migration so both indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "pr_verification_stamp_backfill_run_idx" ON "pull_request_verification_stamp_backfill"("run_id", "reverted_at");

-- index-lock-ok(pull_request_verification_stamp_backfill): table is created empty in this same migration so both indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "pr_verification_stamp_backfill_detail_idx" ON "pull_request_verification_stamp_backfill"("pull_request_detail_id");

-- AddForeignKey
ALTER TABLE "pull_request_verification_stamp_backfill" ADD CONSTRAINT "pull_request_verification_stamp_backfill_pull_request_deta_fkey" FOREIGN KEY ("pull_request_detail_id") REFERENCES "pull_request_detail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_request_verification_stamp_backfill" ADD CONSTRAINT "pull_request_verification_stamp_backfill_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
