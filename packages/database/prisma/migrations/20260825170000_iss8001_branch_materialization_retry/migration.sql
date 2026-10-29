-- CreateTable
CREATE TABLE "branch_materialization_retries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source_artifact_id" UUID NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "branch_name" TEXT NOT NULL,
    "branch_ref" JSONB NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "reason" VARCHAR(64),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "claim_generation" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_materialization_retries_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "branch_materialization_retries"
ADD CONSTRAINT "branch_materialization_retries_state_check"
CHECK ("state" IN ('pending', 'claimed', 'terminal', 'dead_letter'));

ALTER TABLE "branch_materialization_retries"
ADD CONSTRAINT "branch_materialization_retries_counters_nonnegative_check"
CHECK ("attempts" >= 0 AND "claim_generation" >= 0);

ALTER TABLE "branch_materialization_retries"
ADD CONSTRAINT "branch_materialization_retries_reason_check"
CHECK (
    "reason" IS NULL OR "reason" IN (
        'authority_unavailable',
        'attempts_exhausted',
        'conflicting_authority',
        'corrupt_state',
        'cross_organization',
        'default_branch',
        'identity_mismatch',
        'source_missing'
    )
);

-- CreateIndex
-- index-lock-ok(branch_materialization_retries): table is created empty in this same migration so each required retry identity, due-order, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL
CREATE UNIQUE INDEX IF NOT EXISTS "branch_materialization_retries_identity_key" ON "branch_materialization_retries"("organization_id", "source_artifact_id", "repository_full_name", "branch_name");

-- CreateIndex
-- index-lock-ok(branch_materialization_retries): table is created empty in this same migration so each required retry identity, due-order, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL
CREATE INDEX IF NOT EXISTS "branch_materialization_retries_due_idx" ON "branch_materialization_retries"("state", "next_attempt_at", "created_at");

-- CreateIndex
-- index-lock-ok(branch_materialization_retries): table is created empty in this same migration so each required retry identity, due-order, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL
CREATE INDEX IF NOT EXISTS "branch_materialization_retries_source_artifact_id_idx" ON "branch_materialization_retries"("source_artifact_id");

-- AddForeignKey
ALTER TABLE "branch_materialization_retries" ADD CONSTRAINT "branch_materialization_retries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_materialization_retries" ADD CONSTRAINT "branch_materialization_retries_source_artifact_id_fkey" FOREIGN KEY ("source_artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
