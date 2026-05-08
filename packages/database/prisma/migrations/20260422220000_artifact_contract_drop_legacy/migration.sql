-- Chunk 2F of PLN-321 (PRD-186 Artifact Schema Refactor): the contract
-- step. After this migration the Artifact parent is the sole read/write
-- path for DOCUMENT, PULL_REQUEST, and DEPLOYMENT entities. The legacy
-- tables (`documents`, `document_versions`, `github_pull_requests`,
-- `external_links`, `entity_links`, `pull_request_ratings`) and legacy
-- enums (`DocumentType`, `EntityType`, `ExternalLinkType`) are dropped in
-- one atomic step, along with the polymorphic `entity_id`/`entity_type`
-- columns on `comment_threads` and `artifact_evaluations`.
--
-- Before this runs, Chunks 2A (additive Artifact/DocumentDetail/ArtifactLink
-- + backfill from `documents`) and 2B (additive PullRequestDetail/
-- DeploymentDetail + backfill from `github_pull_requests`/
-- `external_links`) have already applied. Reader flips (project tree, doc
-- routes, PR page, deployment UI, MCP, frontend) are in the same
-- deployment so no stale readers remain once this migration commits.

-- =============================================================================
-- Phase 1 — re-sync artifacts from live data
-- =============================================================================
-- Catches any rows created between the 2A/2B backfills and this migration.
-- Uses DO NOTHING on conflicts because IDs are stable across both shapes
-- (artifact.id === documents.id === github_pull_requests.id ===
--  external_links.id for PREVIEW_DEPLOYMENT rows).

-- Documents → artifacts + document_detail (catch up new docs)
INSERT INTO "artifacts" (
    "id", "organization_id", "project_id", "workstream_id",
    "type", "subtype", "name", "slug", "assignee_id", "status",
    "priority", "external_url", "sort_order",
    "created_at", "created_by_id", "updated_at"
)
SELECT
    d."id", d."organization_id",
    COALESCE(
        d."project_id",
        (SELECT p."id" FROM "projects" p
          WHERE p."organization_id" = d."organization_id"
            AND p."is_templates_sentinel")
    ),
    d."workstream_id",
    'DOCUMENT'::"ArtifactType",
    d."type"::text::"ArtifactSubtype",
    d."title", d."slug", d."assignee_id", d."status"::text,
    d."priority", NULL, d."sort_order",
    d."created_at", d."created_by_id", d."updated_at"
FROM "documents" d
WHERE (d."project_id" IS NOT NULL OR EXISTS (
        SELECT 1 FROM "projects" p
        WHERE p."organization_id" = d."organization_id"
          AND p."is_templates_sentinel"
      ))
ON CONFLICT ("id") DO UPDATE SET
    "project_id"     = EXCLUDED."project_id",
    "workstream_id"  = EXCLUDED."workstream_id",
    "subtype"        = EXCLUDED."subtype",
    "name"           = EXCLUDED."name",
    "slug"           = EXCLUDED."slug",
    "assignee_id"    = EXCLUDED."assignee_id",
    "status"         = EXCLUDED."status",
    "priority"       = EXCLUDED."priority",
    "sort_order"     = EXCLUDED."sort_order",
    "updated_at"     = EXCLUDED."updated_at";

INSERT INTO "document_detail" (
    "artifact_id", "file_name", "approver_id", "template_for_type",
    "latest_version", "target_repo", "target_branch"
)
SELECT
    d."id", d."file_name", d."approver_id",
    d."template_for_type"::text::"ArtifactSubtype",
    d."latest_version", d."target_repo", d."target_branch"
FROM "documents" d
JOIN "artifacts" a ON a."id" = d."id"
ON CONFLICT ("artifact_id") DO UPDATE SET
    "file_name"         = EXCLUDED."file_name",
    "approver_id"       = EXCLUDED."approver_id",
    "template_for_type" = EXCLUDED."template_for_type",
    "latest_version"    = EXCLUDED."latest_version",
    "target_repo"       = EXCLUDED."target_repo",
    "target_branch"     = EXCLUDED."target_branch";

