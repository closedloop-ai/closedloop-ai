-- CreateTable: agent_components (T-6.1)
-- Inventory / existence registry: one row per (computeTargetId, componentKind, externalComponentId).
-- Org isolation via computeTarget.organizationId join; org-scoped reads enter through ComputeTarget.
CREATE TABLE "agent_components" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "compute_target_id" UUID NOT NULL,
    "component_kind" TEXT NOT NULL,
    "external_component_id" TEXT NOT NULL,
    "harness" TEXT,
    "name" TEXT,
    "component_key" TEXT,
    "version" TEXT,
    "description" TEXT,
    "source_url" TEXT,
    "install_path" TEXT,
    "pack_id" TEXT,
    "scope" TEXT,
    "project_path" TEXT,
    "metadata" JSONB,
    "first_seen_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "uninstalled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable: agent_component_session_usage (T-6.2)
-- Usage / invocation stats per session × component key.
-- No organization_id: org isolation is enforced via SessionDetail → Artifact.organization_id
-- (D4 decision — same pattern as AgentSessionTokenEvent).
CREATE TABLE "agent_component_session_usage" (
    "id" UUID NOT NULL,
    "agent_session_id" UUID NOT NULL,
    "component_kind" TEXT NOT NULL,
    "component_key" TEXT NOT NULL,
    "agent_component_id" UUID,
    "harness" TEXT,
    "invocation_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "first_invoked_at" TIMESTAMP(3),
    "last_invoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_component_session_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable: catalog_items (T-14.1, T-21.1)
-- Distributable definitions for any component kind. organization_id nullable for global/curated items.
-- Legacy Agent supersede columns: legacy_agent_id, source_repo, role, source_loop_id (T-21.1).
CREATE TABLE "catalog_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "target_kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "zip_asset_bucket" TEXT,
    "zip_asset_key" TEXT,
    "logo_asset_bucket" TEXT,
    "logo_asset_key" TEXT,
    "files_asset_key" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "legacy_agent_id" UUID,
    "source_repo" TEXT,
    "role" TEXT,
    "agent_slug" TEXT,
    "source_loop_id" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable: catalog_item_versions (T-14.1)
-- Versioned content history for a CatalogItem. Mirrors AgentVersion.
CREATE TABLE "catalog_item_versions" (
    "id" UUID NOT NULL,
    "catalog_item_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT,
    "change_note" TEXT,
    "changed_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_item_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: distributions (T-14.2)
-- A distribution assignment: CatalogItem → targeting set + mode.
CREATE TABLE "distributions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "catalog_item_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "targeting_type" TEXT NOT NULL,
    "desired_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "distributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: distribution_target_status (T-14.3)
-- Per-(distribution, computeTarget/user) install/enable status tracking.
CREATE TABLE "distribution_target_status" (
    "id" UUID NOT NULL,
    "distribution_id" UUID NOT NULL,
    "compute_target_id" UUID,
    "user_id" UUID,
    "status" TEXT NOT NULL,
    "installed_version" TEXT,
    "install_run_id" TEXT,
    "failure_reason" TEXT,
    "installed_at" TIMESTAMP(3),
    "enabled_at" TIMESTAMP(3),
    "reported_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "distribution_target_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable: distribution_targeting_entries (T-14.4)
-- Specific-targeting rows: which compute targets/users a Distribution explicitly targets.
CREATE TABLE "distribution_targeting_entries" (
    "id" UUID NOT NULL,
    "distribution_id" UUID NOT NULL,
    "compute_target_id" UUID,
    "user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "distribution_targeting_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: agent_components
CREATE UNIQUE INDEX "agent_components_compute_target_id_component_kind_external__key" ON "agent_components"("compute_target_id", "component_kind", "external_component_id");
CREATE INDEX "agent_components_organization_id_component_kind_idx" ON "agent_components"("organization_id", "component_kind");
CREATE INDEX "agent_components_organization_id_idx" ON "agent_components"("organization_id");

-- CreateIndex: agent_component_session_usage
CREATE UNIQUE INDEX "agent_component_session_usage_agent_session_id_component_ki_key" ON "agent_component_session_usage"("agent_session_id", "component_kind", "component_key");
CREATE INDEX "agent_component_session_usage_agent_component_id_idx" ON "agent_component_session_usage"("agent_component_id");
CREATE INDEX "agent_component_session_usage_agent_session_id_component_ki_idx" ON "agent_component_session_usage"("agent_session_id", "component_kind");

-- CreateIndex: catalog_items
CREATE INDEX "catalog_items_organization_id_archived_idx" ON "catalog_items"("organization_id", "archived");
CREATE INDEX "catalog_items_source_scope_idx" ON "catalog_items"("source", "scope");
CREATE INDEX "catalog_items_organization_id_target_kind_idx" ON "catalog_items"("organization_id", "target_kind");

-- Partial unique index for Agent bootstrap idempotency (targetKind='agent' rows only).
-- Prisma cannot express partial indexes; maintained here in raw SQL.
-- Mirrors Agent @@unique([organizationId, sourceRepo, role]) semantics.
CREATE UNIQUE INDEX "catalog_items_organization_id_source_repo_role_agent_key"
    ON "catalog_items"("organization_id", "source_repo", "role")
    WHERE "target_kind" = 'agent';

-- Partial unique index on the persisted agent context-pack slug (targetKind='agent'
-- rows only). Mirrors the superseded Agent @@unique([organizationId, slug]) so
-- same-role agents from different sourceRepos keep distinct, stable harness file
-- names. Prisma cannot express partial indexes; maintained here in raw SQL.
CREATE UNIQUE INDEX "catalog_items_organization_id_agent_slug_agent_key"
    ON "catalog_items"("organization_id", "agent_slug")
    WHERE "target_kind" = 'agent' AND "agent_slug" IS NOT NULL;

-- CreateIndex: catalog_item_versions
CREATE UNIQUE INDEX "catalog_item_versions_catalog_item_id_version_key" ON "catalog_item_versions"("catalog_item_id", "version");
CREATE INDEX "catalog_item_versions_catalog_item_id_idx" ON "catalog_item_versions"("catalog_item_id");

-- CreateIndex: distributions
CREATE INDEX "distributions_catalog_item_id_idx" ON "distributions"("catalog_item_id");
CREATE INDEX "distributions_organization_id_idx" ON "distributions"("organization_id");

-- CreateIndex: distribution_target_status
-- Partial UNIQUE (WHERE compute_target_id IS NOT NULL) enforces the business
-- rule "one status row per (distribution, computeTarget)" for target-scoped
-- rows, while still allowing multiple user-only rows (compute_target_id NULL).
-- Prisma cannot express partial indexes, so it is maintained here in raw SQL
-- (mirrors the catalog_items partial-unique pattern above and the desktop
-- desktop_commands partial indexes). Added in-migration — this is a brand-new
-- table with no prod data, so no separate corrective migration is needed.
CREATE UNIQUE INDEX "distribution_target_status_distribution_id_compute_target_id_key" ON "distribution_target_status"("distribution_id", "compute_target_id") WHERE "compute_target_id" IS NOT NULL;
CREATE INDEX "distribution_target_status_distribution_id_idx" ON "distribution_target_status"("distribution_id");
CREATE INDEX "distribution_target_status_compute_target_id_idx" ON "distribution_target_status"("compute_target_id");
CREATE INDEX "distribution_target_status_distribution_id_status_idx" ON "distribution_target_status"("distribution_id", "status");

-- CreateIndex: distribution_targeting_entries
CREATE INDEX "distribution_targeting_entries_distribution_id_idx" ON "distribution_targeting_entries"("distribution_id");
CREATE INDEX "distribution_targeting_entries_compute_target_id_idx" ON "distribution_targeting_entries"("compute_target_id");

-- AddForeignKey: agent_components
ALTER TABLE "agent_components" ADD CONSTRAINT "agent_components_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_components" ADD CONSTRAINT "agent_components_compute_target_id_fkey" FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: agent_component_session_usage
ALTER TABLE "agent_component_session_usage" ADD CONSTRAINT "agent_component_session_usage_agent_session_id_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_component_session_usage" ADD CONSTRAINT "agent_component_session_usage_agent_component_id_fkey" FOREIGN KEY ("agent_component_id") REFERENCES "agent_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: catalog_items
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: catalog_item_versions
ALTER TABLE "catalog_item_versions" ADD CONSTRAINT "catalog_item_versions_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_item_versions" ADD CONSTRAINT "catalog_item_versions_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: distributions
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: distribution_target_status
ALTER TABLE "distribution_target_status" ADD CONSTRAINT "distribution_target_status_distribution_id_fkey" FOREIGN KEY ("distribution_id") REFERENCES "distributions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "distribution_target_status" ADD CONSTRAINT "distribution_target_status_compute_target_id_fkey" FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "distribution_target_status" ADD CONSTRAINT "distribution_target_status_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: distribution_targeting_entries
ALTER TABLE "distribution_targeting_entries" ADD CONSTRAINT "distribution_targeting_entries_distribution_id_fkey" FOREIGN KEY ("distribution_id") REFERENCES "distributions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "distribution_targeting_entries" ADD CONSTRAINT "distribution_targeting_entries_compute_target_id_fkey" FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
