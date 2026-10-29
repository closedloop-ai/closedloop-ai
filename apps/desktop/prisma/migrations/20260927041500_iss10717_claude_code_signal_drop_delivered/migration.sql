-- ISS-10717: the drop counter's own delivery watermark. `dropped_count` is what
-- this machine has counted; `synced_count` is what the cloud acknowledged, so a
-- row where the two differ is owed a delivery even when no session is dirty.
ALTER TABLE "claude_code_signal_drop" ADD COLUMN "synced_count" BIGINT NOT NULL DEFAULT 0;
