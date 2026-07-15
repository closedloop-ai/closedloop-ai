-- FEA-2715 (PRD-512 / PLN-1288): per-transcript-file fingerprint + upload cursor
-- for the raw-transcript archive lane. Additive; existing installs apply only
-- this migration (IF NOT EXISTS makes a re-run a no-op). No FK to `sessions` —
-- a transcript may be discovered before its session row exists, and the store
-- is a pure cache/queue over server-authoritative state (recovery invariant 2).

-- CreateTable
CREATE TABLE IF NOT EXISTS "transcript_sync_state" (
    "external_session_id" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "source_harness" TEXT NOT NULL,
    "source_path" TEXT NOT NULL,
    "source_path_hash" TEXT NOT NULL,
    "last_mtime_ms" BIGINT,
    "last_size" BIGINT,
    "synced_byte_offset" BIGINT NOT NULL DEFAULT 0,
    "synced_sha256" TEXT,
    "stored_etag" TEXT,
    "synced_compute_target_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "sync_class" TEXT NOT NULL DEFAULT 'live',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TEXT,
    "last_error" TEXT,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,

    PRIMARY KEY ("external_session_id", "file_key")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_transcript_sync_state_status_next" ON "transcript_sync_state"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_transcript_sync_state_class_status" ON "transcript_sync_state"("sync_class", "status");
