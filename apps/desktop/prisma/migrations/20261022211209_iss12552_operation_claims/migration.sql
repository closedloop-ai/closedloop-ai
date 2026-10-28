-- ISS-12552 (PLN-2191 T-2.5): operation evidence for attribution.
--
-- `session_operation_claims` holds one row per session: the operation claims
-- the extractor read from its transcript and the coverage counts, as JSON,
-- replaced whole on every reparse. The sync source reads it to send
-- `operationEvidence`; no view reads it.
--
-- `token_events.agent_id` is the subagent a token event belongs to (NULL for
-- the main agent), sent as `agentExternalId`.
CREATE TABLE IF NOT EXISTS "session_operation_claims" (
  "session_id" TEXT NOT NULL PRIMARY KEY,
  "extractor_version" INTEGER NOT NULL,
  "digest" TEXT NOT NULL,
  "coverage" TEXT NOT NULL,
  "claims" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  CONSTRAINT "session_operation_claims_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "token_events" ADD COLUMN "agent_id" TEXT;