-- Pull requests → artifacts + pull_request_detail (catch up new PRs)
--
-- Same orphan defense as 2B: skip PRs whose repository_id no longer
-- resolves in github_installation_repositories. github_pull_requests has
-- never had an FK on repository_id, so installations uninstalled in the
-- past leave dead repository_ids on PR rows. Without this filter, the
-- pull_request_detail INSERT below trips
-- pull_request_detail_repository_id_fkey created in 2B.
INSERT INTO "artifacts" (
    "id", "organization_id", "project_id", "workstream_id",
    "type", "subtype", "name", "slug", "assignee_id", "status",
    "priority", "external_url", "sort_order",
    "created_at", "created_by_id", "updated_at"
)
SELECT
    pr."id", pr."organization_id", w."project_id", pr."workstream_id",
    'PULL_REQUEST'::"ArtifactType", NULL,
    pr."title", NULL, NULL, pr."state"::text,
    NULL, pr."html_url", NULL,
    pr."created_at", NULL, pr."updated_at"
FROM "github_pull_requests" pr
JOIN "workstreams" w ON w."id" = pr."workstream_id"
JOIN "github_installation_repositories" r ON r."id" = pr."repository_id"
ON CONFLICT ("id") DO UPDATE SET
    "name"         = EXCLUDED."name",
    "status"       = EXCLUDED."status",
    "external_url" = EXCLUDED."external_url",
    "updated_at"   = EXCLUDED."updated_at";

INSERT INTO "pull_request_detail" (
    "artifact_id", "repository_id", "github_id", "number", "body",
    "head_branch", "base_branch", "head_sha", "pr_state", "is_draft",
    "checks_status", "review_decision", "closed_at", "merged_at",
    "merge_commit_sha", "last_verified_at", "last_refresh_attempt_at"
)
SELECT
    pr."id", pr."repository_id", pr."github_id", pr."number", pr."body",
    pr."head_branch", pr."base_branch", pr."head_sha", pr."state",
    pr."is_draft", pr."checks_status", pr."review_decision",
    pr."closed_at", pr."merged_at", pr."merge_commit_sha",
    NULLIF(el."metadata"->>'lastVerifiedAt', '')::timestamp(3),
    NULLIF(el."metadata"->>'lastRefreshAttemptAt', '')::timestamp(3)
FROM "github_pull_requests" pr
JOIN "github_installation_repositories" r ON r."id" = pr."repository_id"
LEFT JOIN "external_links" el
  ON el."type" = 'PULL_REQUEST'
 AND el."metadata"->>'githubId' = pr."github_id"
ON CONFLICT ("artifact_id") DO UPDATE SET
    "body"                    = EXCLUDED."body",
    "head_sha"                = EXCLUDED."head_sha",
    "pr_state"                = EXCLUDED."pr_state",
    "is_draft"                = EXCLUDED."is_draft",
    "checks_status"           = EXCLUDED."checks_status",
    "review_decision"         = EXCLUDED."review_decision",
    "closed_at"               = EXCLUDED."closed_at",
    "merged_at"               = EXCLUDED."merged_at",
    "merge_commit_sha"        = EXCLUDED."merge_commit_sha",
    "last_verified_at"        = EXCLUDED."last_verified_at",
    "last_refresh_attempt_at" = EXCLUDED."last_refresh_attempt_at";

-- Deployments → artifacts + deployment_detail (catch up new deployments)
INSERT INTO "artifacts" (
    "id", "organization_id", "project_id", "workstream_id",
    "type", "subtype", "name", "slug", "assignee_id", "status",
    "priority", "external_url", "sort_order",
    "created_at", "created_by_id", "updated_at"
)
SELECT
    el."id", el."organization_id", el."project_id", el."workstream_id",
    'DEPLOYMENT'::"ArtifactType", NULL,
    el."title", NULL, NULL,
    COALESCE(UPPER(NULLIF(el."metadata"->>'state', '')), 'UNKNOWN'),
    NULL, el."external_url", NULL,
    el."created_at", NULL, el."updated_at"
FROM "external_links" el
WHERE el."type" = 'PREVIEW_DEPLOYMENT'
ON CONFLICT ("id") DO UPDATE SET
    "name"         = EXCLUDED."name",
    "status"       = EXCLUDED."status",
    "external_url" = EXCLUDED."external_url",
    "updated_at"   = EXCLUDED."updated_at";

