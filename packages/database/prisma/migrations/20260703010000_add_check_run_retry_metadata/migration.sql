-- Manual SQL is required because Prisma cannot model the CHECK constraints or
-- partial unique index that keep check_run retry metadata bounded to valid
-- states and non-null resource identities.
ALTER TABLE "branch_detail"
  ADD COLUMN "check_run_retry_state" VARCHAR(32),
  ADD COLUMN "check_run_retry_head_sha" TEXT,
  ADD COLUMN "check_run_retry_resource_id" VARCHAR(255),
  ADD COLUMN "check_run_retry_idempotency_key" VARCHAR(255),
  ADD COLUMN "check_run_retry_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "check_run_retry_next_at" TIMESTAMP(3),
  ADD COLUMN "check_run_retry_last_attempt_at" TIMESTAMP(3),
  ADD COLUMN "check_run_retry_reason" VARCHAR(64);

ALTER TABLE "branch_detail"
  ADD CONSTRAINT "branch_detail_check_run_retry_attempts_nonnegative"
  CHECK ("check_run_retry_attempts" >= 0);

ALTER TABLE "branch_detail"
  ADD CONSTRAINT "branch_detail_check_run_retry_state_valid"
  CHECK (
    "check_run_retry_state" IS NULL
    OR "check_run_retry_state" IN ('pending', 'claimed', 'dead_letter')
  );

ALTER TABLE "branch_detail"
  ADD CONSTRAINT "branch_detail_check_run_retry_identity_present"
  CHECK (
    "check_run_retry_state" IS NULL
    OR (
      "check_run_retry_head_sha" IS NOT NULL
      AND "check_run_retry_resource_id" IS NOT NULL
      AND "check_run_retry_idempotency_key" IS NOT NULL
    )
  );

CREATE INDEX "branch_detail_check_run_retry_due_idx"
  ON "branch_detail"("check_run_retry_state", "check_run_retry_next_at");

CREATE INDEX "branch_detail_check_run_retry_repo_head_idx"
  ON "branch_detail"("repository_id", "check_run_retry_head_sha");

CREATE UNIQUE INDEX "branch_detail_check_run_retry_resource_key_idx"
  ON "branch_detail"(
    "artifact_id",
    "repository_id",
    "check_run_retry_head_sha",
    "check_run_retry_resource_id",
    "check_run_retry_idempotency_key"
  )
  WHERE "check_run_retry_state" IS NOT NULL
    AND "check_run_retry_head_sha" IS NOT NULL
    AND "check_run_retry_resource_id" IS NOT NULL
    AND "check_run_retry_idempotency_key" IS NOT NULL;
