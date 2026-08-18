-- FEA-2923 content-hash version history: one row per distinct definition
-- revision, keyed by (org, component, source, content_hash). Additive new
-- table with no deployed readers. Generated offline via prisma migrate diff;
-- applied by prisma migrate deploy in CI/prod.

-- CreateTable
CREATE TABLE "agent_component_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "component_kind" TEXT NOT NULL,
    "component_key" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "content_hash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "format" TEXT,
    "first_seen_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_component_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_component_versions_organization_id_component_kind_com_idx" ON "agent_component_versions"("organization_id", "component_kind", "component_key");

-- CreateIndex
CREATE UNIQUE INDEX "agent_component_versions_organization_id_component_kind_com_key" ON "agent_component_versions"("organization_id", "component_kind", "component_key", "source", "content_hash");

-- AddForeignKey
ALTER TABLE "agent_component_versions" ADD CONSTRAINT "agent_component_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

