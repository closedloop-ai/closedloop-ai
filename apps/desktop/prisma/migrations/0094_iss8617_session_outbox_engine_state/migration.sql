-- ISS-8617 / PRD-699 / PLN-2022 v2: make the session durable outbox own the
-- row-attributable retry budget and dead-letter recovery ladder separately from
-- the environmental attempt tally stored in attempt_count.
ALTER TABLE "agent_session_sync_outbox"
  ADD COLUMN "permanent_attempt_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "agent_session_sync_outbox"
  ADD COLUMN "dead_letter_recovery_count" INTEGER NOT NULL DEFAULT 0;
