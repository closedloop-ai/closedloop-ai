-- FEA-3290 / PRD-527 — F1 Definition Source and Version Registry, Slice 2 of 6.
-- SCHEMA + migration ONLY (no writers, reads, or backfill — Slices 3-6).
--
-- Fully ADDITIVE / zero-downtime: CREATE TYPE (enums), ADD COLUMN (all nullable
-- or NOT NULL with a constant DEFAULT → metadata-only on PG 11+, no table
-- rewrite), CREATE TABLE (empty), CREATE INDEX, ADD CONSTRAINT (FKs validate
-- instantly against all-NULL / empty columns). No DROP, no ALTER on existing
-- columns, no data mutation. Rollback = drop the two tables + three columns +
-- three enums; the FKs are SET NULL so nothing cascades.
--
-- Generated offline via `prisma migrate diff --from-schema <origin/main> --to-schema
-- <this schema> --script` (NOT applied to the shared local Postgres, per
-- packages/database/CLAUDE.md). A human applies it with `prisma migrate deploy`.
--
-- NULL-distinct caveat on idx_source_occurrence_natural_key: Postgres treats
-- NULL as DISTINCT in a unique index, so two occurrences with NULL key parts do
-- NOT collide. The Slice-3 writer therefore never passes NULL into the key
-- participants (coalesces the type-inapplicable evidence columns to '' and
-- drives NULL-compute-target dedupe through the application upsert). Provenance
-- is descriptive, not identity-bearing, so a residual duplicate never corrupts
-- version identity.

-- CreateEnum
CREATE TYPE "source_occurrence_type" AS ENUM ('repository', 'local', 'pack');

-- CreateEnum
CREATE TYPE "source_access_state" AS ENUM ('accessible', 'inaccessible');

-- CreateEnum
CREATE TYPE "component_resolved_state" AS ENUM ('resolved', 'unresolved', 'inaccessible', 'missing');

-- AlterTable
ALTER TABLE "agent_components" ADD COLUMN     "resolved_state" "component_resolved_state" NOT NULL DEFAULT 'unresolved';

-- AlterTable
ALTER TABLE "agent_component_versions" ADD COLUMN     "definition_version_id" UUID;

-- AlterTable
ALTER TABLE "agent_component_session_usage" ADD COLUMN     "definition_version_id" UUID;

-- CreateTable
CREATE TABLE "definition_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "component_kind" TEXT NOT NULL,
    "definition_hash" TEXT NOT NULL,
    "normalizer_contract_version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "format" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "definition_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_occurrences" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "definition_version_id" UUID NOT NULL,
    "occurrence_type" "source_occurrence_type" NOT NULL,
    "access_state" "source_access_state" NOT NULL DEFAULT 'accessible',
    "repo_full_name" TEXT,
    "repo_path" TEXT,
    "repo_commit" TEXT,
    "compute_target_id" UUID,
    "local_path" TEXT,
    "pack_id" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "definition_versions_organization_id_component_kind_idx" ON "definition_versions"("organization_id", "component_kind");

-- CreateIndex
CREATE UNIQUE INDEX "definition_versions_organization_id_definition_hash_key" ON "definition_versions"("organization_id", "definition_hash");

-- CreateIndex
CREATE INDEX "source_occurrences_organization_id_definition_version_id_idx" ON "source_occurrences"("organization_id", "definition_version_id");

-- CreateIndex
CREATE INDEX "source_occurrences_compute_target_id_idx" ON "source_occurrences"("compute_target_id");

-- CreateIndex
CREATE UNIQUE INDEX "idx_source_occurrence_natural_key" ON "source_occurrences"("definition_version_id", "occurrence_type", "repo_full_name", "repo_path", "repo_commit", "compute_target_id", "local_path", "pack_id");

-- CreateIndex
CREATE INDEX "agent_component_versions_definition_version_id_idx" ON "agent_component_versions"("definition_version_id");

-- CreateIndex
CREATE INDEX "agent_component_session_usage_definition_version_id_idx" ON "agent_component_session_usage"("definition_version_id");

-- AddForeignKey
ALTER TABLE "agent_component_versions" ADD CONSTRAINT "agent_component_versions_definition_version_id_fkey" FOREIGN KEY ("definition_version_id") REFERENCES "definition_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_component_session_usage" ADD CONSTRAINT "agent_component_session_usage_definition_version_id_fkey" FOREIGN KEY ("definition_version_id") REFERENCES "definition_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "definition_versions" ADD CONSTRAINT "definition_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_occurrences" ADD CONSTRAINT "source_occurrences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_occurrences" ADD CONSTRAINT "source_occurrences_definition_version_id_fkey" FOREIGN KEY ("definition_version_id") REFERENCES "definition_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_occurrences" ADD CONSTRAINT "source_occurrences_compute_target_id_fkey" FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

