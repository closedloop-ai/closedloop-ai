-- ISS-10717: aggregate the desktop claude_code_* OTel corpus to cloud.
--
-- Every count column is NULLABLE WITH NO DEFAULT on purpose: NULL means the
-- recording machine never recorded that signal family, 0 means it measured the
-- family and this session produced none. Defaulting them to 0 would state a
-- measured absence that was never observed.

-- CreateTable
CREATE TABLE "claude_code_session_telemetry" (
    "artifact_id" UUID NOT NULL,
    "harness" TEXT NOT NULL,
    "protocol_version" INTEGER NOT NULL,
    "cost_event_count" INTEGER,
    "api_request_count" INTEGER,
    "error_event_count" INTEGER,
    "permission_event_count" INTEGER,
    "permission_mode_change_count" INTEGER,
    "mcp_server_connection_count" INTEGER,
    "tool_result_count" INTEGER,
    "llm_request_count" INTEGER,
    "cost_event_usd" DECIMAL(14,6),
    "api_request_cost_usd_micros" BIGINT,
    "observed_from" TIMESTAMP(3),
    "observed_to" TIMESTAMP(3),
    "components_truncated" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claude_code_session_telemetry_pkey" PRIMARY KEY ("artifact_id")
);

-- CreateTable
CREATE TABLE "claude_code_component_telemetry" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "attribution_key" TEXT NOT NULL,
    "attribution_source" TEXT NOT NULL,
    "agent_name" TEXT,
    "skill_name" TEXT,
    "plugin_name" TEXT,
    "mcp_server_name" TEXT,
    "mcp_tool_name" TEXT,
    "query_source" TEXT,
    "speed" TEXT,
    "effort" TEXT,
    "cost_event_count" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(14,6),
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claude_code_component_telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claude_code_signal_drop_counter" (
    "id" UUID NOT NULL,
    "compute_target_id" UUID NOT NULL,
    "harness" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "dropped_count" BIGINT NOT NULL,
    "first_observed_at" TIMESTAMP(3) NOT NULL,
    "last_observed_at" TIMESTAMP(3) NOT NULL,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claude_code_signal_drop_counter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- index-lock-ok(claude_code_component_telemetry): table is created empty in this same migration so the component identity unique, its cascade-support lookup index, and the drop-counter identity unique all build against zero rows with no concurrent writer; the two uniques are the ingest upserts' ON CONFLICT targets and must exist before the first write, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "claude_code_component_telemetry_artifact_key" ON "claude_code_component_telemetry"("artifact_id", "attribution_key");

-- CreateIndex
-- index-lock-ok(claude_code_component_telemetry): table is created empty in this same migration so the component identity unique, its cascade-support lookup index, and the drop-counter identity unique all build against zero rows with no concurrent writer; the two uniques are the ingest upserts' ON CONFLICT targets and must exist before the first write, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "claude_code_component_telemetry_artifact_id_idx" ON "claude_code_component_telemetry"("artifact_id");

-- CreateIndex
-- index-lock-ok(claude_code_signal_drop_counter): table is created empty in this same migration so the component identity unique, its cascade-support lookup index, and the drop-counter identity unique all build against zero rows with no concurrent writer; the two uniques are the ingest upserts' ON CONFLICT targets and must exist before the first write, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "claude_code_signal_drop_counter_natural" ON "claude_code_signal_drop_counter"("compute_target_id", "harness", "reason");

-- AddForeignKey
ALTER TABLE "claude_code_session_telemetry" ADD CONSTRAINT "claude_code_session_telemetry_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claude_code_component_telemetry" ADD CONSTRAINT "claude_code_component_telemetry_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claude_code_signal_drop_counter" ADD CONSTRAINT "claude_code_signal_drop_counter_compute_target_id_fkey" FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