INSERT INTO "deployment_detail" (
    "artifact_id", "environment", "ref", "sha",
    "github_status_url", "github_deployment_url",
    "transient", "production", "pull_request_artifact_id"
)
SELECT
    el."id",
    el."metadata"->>'environment',
    el."metadata"->>'ref',
    el."metadata"->>'sha',
    el."metadata"->>'statusUrl',
    el."metadata"->>'deploymentUrl',
    NULLIF(el."metadata"->>'transient', '')::boolean,
    NULLIF(el."metadata"->>'production', '')::boolean,
    -- Only resolve to PRs that actually landed in `artifacts` above —
    -- the join on github_installation_repositories may have skipped
    -- some, and writing a skipped pr.id here trips
    -- deployment_detail_pull_request_artifact_id_fkey from 2B.
    (SELECT pr."id"
       FROM "entity_links" lnk
       JOIN "external_links" src_el ON src_el."id" = lnk."source_id"
       JOIN "github_pull_requests" pr ON pr."github_id" = src_el."metadata"->>'githubId'
       JOIN "artifacts" a ON a."id" = pr."id"
      WHERE lnk."target_id" = el."id"
        AND lnk."source_type" = 'EXTERNAL_LINK'
        AND lnk."target_type" = 'EXTERNAL_LINK'
        AND lnk."link_type" = 'PRODUCES'
        AND src_el."type" = 'PULL_REQUEST'
      LIMIT 1)
FROM "external_links" el
WHERE el."type" = 'PREVIEW_DEPLOYMENT'
ON CONFLICT ("artifact_id") DO UPDATE SET
    "environment"              = EXCLUDED."environment",
    "ref"                      = EXCLUDED."ref",
    "sha"                      = EXCLUDED."sha",
    "github_status_url"        = EXCLUDED."github_status_url",
    "github_deployment_url"    = EXCLUDED."github_deployment_url",
    "transient"                = EXCLUDED."transient",
    "production"               = EXCLUDED."production",
    "pull_request_artifact_id" = EXCLUDED."pull_request_artifact_id";

-- =============================================================================
-- Phase 1.5 — drop PR rows whose repository was uninstalled
-- =============================================================================
-- github_pull_requests has never had an FK on repository_id, so installations
-- uninstalled in the past leave orphan PR rows behind. Phase 1's catch-up
-- already skipped them when promoting into artifacts/pull_request_detail.
-- Removing the legacy rows outright makes the rest of the migration safe:
--   - pull_request_ratings rows on these PRs are CASCADE-deleted, so
--     Phase 2's INSERT INTO artifact_ratings doesn't carry orphan-keyed rows
--     into the new table.
--   - github_pr_reviews / github_pr_review_comments rows on these PRs are
--     CASCADE-deleted, so Phase 4's retarget of pull_request_id onto
--     pull_request_detail.artifact_id passes FK validation.
-- The orphan PRs themselves are about to be dropped with github_pull_requests
-- in Phase 5; this just sequences the cleanup so dependents go first.
DELETE FROM "github_pull_requests" pr
 WHERE NOT EXISTS (
   SELECT 1 FROM "github_installation_repositories" r
    WHERE r."id" = pr."repository_id"
 );

-- =============================================================================
-- Phase 2 — consolidate pull_request_ratings into artifact_ratings
-- =============================================================================
-- `artifact_ratings` already maps to the DocumentRating table; we relax the
-- version column to nullable and absorb every pull_request_ratings row.
--
-- The legacy `artifact_ratings_artifact_id_fkey` was created against the old
-- `artifacts` table that the rename migration retargeted to `documents`.
-- The INSERT below carries github_pull_requests.id values that aren't in
-- `documents`, so we drop the legacy FK here. Phase 4 re-adds it pointing
-- at the new `artifacts` parent (its `DROP CONSTRAINT IF EXISTS` becomes a
-- no-op now, the ADD re-establishes the constraint).
ALTER TABLE "artifact_ratings"
  DROP CONSTRAINT IF EXISTS "artifact_ratings_artifact_id_fkey";

ALTER TABLE "artifact_ratings" ALTER COLUMN "artifact_version" DROP NOT NULL;

