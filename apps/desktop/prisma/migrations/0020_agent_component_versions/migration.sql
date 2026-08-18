-- FEA-2923 content-hash version history (desktop). One row per distinct
-- definition revision, keyed by (component, source, content_hash).
-- Forward-only; generated offline via prisma migrate diff.

-- CreateTable
CREATE TABLE IF NOT EXISTS "agent_component_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "component_kind" TEXT NOT NULL,
    "component_key" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "content_hash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "format" TEXT,
    "first_seen_at" TEXT,
    "last_seen_at" TEXT
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_agent_component_versions_component" ON "agent_component_versions"("component_kind", "component_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_agent_component_versions_identity" ON "agent_component_versions"("component_kind", "component_key", "source", "content_hash");

