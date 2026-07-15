-- FEA-3050: idempotency guard for promoteAgentComponent (best-of-breed promote,
-- FEA-2923 §J). `promoteAgentComponent` previously always created a fresh
-- CatalogItem + org-wide AutoInstall/All Distribution with no check for an
-- existing promotion of the same source component, so a double-click or client
-- retry produced duplicate distributions (and duplicate DistributionTargetStatus
-- / ranking rows) that every desktop then auto-installed twice. The pre-existing
-- catalog_items partial unique indexes only cover target_kind='agent' rows,
-- leaving promoted plugin/skill/command/hook/mcp items with no dedup guard.

-- AlterTable: track the discovered AgentComponent a CatalogItem was promoted from.
ALTER TABLE "catalog_items" ADD COLUMN "source_agent_component_id" UUID;

-- Partial unique index: at most one CatalogItem per (organization, source
-- component). Partial (WHERE source_agent_component_id IS NOT NULL) so the many
-- non-promoted items (admin-uploaded, curated, agent-migrated) that carry a NULL
-- source component stay unconstrained. Prisma cannot express partial indexes, so
-- this is hand-written (see packages/database/CLAUDE.md); it mirrors the existing
-- catalog_items agent-row partial-unique pattern in
-- 20260711005000_add_agent_component_and_catalog_distribution.
CREATE UNIQUE INDEX "catalog_items_organization_id_source_agent_component_id_key"
    ON "catalog_items"("organization_id", "source_agent_component_id")
    WHERE "source_agent_component_id" IS NOT NULL;
