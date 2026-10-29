-- CreateTable
CREATE TABLE "project_rank_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actor_user_id" UUID,
    "rank_epoch" TEXT NOT NULL,
    -- NOT NULL: Prisma types `orderedArtifactIds` as a non-optional `String[]`
    -- and emits array columns without the constraint, so a NULL written by any
    -- other route would read back as `null` through a `string[]` annotation and
    -- replay an empty order. Postgres refuses it instead.
    "ordered_artifact_ids" UUID[] NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_rank_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- index-lock-ok(project_rank_events): table is created empty in this same migration so both the created-at read index and the idempotency-key unique build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "project_rank_events_project_id_created_at_idx" ON "project_rank_events"("project_id", "created_at");

-- CreateIndex
-- index-lock-ok(project_rank_events): table is created empty in this same migration so both the created-at read index and the idempotency-key unique build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "project_rank_events_organization_id_project_id_idempotency__key" ON "project_rank_events"("organization_id", "project_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "project_rank_events" ADD CONSTRAINT "project_rank_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
