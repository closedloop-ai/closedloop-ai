-- ISS-9182: the durable ack-omitted cycle budget. Existing rows start at 0 so a
-- row already dead-lettered before this column existed keeps the full allowance
-- the boot re-pend has always granted it.
ALTER TABLE "agent_session_sync_outbox" ADD COLUMN "ack_omitted_cycle_count" INTEGER NOT NULL DEFAULT 0;
