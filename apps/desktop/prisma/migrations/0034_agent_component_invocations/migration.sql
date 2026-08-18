-- FEA-3294 (PRD-527): durable per-runtime-invocation attribution and the
-- dedicated exact-part delivery outbox. Both tables are additive and use only
-- Desktop-local identities. In particular, there are no cloud
-- DefinitionVersion or SourceOccurrence columns/FKs.
--
-- The invocation row belongs to its local session and is removed with it.
-- Optional local Agent/component/version links are repairable projections, so
-- deleting those owners clears only the link and preserves frozen evidence.
-- The outbox intentionally has no session FK: an unacknowledged exact part must
-- survive local session deletion, restart, and old-cloud capability skew.

-- CreateTable
CREATE TABLE IF NOT EXISTS "agent_component_invocations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "external_invocation_id" TEXT NOT NULL,
    "external_source_id" TEXT,
    "child_session_id" TEXT,
    "agent_id" TEXT,
    "parent_agent_id" TEXT,
    "component_kind" TEXT NOT NULL,
    "component_key" TEXT NOT NULL,
    "raw_name" TEXT,
    "normalized_name" TEXT,
    "relationship" TEXT NOT NULL,
    "invoked_at" TEXT,
    "sequence" INTEGER NOT NULL,
    "anchor_kind" TEXT NOT NULL,
    "anchor_value" TEXT NOT NULL,
    "provider_tool_use_id" TEXT,
    "attribution_status" TEXT NOT NULL,
    "evidence_class" TEXT NOT NULL,
    "evidence_pointer" JSONB,
    "definition_hash" TEXT,
    "normalizer_contract_version" INTEGER,
    "definition_content" TEXT,
    "local_component_id" TEXT,
    "local_component_version_id" TEXT,
    "git_branch" TEXT,
    "repository_full_name" TEXT,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,

    CONSTRAINT "agent_component_invocations_session_id_fkey"
      FOREIGN KEY ("session_id") REFERENCES "sessions" ("id")
      ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "agent_component_invocations_agent_id_fkey"
      FOREIGN KEY ("agent_id") REFERENCES "agents" ("id")
      ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "agent_component_invocations_parent_agent_id_fkey"
      FOREIGN KEY ("parent_agent_id") REFERENCES "agents" ("id")
      ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "agent_component_invocations_local_component_id_fkey"
      FOREIGN KEY ("local_component_id") REFERENCES "agent_components" ("id")
      ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "agent_component_invocations_local_component_version_id_fkey"
      FOREIGN KEY ("local_component_version_id") REFERENCES "agent_component_versions" ("id")
      ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "agent_component_invocation_sync_outbox" (
    "source_key" TEXT NOT NULL,
    "external_session_id" TEXT NOT NULL,
    "external_generation_id" TEXT NOT NULL,
    "part_index" INTEGER NOT NULL,
    "part_count" INTEGER NOT NULL,
    "part_hash" TEXT NOT NULL,
    "source_updated_at" TEXT NOT NULL,
    "data_revision" INTEGER NOT NULL,
    "source_sequence" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TEXT,
    "last_error" TEXT,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,

    CONSTRAINT "agent_component_invocation_sync_outbox_pkey"
      PRIMARY KEY ("source_key", "external_session_id", "external_generation_id", "part_index")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "agent_component_invocation_sync_cursors" (
    "source_key" TEXT NOT NULL,
    "external_session_id" TEXT NOT NULL,
    "external_generation_id" TEXT NOT NULL,
    "source_sequence" INTEGER NOT NULL,
    "updated_at" TEXT NOT NULL,

    CONSTRAINT "agent_component_invocation_sync_cursors_pkey"
      PRIMARY KEY ("source_key", "external_session_id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_aci_session_external_invocation"
  ON "agent_component_invocations"("session_id", "external_invocation_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_aci_session_sequence"
  ON "agent_component_invocations"("session_id", "sequence");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_aci_external_source"
  ON "agent_component_invocations"("external_source_id")
  WHERE external_source_id IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_aci_kind_key_invoked_at"
  ON "agent_component_invocations"("component_kind", "component_key", "invoked_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_aci_component_invoked_at"
  ON "agent_component_invocations"("local_component_id", "invoked_at")
  WHERE local_component_id IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_aci_component_branch_invoked_at"
  ON "agent_component_invocations"("local_component_id", "git_branch", "invoked_at")
  WHERE local_component_id IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_aci_component_version_invoked_at"
  ON "agent_component_invocations"("local_component_version_id", "invoked_at")
  WHERE local_component_version_id IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_aci_status_invoked_at"
  ON "agent_component_invocations"("attribution_status", "invoked_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_agent_component_invocation_sync_outbox_ready"
  ON "agent_component_invocation_sync_outbox"("source_key", "status", "next_attempt_at");
