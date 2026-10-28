-- CreateTable
CREATE TABLE "branch_analytics_session_rollups" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_artifact_id" UUID NOT NULL,
    "session_artifact_id" UUID NOT NULL,
    "branch_participation" VARCHAR(32) NOT NULL,
    "branch_participation_method" TEXT,
    "source" VARCHAR(64) NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "bucket_end" TIMESTAMP(3) NOT NULL,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_write_tokens" BIGINT NOT NULL DEFAULT 0,
    "estimated_cost" DECIMAL(14,6),
    "min_input_tokens" BIGINT,
    "min_output_tokens" BIGINT,
    "min_cache_read_tokens" BIGINT,
    "min_cache_write_tokens" BIGINT,
    "min_estimated_cost" DECIMAL(14,6),
    "estimated_cost_event_count" INTEGER NOT NULL DEFAULT 0,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "source_min_event_created_at" TIMESTAMP(3) NOT NULL,
    "source_max_event_created_at" TIMESTAMP(3) NOT NULL,
    "as_of" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_analytics_session_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_analytics_rollup_states" (
    "organization_id" UUID NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "source_watermark_event_created_at" TIMESTAMP(3),
    "materialized_through_event_created_at" TIMESTAMP(3),
    "as_of" TIMESTAMP(3),
    "lag_seconds" INTEGER,
    "backfill_cursor_created_at" TIMESTAMP(3),
    "backfill_cursor_event_id" UUID,
    "backfill_completed_at" TIMESTAMP(3),
    "last_backfill_started_at" TIMESTAMP(3),
    "last_backfill_completed_at" TIMESTAMP(3),
    "last_error_at" TIMESTAMP(3),
    "last_error_code" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_analytics_rollup_states_pkey" PRIMARY KEY ("organization_id")
);

-- CreateIndex
-- index-lock-ok(branch_analytics_session_rollups): table is created empty in this same migration so each required rollup identity, read, watermark, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "branch_analytics_session_rollups_session_bucket_idx" ON "branch_analytics_session_rollups"("organization_id", "session_artifact_id", "source", "bucket_start");

-- CreateIndex
-- index-lock-ok(branch_analytics_session_rollups): table is created empty in this same migration so each required rollup identity, read, watermark, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "branch_analytics_session_rollups_branch_bucket_idx" ON "branch_analytics_session_rollups"("organization_id", "branch_artifact_id", "bucket_start");

-- CreateIndex
-- index-lock-ok(branch_analytics_session_rollups): table is created empty in this same migration so each required rollup identity, read, watermark, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "branch_analytics_session_rollups_session_artifact_id_idx" ON "branch_analytics_session_rollups"("session_artifact_id");

-- CreateIndex
-- index-lock-ok(branch_analytics_session_rollups): table is created empty in this same migration so each required rollup identity, read, watermark, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "branch_analytics_session_rollups_source_watermark_idx" ON "branch_analytics_session_rollups"("organization_id", "source_max_event_created_at");

-- CreateIndex
-- index-lock-ok(branch_analytics_session_rollups): table is created empty in this same migration so each required rollup identity, read, watermark, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "branch_analytics_session_rollups_org_source_as_of_idx" ON "branch_analytics_session_rollups"("organization_id", "source", "as_of");

-- CreateIndex
-- index-lock-ok(branch_analytics_session_rollups): table is created empty in this same migration so each required rollup identity, read, watermark, and cascade-support index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "branch_analytics_session_rollups_identity_key" ON "branch_analytics_session_rollups"("organization_id", "branch_artifact_id", "session_artifact_id", "branch_participation", "source", "bucket_start");

-- CreateIndex
-- index-lock-ok(branch_analytics_rollup_states): table is created empty in this same migration so the due-query index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "branch_analytics_rollup_states_due_idx" ON "branch_analytics_rollup_states"("state", "materialized_through_event_created_at");

-- AddForeignKey
ALTER TABLE "branch_analytics_session_rollups" ADD CONSTRAINT "branch_analytics_session_rollups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_analytics_session_rollups" ADD CONSTRAINT "branch_analytics_session_rollups_branch_fkey" FOREIGN KEY ("organization_id", "branch_artifact_id") REFERENCES "branch_detail"("organization_id", "artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_analytics_session_rollups" ADD CONSTRAINT "branch_analytics_session_rollups_session_artifact_id_fkey" FOREIGN KEY ("session_artifact_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_analytics_rollup_states" ADD CONSTRAINT "branch_analytics_rollup_states_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
