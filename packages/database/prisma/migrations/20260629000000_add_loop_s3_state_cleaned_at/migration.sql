-- The loop-state retention sweep (apps/api/app/cron/cleanup-loop-state) purges a
-- terminal loop's S3 state (conversation history, context-pack, event logs,
-- work-dir snapshot) once it is older than the retention horizon. The loop-state
-- bucket has no S3 lifecycle policy, so without this sweep that state — which
-- includes proprietary source from the Claude Code transcript — would persist
-- indefinitely. This column records when a loop's S3 prefix was deleted so the
-- daily cron skips already-purged loops instead of re-listing them every run.
ALTER TABLE "loops" ADD COLUMN "s3_state_cleaned_at" TIMESTAMP(3);

-- Serves the terminal-loop scan the sweep runs daily:
-- `WHERE status IN (...) AND completed_at < $cutoff ORDER BY completed_at`, so it
-- is an index scan rather than a sequential scan that grows with the loops table.
CREATE INDEX "loops_status_completed_at_idx" ON "loops"("status", "completed_at");
