-- Enforce explicit event_id assignment by application code for deterministic replay semantics.
ALTER TABLE "loop_events"
ALTER COLUMN "event_id" DROP DEFAULT;