INSERT INTO "artifact_ratings" (
    "id", "artifact_id", "user_id", "organization_id", "score", "comment",
    "artifact_version", "created_at", "updated_at"
)
SELECT
    prr."id", prr."pull_request_id", prr."user_id", prr."organization_id",
    prr."score", prr."comment", NULL, prr."created_at", prr."updated_at"
FROM "pull_request_ratings" prr
ON CONFLICT ("artifact_id", "user_id", "organization_id") DO NOTHING;

-- Drop the legacy org-consistency trigger that enforced pull_request_ratings
-- rows matched github_pull_requests.organization_id — the FK on
-- artifact_ratings + app-layer validation make it redundant. Trigger name
-- is `pull_request_ratings_org_id_check`, created by 20260217170000.
DROP TRIGGER  IF EXISTS pull_request_ratings_org_id_check ON "pull_request_ratings";
DROP FUNCTION IF EXISTS check_pull_request_rating_organization_id();

-- =============================================================================
-- Phase 3 — polymorphic → FK column swaps
-- =============================================================================

-- comment_threads: entity_id/entity_type → artifact_id
ALTER TABLE "comment_threads" ADD COLUMN "artifact_id" UUID;

UPDATE "comment_threads"
SET "artifact_id" = "entity_id"
WHERE "entity_type" = 'DOCUMENT'
  AND EXISTS (SELECT 1 FROM "artifacts" a WHERE a."id" = "comment_threads"."entity_id");

DROP INDEX IF EXISTS "comment_threads_organization_id_entity_id_entity_type_status_idx";

ALTER TABLE "comment_threads"
  DROP COLUMN "entity_id",
  DROP COLUMN "entity_type";

ALTER TABLE "comment_threads"
  ADD CONSTRAINT "comment_threads_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE;

CREATE INDEX "comment_threads_organization_id_artifact_id_status_idx"
  ON "comment_threads"("organization_id", "artifact_id", "status");

-- artifact_evaluations: entity_id/entity_type + old artifact_id (FK to
-- documents) → single artifact_id FK to artifacts.
ALTER TABLE "artifact_evaluations" ADD COLUMN "artifact_id_new" UUID;

UPDATE "artifact_evaluations"
SET "artifact_id_new" = "entity_id"
WHERE "entity_type" = 'DOCUMENT'
  AND EXISTS (SELECT 1 FROM "artifacts" a WHERE a."id" = "artifact_evaluations"."entity_id");

-- Drop rows we can't link (shouldn't happen but safe)
DELETE FROM "artifact_evaluations" WHERE "artifact_id_new" IS NULL;

DROP INDEX IF EXISTS "artifact_evaluations_entity_id_created_at_idx";
DROP INDEX IF EXISTS "artifact_evaluations_organization_id_entity_type_created_at_idx";
DROP INDEX IF EXISTS "artifact_evaluations_entity_id_report_id_key";

ALTER TABLE "artifact_evaluations"
  DROP COLUMN "entity_id",
  DROP COLUMN "entity_type",
  DROP COLUMN "artifact_id";

ALTER TABLE "artifact_evaluations"
  RENAME COLUMN "artifact_id_new" TO "artifact_id";

ALTER TABLE "artifact_evaluations" ALTER COLUMN "artifact_id" SET NOT NULL;

ALTER TABLE "artifact_evaluations"
  ADD CONSTRAINT "artifact_evaluations_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "artifact_evaluations_artifact_id_report_id_key"
  ON "artifact_evaluations"("artifact_id", "report_id");
CREATE INDEX "artifact_evaluations_artifact_id_created_at_idx"
  ON "artifact_evaluations"("artifact_id", "created_at");
CREATE INDEX "artifact_evaluations_organization_id_created_at_idx"
  ON "artifact_evaluations"("organization_id", "created_at");

-- =============================================================================
-- Phase 4 — FK retargets onto new tables
-- =============================================================================

-- github_pr_reviews.pull_request_id: github_pull_requests.id → pull_request_detail.artifact_id
ALTER TABLE "github_pr_reviews"
  DROP CONSTRAINT IF EXISTS "github_pr_reviews_pull_request_id_fkey";
