-- ISS-10717: the dropped-signal counter behind the completeness signal.
CREATE TABLE IF NOT EXISTS "claude_code_signal_drop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "harness" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "dropped_count" BIGINT NOT NULL DEFAULT 0,
    "first_observed_at" TEXT NOT NULL,
    "last_observed_at" TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_signal_drop_natural" ON "claude_code_signal_drop"("harness", "reason");

-- ISS-10717: the telemetry lane's delivered watermark, advanced only on a
-- verified cloud ack.
CREATE TABLE IF NOT EXISTS "claude_code_telemetry_sync_cursor" (
    "source_key" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "synced_observed_to" TEXT NOT NULL,
    "rejected_attempts" INTEGER NOT NULL DEFAULT 0,
    "deferred_attempts" INTEGER NOT NULL DEFAULT 0,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "last_error" TEXT,
    "updated_at" TEXT NOT NULL,

    PRIMARY KEY ("source_key", "session_id")
);
