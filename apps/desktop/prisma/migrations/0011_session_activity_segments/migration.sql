-- FEA-2267 (PRD-488): persisted per-session activity-segment tiling +
-- versioned-backfill high-water-mark. Both tables are additive; existing
-- installs apply only this migration (IF NOT EXISTS makes a re-run a no-op).

-- CreateTable
CREATE TABLE IF NOT EXISTS "session_activity_segments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "start_ms" BIGINT NOT NULL,
    "end_ms" BIGINT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 1,
    "evidence_layers" JSONB NOT NULL DEFAULT [],
    "version" INTEGER NOT NULL,
    "work_item_ref" TEXT,
    "observed_at" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "activity_segment_backfill_seen" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "file_path" TEXT,
    "file_mtime_ms" BIGINT,
    "classifier_version" INTEGER NOT NULL,
    "scanned_at" TEXT,
    CONSTRAINT "activity_segment_backfill_seen_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_session_activity_segments_session_start" ON "session_activity_segments"("session_id", "start_ms");
