-- ISS-11322: fold the six cut `claude_code_*` families into the cloud rollup.
--
-- ISS-10717 carried eight of the fourteen signal families. Three of the six it
-- cut are drop-in counts and are added below as such. The other three could not
-- be counts and are carried as their actual measurement:
--
--   * active_time      -> summed seconds, per activity_type (own table)
--   * lines_of_code    -> summed line_count, per (model, change_type) (own table)
--   * session_identity -> its dimensions, on the rollup row (identity_* columns)
--
-- Every count column added here is NULLABLE WITH NO DEFAULT for the same reason
-- as the eight before it: NULL means the recording machine never recorded that
-- family, 0 means it measured the family and this session produced none.
-- Defaulting to 0 would state a measured absence that was never observed.
--
-- The three `*_recorded` booleans exist because "never recorded on this machine"
-- is NOT derivable from the stored rows. A rollup row exists for any session with
-- ANY of the fourteen families, so an absent breakdown and a measured-empty one
-- would both be zero rows, and an identity row whose every dimension is NULL
-- would be indistinguishable from no identity row at all. FALSE means the family
-- was never recorded; TRUE with nothing stored is a measurement. They default
-- FALSE so a row written by a pre-ISS-11322 build reads as never-recorded, which
-- is the truthful answer for it.
--
-- The two user-account columns of `claude_code_session_identity` are deliberately
-- NOT synced: they identify a person rather than describe the run.

-- AlterTable
ALTER TABLE "claude_code_session_telemetry"
  ADD COLUMN "auth_event_count" INTEGER,
  ADD COLUMN "plugin_event_count" INTEGER,
  ADD COLUMN "session_start_count" INTEGER,
  ADD COLUMN "active_time_truncated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lines_of_code_truncated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "active_time_recorded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lines_of_code_recorded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "identity_recorded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "identity_organization_id" TEXT,
  ADD COLUMN "identity_source" TEXT,
  ADD COLUMN "identity_terminal_type" TEXT,
  ADD COLUMN "identity_app_version" TEXT,
  ADD COLUMN "identity_app_entrypoint" TEXT;

-- CreateTable
CREATE TABLE "claude_code_active_time_telemetry" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "activity_type" TEXT NOT NULL,
    "seconds" DECIMAL(14,3) NOT NULL,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claude_code_active_time_telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claude_code_lines_of_code_telemetry" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "change_type" TEXT NOT NULL,
    "line_count" BIGINT NOT NULL,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claude_code_lines_of_code_telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- index-lock-ok(claude_code_active_time_telemetry): table is created empty in this same migration so its identity unique and cascade-support lookup index both build against zero rows with no concurrent writer; the unique is the ingest upsert's ON CONFLICT target and must exist before the first write, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "claude_code_active_time_telemetry_artifact_type" ON "claude_code_active_time_telemetry"("artifact_id", "activity_type");

-- CreateIndex
-- index-lock-ok(claude_code_active_time_telemetry): table is created empty in this same migration so its identity unique and cascade-support lookup index both build against zero rows with no concurrent writer; the unique is the ingest upsert's ON CONFLICT target and must exist before the first write, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "claude_code_active_time_telemetry_artifact_id_idx" ON "claude_code_active_time_telemetry"("artifact_id");

-- CreateIndex
-- index-lock-ok(claude_code_lines_of_code_telemetry): table is created empty in this same migration so its identity unique and cascade-support lookup index both build against zero rows with no concurrent writer; the unique is the ingest upsert's ON CONFLICT target and must exist before the first write, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "claude_code_lines_of_code_telemetry_artifact_key" ON "claude_code_lines_of_code_telemetry"("artifact_id", "model", "change_type");

-- CreateIndex
-- index-lock-ok(claude_code_lines_of_code_telemetry): table is created empty in this same migration so its identity unique and cascade-support lookup index both build against zero rows with no concurrent writer; the unique is the ingest upsert's ON CONFLICT target and must exist before the first write, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "claude_code_lines_of_code_telemetry_artifact_id_idx" ON "claude_code_lines_of_code_telemetry"("artifact_id");

-- AddForeignKey
ALTER TABLE "claude_code_active_time_telemetry" ADD CONSTRAINT "claude_code_active_time_telemetry_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claude_code_lines_of_code_telemetry" ADD CONSTRAINT "claude_code_lines_of_code_telemetry_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;
