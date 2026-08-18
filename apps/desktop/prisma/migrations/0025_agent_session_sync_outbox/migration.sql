-- FEA-3473 (PRD-536): durable per-session metadata-sync OUTBOX. One row per
-- session enqueued for the local→cloud metadata lane but not yet acked, keyed
-- by (source_key, external_session_id) — the same target-scoped source_key
-- space as `sync_state`. Advanced/cleared ONLY on a verified server ack (mirrors
-- `transcript_sync_state`), so a kill mid-backfill re-uploads only un-acked
-- sessions on restart instead of the whole corpus. Additive; existing installs
-- apply only this migration (IF NOT EXISTS makes a re-run a no-op). No FK to
-- `sessions` — a row may outlive a locally-deleted session (the AC-2 straggler
-- the outbox records rather than silently drops), and it is a pure cache/queue
-- over server-authoritative state.

-- CreateTable
CREATE TABLE IF NOT EXISTS "agent_session_sync_outbox" (
    "source_key" TEXT NOT NULL,
    "external_session_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sync_class" TEXT NOT NULL DEFAULT 'backfill',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TEXT,
    "last_error" TEXT,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,

    PRIMARY KEY ("source_key", "external_session_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_agent_session_sync_outbox_ready" ON "agent_session_sync_outbox"("source_key", "status", "next_attempt_at");
