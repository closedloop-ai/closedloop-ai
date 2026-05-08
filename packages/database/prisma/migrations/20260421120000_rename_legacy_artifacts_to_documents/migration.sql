-- PR 1 of PLN-321 (PRD-186 Artifact Schema Refactor): vacate the "artifacts"
-- namespace so PR 2 can reclaim it for the new parent table. Cosmetic rename
-- only — no column additions, drops, or behavioural changes.
--
-- The child-table FK columns named "artifact_id" on artifact_ratings,
-- artifact_generation_status_dismissals, github_action_run_performances,
-- file_attachments, github_pull_requests, loops, etc. stay named
-- "artifact_id"; PR 2 makes them correct again when the new parent reclaims
-- the "artifacts" name.

-- Rename tables
ALTER TABLE "artifacts" RENAME TO "documents";
ALTER TABLE "artifact_versions" RENAME TO "document_versions";

-- Rename primary key constraints
ALTER INDEX "artifacts_pkey" RENAME TO "documents_pkey";
ALTER INDEX "artifact_versions_pkey" RENAME TO "document_versions_pkey";

-- Rename unique indexes on documents
ALTER INDEX "artifacts_organization_id_slug_key" RENAME TO "documents_organization_id_slug_key";
ALTER INDEX "artifacts_organization_id_template_for_type_key" RENAME TO "documents_organization_id_template_for_type_key";

-- Rename non-unique indexes on documents
ALTER INDEX "artifacts_organization_id_type_idx" RENAME TO "documents_organization_id_type_idx";
ALTER INDEX "artifacts_organization_id_workstream_id_type_idx" RENAME TO "documents_organization_id_workstream_id_type_idx";
ALTER INDEX "artifacts_organization_id_project_id_type_idx" RENAME TO "documents_organization_id_project_id_type_idx";
ALTER INDEX "artifacts_workstream_id_idx" RENAME TO "documents_workstream_id_idx";
ALTER INDEX "artifacts_project_id_idx" RENAME TO "documents_project_id_idx";

-- Rename unique index on document_versions
ALTER INDEX "artifact_versions_artifact_id_version_key" RENAME TO "document_versions_artifact_id_version_key";

-- Rename foreign key constraints on documents
ALTER TABLE "documents" RENAME CONSTRAINT "artifacts_organization_id_fkey" TO "documents_organization_id_fkey";
ALTER TABLE "documents" RENAME CONSTRAINT "artifacts_workstream_id_fkey" TO "documents_workstream_id_fkey";
ALTER TABLE "documents" RENAME CONSTRAINT "artifacts_project_id_fkey" TO "documents_project_id_fkey";
ALTER TABLE "documents" RENAME CONSTRAINT "artifacts_assignee_id_fkey" TO "documents_assignee_id_fkey";
ALTER TABLE "documents" RENAME CONSTRAINT "artifacts_created_by_id_fkey" TO "documents_created_by_id_fkey";
ALTER TABLE "documents" RENAME CONSTRAINT "artifacts_approver_id_fkey" TO "documents_approver_id_fkey";

-- Rename foreign key constraint on document_versions
ALTER TABLE "document_versions" RENAME CONSTRAINT "artifact_versions_artifact_id_fkey" TO "document_versions_artifact_id_fkey";
