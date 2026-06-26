-- AlterTable
ALTER TABLE "compute_targets" ADD COLUMN     "last_agent_session_sync_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "agent_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "compute_target_id" UUID NOT NULL,
    "project_id" UUID,
    "external_session_id" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL,
    "harness" TEXT NOT NULL DEFAULT 'unknown',
    "cwd" TEXT,
    "repository_full_name" TEXT,
    "worktree_path" TEXT,
    "model" TEXT,
    "session_started_at" TIMESTAMP(3) NOT NULL,
    "session_updated_at" TIMESTAMP(3) NOT NULL,
    "session_ended_at" TIMESTAMP(3),
    "awaiting_input_since" TIMESTAMP(3),
    "source_artifact_id" TEXT,
    "source_loop_id" TEXT,
    "issue_id" TEXT,
    "base_branch" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "agent_count" INTEGER NOT NULL DEFAULT 0,
    "tool_use_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "agents" JSONB NOT NULL DEFAULT '[]',
    "events" JSONB NOT NULL DEFAULT '[]',
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_session_token_usage" (
    "id" UUID NOT NULL,
    "agent_session_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_session_token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_sessions_organization_id_session_started_at_idx" ON "agent_sessions"("organization_id", "session_started_at");

-- CreateIndex
CREATE INDEX "agent_sessions_organization_id_user_id_session_started_at_idx" ON "agent_sessions"("organization_id", "user_id", "session_started_at");

-- CreateIndex
CREATE INDEX "agent_sessions_organization_id_project_id_session_started_a_idx" ON "agent_sessions"("organization_id", "project_id", "session_started_at");

-- CreateIndex
CREATE INDEX "agent_sessions_organization_id_harness_session_started_at_idx" ON "agent_sessions"("organization_id", "harness", "session_started_at");

-- CreateIndex
CREATE INDEX "agent_sessions_compute_target_id_session_updated_at_idx" ON "agent_sessions"("compute_target_id", "session_updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_sessions_compute_target_id_external_session_id_key" ON "agent_sessions"("compute_target_id", "external_session_id");

-- CreateIndex
CREATE INDEX "agent_session_token_usage_model_idx" ON "agent_session_token_usage"("model");

-- CreateIndex
CREATE UNIQUE INDEX "agent_session_token_usage_agent_session_id_model_key" ON "agent_session_token_usage"("agent_session_id", "model");

-- AddForeignKey
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_compute_target_id_fkey" FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_session_token_usage" ADD CONSTRAINT "agent_session_token_usage_agent_session_id_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
