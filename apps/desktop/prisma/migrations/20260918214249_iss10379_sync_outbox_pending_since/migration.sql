ALTER TABLE "agent_session_sync_outbox" ADD COLUMN "pending_since" TEXT;
ALTER TABLE "agent_component_invocation_sync_outbox" ADD COLUMN "pending_since" TEXT;

-- Existing pending rows have no trustworthy last-transition timestamp, so age
-- measurement begins when this schema becomes available.
UPDATE "agent_session_sync_outbox"
SET "pending_since" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE "status" = 'pending';

UPDATE "agent_component_invocation_sync_outbox"
SET "pending_since" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE "status" = 'pending';
