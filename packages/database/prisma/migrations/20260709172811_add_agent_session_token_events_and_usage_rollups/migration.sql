-- CreateTable
CREATE TABLE "agent_session_token_events" (
    "id" UUID NOT NULL,
    "agent_session_id" UUID NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "agent_external_id" TEXT,
    "model" TEXT NOT NULL,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_write_tokens" BIGINT NOT NULL DEFAULT 0,
    "estimated_cost" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "event_created_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_session_token_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_session_usage_rollups" (
    "artifact_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3),
    "started_day" TEXT,
    "status" TEXT,
    "harness" TEXT,
    "is_human" BOOLEAN NOT NULL DEFAULT false,
    "human_turns" INTEGER NOT NULL DEFAULT 0,
    "agent_turns" INTEGER NOT NULL DEFAULT 0,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "tool_invocations" INTEGER NOT NULL DEFAULT 0,
    "error_events" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_write_tokens" BIGINT NOT NULL DEFAULT 0,
    "estimated_cost" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "runtime_ms" INTEGER,
    "rollup_updated_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_session_usage_rollups_pkey" PRIMARY KEY ("artifact_id")
);

-- CreateIndex
CREATE INDEX "agent_session_token_events_agent_session_id_event_created_a_idx" ON "agent_session_token_events"("agent_session_id", "event_created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_session_token_events_agent_session_id_external_event__key" ON "agent_session_token_events"("agent_session_id", "external_event_id");

-- AddForeignKey
ALTER TABLE "agent_session_token_events" ADD CONSTRAINT "agent_session_token_events_agent_session_id_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_session_usage_rollups" ADD CONSTRAINT "agent_session_usage_rollups_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;
