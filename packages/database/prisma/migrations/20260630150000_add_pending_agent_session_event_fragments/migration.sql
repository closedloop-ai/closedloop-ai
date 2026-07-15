-- Transient reassembly state for oversized desktop agent-session event payloads.
-- Canonical session/event rows are written only after a complete, hash-verified
-- fragment set materializes through the existing session upsert path.
CREATE TABLE "pending_agent_session_event_fragments" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "compute_target_id" UUID NOT NULL,
  "external_session_id" TEXT NOT NULL,
  "external_event_id" TEXT NOT NULL,
  "fragment_id" TEXT NOT NULL,
  "fragment_index" INTEGER NOT NULL,
  "fragment_count" INTEGER NOT NULL,
  "encoding" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "session_metadata_hash" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "payload_bytes" INTEGER NOT NULL,
  "decoded_bytes" INTEGER NOT NULL,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "pending_agent_session_event_fragments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pending_agent_session_event_fragments_identity_key"
  ON "pending_agent_session_event_fragments" (
    "organization_id",
    "compute_target_id",
    "external_session_id",
    "external_event_id",
    "fragment_id",
    "fragment_index"
  );

CREATE INDEX "pending_agent_session_event_fragments_completion_idx"
  ON "pending_agent_session_event_fragments" (
    "organization_id",
    "compute_target_id",
    "external_session_id",
    "external_event_id",
    "fragment_id"
  );

CREATE INDEX "pending_agent_session_event_fragments_cleanup_idx"
  ON "pending_agent_session_event_fragments" (
    "organization_id",
    "compute_target_id",
    "expires_at"
  );

CREATE INDEX "pending_agent_session_event_fragments_capacity_idx"
  ON "pending_agent_session_event_fragments" (
    "organization_id",
    "compute_target_id"
  );

ALTER TABLE "pending_agent_session_event_fragments"
  ADD CONSTRAINT "pending_agent_session_event_fragments_compute_target_id_fkey"
  FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
