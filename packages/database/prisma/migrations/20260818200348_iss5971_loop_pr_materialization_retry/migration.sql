-- CreateTable
CREATE TABLE "pr_materialization_retries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "loop_id" UUID NOT NULL,
    "source_artifact_id" UUID NOT NULL,
    "base_repository_id" UUID NOT NULL,
    "pull_request_number" INTEGER NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "reason" VARCHAR(64),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "claim_generation" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pr_materialization_retries_pkey" PRIMARY KEY ("id")
);

-- Prisma cannot express CHECK constraints; reject invalid provider PR identities
-- at the storage boundary as well as in the TypeScript enqueue path.
ALTER TABLE "pr_materialization_retries"
ADD CONSTRAINT "pr_materialization_retries_pull_request_number_positive_check"
CHECK ("pull_request_number" > 0);

ALTER TABLE "pr_materialization_retries"
ADD CONSTRAINT "pr_materialization_retries_state_check"
CHECK ("state" IN ('pending', 'claimed', 'terminal', 'dead_letter'));

ALTER TABLE "pr_materialization_retries"
ADD CONSTRAINT "pr_materialization_retries_counters_nonnegative_check"
CHECK ("attempts" >= 0 AND "claim_generation" >= 0);

ALTER TABLE "pr_materialization_retries"
ADD CONSTRAINT "pr_materialization_retries_reason_check"
CHECK (
    "reason" IS NULL OR "reason" IN (
        'provider_unavailable',
        'provider_rate_limit',
        'attempts_exhausted',
        'corrupt_state',
        'source_conflict',
        'authorization_lost',
        'repository_removed',
        'installation_inactive',
        'installation_missing',
        'cross_organization',
        'pull_request_not_found',
        'credential_unauthorized',
        'permission_denied'
    )
);

-- CreateIndex
-- index-lock-ok(pr_materialization_retries): table is created empty in this same migration so each required retry identity, due-order, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL
CREATE INDEX IF NOT EXISTS "pr_materialization_retries_due_idx" ON "pr_materialization_retries"("state", "next_attempt_at", "created_at");

-- CreateIndex
-- index-lock-ok(pr_materialization_retries): table is created empty in this same migration so each required retry identity, due-order, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL
CREATE INDEX IF NOT EXISTS "pr_materialization_retries_loop_id_idx" ON "pr_materialization_retries"("loop_id");

-- CreateIndex
-- index-lock-ok(pr_materialization_retries): table is created empty in this same migration so each required retry identity, due-order, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL
CREATE INDEX IF NOT EXISTS "pr_materialization_retries_source_artifact_id_idx" ON "pr_materialization_retries"("source_artifact_id");

-- CreateIndex
-- index-lock-ok(pr_materialization_retries): table is created empty in this same migration so each required retry identity, due-order, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL
CREATE INDEX IF NOT EXISTS "pr_materialization_retries_base_repository_id_idx" ON "pr_materialization_retries"("base_repository_id");

-- CreateIndex
-- index-lock-ok(pr_materialization_retries): table is created empty in this same migration so each required retry identity, due-order, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL
CREATE UNIQUE INDEX IF NOT EXISTS "pr_materialization_retries_identity_key" ON "pr_materialization_retries"("organization_id", "loop_id", "base_repository_id", "pull_request_number");

-- AddForeignKey
ALTER TABLE "pr_materialization_retries" ADD CONSTRAINT "pr_materialization_retries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_materialization_retries" ADD CONSTRAINT "pr_materialization_retries_loop_id_fkey" FOREIGN KEY ("loop_id") REFERENCES "loops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_materialization_retries" ADD CONSTRAINT "pr_materialization_retries_source_artifact_id_fkey" FOREIGN KEY ("source_artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_materialization_retries" ADD CONSTRAINT "pr_materialization_retries_base_repository_id_fkey" FOREIGN KEY ("base_repository_id") REFERENCES "github_installation_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