ALTER TABLE "github_pr_reviews"
  ADD CONSTRAINT "github_pr_reviews_pull_request_id_fkey"
    FOREIGN KEY ("pull_request_id") REFERENCES "pull_request_detail"("artifact_id") ON DELETE CASCADE;

ALTER TABLE "github_pr_review_comments"
  DROP CONSTRAINT IF EXISTS "github_pr_review_comments_pull_request_id_fkey";
ALTER TABLE "github_pr_review_comments"
  ADD CONSTRAINT "github_pr_review_comments_pull_request_id_fkey"
    FOREIGN KEY ("pull_request_id") REFERENCES "pull_request_detail"("artifact_id") ON DELETE CASCADE;

-- github_action_run_performances.artifact_id: documents.id → document_detail.artifact_id
ALTER TABLE "github_action_run_performances"
  DROP CONSTRAINT IF EXISTS "github_action_run_performances_artifact_id_fkey";
ALTER TABLE "github_action_run_performances"
  ADD CONSTRAINT "github_action_run_performances_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "document_detail"("artifact_id") ON DELETE CASCADE;

-- artifact_generation_status_dismissals.artifact_id: documents.id → artifacts.id
ALTER TABLE "artifact_generation_status_dismissals"
  DROP CONSTRAINT IF EXISTS "artifact_generation_status_dismissals_artifact_id_fkey";
ALTER TABLE "artifact_generation_status_dismissals"
  DROP CONSTRAINT IF EXISTS "artifact_generation_status_dismissals_document_id_fkey";
ALTER TABLE "artifact_generation_status_dismissals"
  ADD CONSTRAINT "artifact_generation_status_dismissals_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE;

-- file_attachments.artifact_id: documents.id → artifacts.id
ALTER TABLE "file_attachments"
  DROP CONSTRAINT IF EXISTS "file_attachments_artifact_id_fkey";
ALTER TABLE "file_attachments"
  DROP CONSTRAINT IF EXISTS "file_attachments_document_id_fkey";
ALTER TABLE "file_attachments"
  ADD CONSTRAINT "file_attachments_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE;

-- document_versions.document_id (col name artifact_id): documents.id → document_detail.artifact_id
ALTER TABLE "document_versions"
  DROP CONSTRAINT IF EXISTS "document_versions_artifact_id_fkey";
ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_document_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "document_detail"("artifact_id") ON DELETE CASCADE;

-- loops.artifact_id: documents.id → artifacts.id (onDelete SetNull)
ALTER TABLE "loops"
  DROP CONSTRAINT IF EXISTS "loops_artifact_id_fkey";
ALTER TABLE "loops"
  DROP CONSTRAINT IF EXISTS "loops_document_id_fkey";
ALTER TABLE "loops"
  ADD CONSTRAINT "loops_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL;

-- artifact_ratings.artifact_id: documents.id → artifacts.id
ALTER TABLE "artifact_ratings"
  DROP CONSTRAINT IF EXISTS "artifact_ratings_artifact_id_fkey";
ALTER TABLE "artifact_ratings"
  ADD CONSTRAINT "artifact_ratings_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE;

-- Ensure user/organization FKs exist on artifact_ratings (they may have been
-- inherited from the legacy DocumentRating model; re-assert for safety).
ALTER TABLE "artifact_ratings"
  DROP CONSTRAINT IF EXISTS "artifact_ratings_user_id_fkey";
ALTER TABLE "artifact_ratings"
  ADD CONSTRAINT "artifact_ratings_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

ALTER TABLE "artifact_ratings"
  DROP CONSTRAINT IF EXISTS "artifact_ratings_organization_id_fkey";
ALTER TABLE "artifact_ratings"
  ADD CONSTRAINT "artifact_ratings_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

-- =============================================================================
-- Phase 5 — drop legacy tables
-- =============================================================================

DROP TABLE "pull_request_ratings";
DROP TABLE "github_pull_requests";
DROP TABLE "external_links";
DROP TABLE "entity_links";
DROP TABLE "documents";

-- =============================================================================
-- Phase 6 — drop legacy enums
-- =============================================================================

DROP TYPE "DocumentType";
DROP TYPE "EntityType";
DROP TYPE "ExternalLinkType";
