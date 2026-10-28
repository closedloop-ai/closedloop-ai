-- ISS-8591/ISS-8592/ISS-8606: split invocation-part durability state into
-- row-attributable permanent retries, lane-wide stall timing, and bounded
-- dead-letter recovery cycles.
ALTER TABLE "agent_component_invocation_sync_outbox" ADD COLUMN "permanent_attempt_count" INTEGER;
ALTER TABLE "agent_component_invocation_sync_outbox" ADD COLUMN "lane_stalled_since" TEXT;
ALTER TABLE "agent_component_invocation_sync_outbox" ADD COLUMN "dead_letter_recovery_count" INTEGER;
