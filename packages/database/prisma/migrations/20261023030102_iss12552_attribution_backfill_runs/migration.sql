-- CreateTable
CREATE TABLE "attribution_backfill_runs" (
    "id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "extractor_version" INTEGER NOT NULL,
    "organization_id" UUID,
    "cursor" UUID,
    "status" TEXT NOT NULL,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attribution_backfill_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- index-lock-ok(attribution_backfill_runs): table is created empty in this same migration so its indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "attribution_backfill_runs_versions_status_idx" ON "attribution_backfill_runs"("policy_version", "extractor_version", "organization_id", "status");
