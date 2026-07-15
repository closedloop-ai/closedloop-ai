-- FEA-2923 (T-8.3): component inventory + session usage tables.
-- Additive; existing installs apply only this migration (IF NOT EXISTS makes a
-- re-run a no-op). No FK on agent_component_session_usage.session_id — matches
-- the token_usage / session_tool_analytics convention (a FK would drift
-- prisma-migrations-agreement; see schema.prisma note at line ~208-211).

-- CreateTable
CREATE TABLE IF NOT EXISTS "agent_components" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "component_kind" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "component_key" TEXT,
    "name" TEXT,
    "version" TEXT,
    "harness" TEXT,
    "source" TEXT,
    "description" TEXT,
    "source_url" TEXT,
    "install_path" TEXT,
    "pack_id" TEXT,
    "scope" TEXT,
    "project_path" TEXT,
    "metadata" JSONB,
    "first_seen_at" TEXT,
    "last_seen_at" TEXT,
    "uninstalled_at" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "agent_component_session_usage" (
    "session_id" TEXT NOT NULL,
    "component_kind" TEXT NOT NULL,
    "component_key" TEXT NOT NULL,
    "agent_component_id" TEXT,
    "harness" TEXT,
    "invocations" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "first_invoked_at" TEXT,
    "last_invoked_at" TEXT,
    "started_day" TEXT,

    PRIMARY KEY ("session_id", "component_kind", "component_key")
);

-- CreateUnique: dedup on (componentKind, externalId)
CREATE UNIQUE INDEX IF NOT EXISTS "idx_agent_components_kind_ext" ON "agent_components"("component_kind", "external_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_agent_components_kind" ON "agent_components"("component_kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_agent_components_pack" ON "agent_components"("pack_id") WHERE pack_id IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_agent_components_kind_key" ON "agent_components"("component_kind", "component_key") WHERE component_key IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_agent_components_last_seen" ON "agent_components"("last_seen_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_acsu_kind_key" ON "agent_component_session_usage"("component_kind", "component_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_acsu_component" ON "agent_component_session_usage"("agent_component_id") WHERE agent_component_id IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_acsu_day" ON "agent_component_session_usage"("started_day");
