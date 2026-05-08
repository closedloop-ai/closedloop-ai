-- Chunk 2B of PLN-321 (PRD-186 Artifact Schema Refactor): additive schema
-- for PULL_REQUEST- and DEPLOYMENT-typed artifacts. Legacy tables
-- (`github_pull_requests`, `external_links`, `entity_links`,
-- `pull_request_ratings`) are unchanged and remain the read path until
-- the final contract migration (2F) drops them.
--
-- Row IDs are reused across both shapes: artifact.id = github_pull_requests.id
-- for PRs and artifact.id = external_links.id for deployments. This keeps
-- existing FKs pointing at the original tables valid while readers flip
-- over progressively, and lets 2F retarget child-table FKs onto the new
-- detail tables without a separate id-remap step.

-- 1. Parent and detail tables
CREATE TABLE IF NOT EXISTS "pull_request_detail" (
    "artifact_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "github_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "body" TEXT,
    "head_branch" TEXT NOT NULL,
    "base_branch" TEXT NOT NULL,
    "head_sha" TEXT,
    "pr_state" "GitHubPRState" NOT NULL DEFAULT 'OPEN',
    "is_draft" BOOLEAN NOT NULL DEFAULT false,
    "checks_status" "ChecksStatus" NOT NULL DEFAULT 'UNKNOWN',
    "review_decision" "ReviewDecision",
    "closed_at" TIMESTAMP(3),
    "merged_at" TIMESTAMP(3),
    "merge_commit_sha" TEXT,
    "last_verified_at" TIMESTAMP(3),
    "last_refresh_attempt_at" TIMESTAMP(3),
    CONSTRAINT "pull_request_detail_pkey" PRIMARY KEY ("artifact_id")
);

CREATE TABLE IF NOT EXISTS "deployment_detail" (
    "artifact_id" UUID NOT NULL,
    "environment" TEXT,
    "ref" TEXT,
    "sha" TEXT,
    "github_status_url" TEXT,
    "github_deployment_url" TEXT,
    "transient" BOOLEAN,
    "production" BOOLEAN,
    "pull_request_artifact_id" UUID,
    CONSTRAINT "deployment_detail_pkey" PRIMARY KEY ("artifact_id")
);

-- 2. Promote github_pull_requests into artifacts + pull_request_detail.
-- Row ids stay stable so github_pr_reviews / github_pr_review_comments
-- can retarget onto pull_request_detail.artifact_id in 2F without a lookup.
--
-- artifact.createdById is NULL per plan decision #11 (migrated PR rows have
-- no deterministic creator). projectId resolves via the PR's workstream.
-- html_url becomes the parent's externalUrl; title becomes name; state
-- becomes the parent's TEXT status.
--
-- Skip orphans defensively: PRs referencing workstreams that don't exist
-- (shouldn't happen under the current FK, but belt-and-suspenders), and
-- PRs whose repository_id no longer resolves to a row in
-- github_installation_repositories. The legacy github_pull_requests table
-- has never had an FK on repository_id, so installations uninstalled in
-- the past leave behind orphan PR rows. Skipping them here keeps step 9's
-- pull_request_detail_repository_id_fkey valid; the orphan rows remain
-- in the legacy table until 2F retires it.
INSERT INTO "artifacts" (
    "id",
    "organization_id",
    "project_id",
    "workstream_id",
    "type",
    "subtype",
    "name",
    "slug",
    "assignee_id",
    "status",
    "priority",
    "external_url",
    "sort_order",
    "created_at",
    "created_by_id",
    "updated_at"
)
SELECT
    pr."id",
    pr."organization_id",
    w."project_id",
    pr."workstream_id",
    'PULL_REQUEST'::"ArtifactType",
    NULL,
    pr."title",
    NULL,
    NULL,
    pr."state"::text,
    NULL,
    pr."html_url",
    NULL,
    pr."created_at",
    NULL,
    pr."updated_at"
FROM "github_pull_requests" pr
JOIN "workstreams" w ON w."id" = pr."workstream_id"
JOIN "github_installation_repositories" r ON r."id" = pr."repository_id";

-- 3. Fill pull_request_detail for every PR row we just promoted.
-- last_verified_at / last_refresh_attempt_at come from today's
-- ExternalLink PR metadata keyed on github_id; a PR with no external_link
-- row (rare) simply gets NULL there.
INSERT INTO "pull_request_detail" (
    "artifact_id",
    "repository_id",
    "github_id",
    "number",
    "body",
    "head_branch",
    "base_branch",
    "head_sha",
    "pr_state",
    "is_draft",
    "checks_status",
    "review_decision",
    "closed_at",
    "merged_at",
    "merge_commit_sha",
    "last_verified_at",
    "last_refresh_attempt_at"
)
SELECT
    pr."id",
    pr."repository_id",
    pr."github_id",
    pr."number",
    pr."body",
    pr."head_branch",
    pr."base_branch",
    pr."head_sha",
    pr."state",
    pr."is_draft",
    pr."checks_status",
    pr."review_decision",
    pr."closed_at",
    pr."merged_at",
    pr."merge_commit_sha",
    NULLIF(el."metadata"->>'lastVerifiedAt', '')::timestamp(3),
    NULLIF(el."metadata"->>'lastRefreshAttemptAt', '')::timestamp(3)
FROM "github_pull_requests" pr
JOIN "github_installation_repositories" r ON r."id" = pr."repository_id"
LEFT JOIN "external_links" el
  ON el."type" = 'PULL_REQUEST'
 AND el."metadata"->>'githubId' = pr."github_id";

-- 4. Promote PREVIEW_DEPLOYMENT external_links into artifacts +
-- deployment_detail. IDs reuse external_links.id so any entity_link
-- referencing the deployment keeps its target id.
INSERT INTO "artifacts" (
    "id",
    "organization_id",
    "project_id",
    "workstream_id",
    "type",
    "subtype",
    "name",
    "slug",
    "assignee_id",
    "status",
    "priority",
    "external_url",
    "sort_order",
    "created_at",
    "created_by_id",
    "updated_at"
)
SELECT
    el."id",
    el."organization_id",
    el."project_id",
    el."workstream_id",
    'DEPLOYMENT'::"ArtifactType",
    NULL,
    el."title",
    NULL,
    NULL,
    COALESCE(UPPER(NULLIF(el."metadata"->>'state', '')), 'UNKNOWN'),
    NULL,
    el."external_url",
    NULL,
    el."created_at",
    NULL,
    el."updated_at"
FROM "external_links" el
WHERE el."type" = 'PREVIEW_DEPLOYMENT';

-- 5. Temporary mapping from PR external_link ids → github_pull_requests.id,
-- used for two remaps below.
--
-- Only include PRs that were actually promoted to `artifacts` in step 2 —
-- otherwise step 6's subquery can resolve `pull_request_artifact_id` to a
-- skipped orphan PR id, tripping `deployment_detail_pull_request_artifact_id_fkey`
-- in step 9. The JOIN against `artifacts` keeps this mapping in lockstep
-- with whatever orphan filters step 2 applies.
CREATE TEMP TABLE _pln321_pr_el_to_pr AS
SELECT
    el."id"   AS external_link_id,
    pr."id"   AS pr_id
FROM "external_links" el
JOIN "github_pull_requests" pr
  ON pr."github_id" = el."metadata"->>'githubId'
JOIN "artifacts" a ON a."id" = pr."id"
WHERE el."type" = 'PULL_REQUEST';

-- 6. Deployment detail rows. pull_request_artifact_id is populated from
-- the entity_link where an EXTERNAL_LINK(PR) PRODUCES an
-- EXTERNAL_LINK(DEPLOYMENT), remapped onto the PR artifact id.
INSERT INTO "deployment_detail" (
    "artifact_id",
    "environment",
    "ref",
    "sha",
    "github_status_url",
    "github_deployment_url",
    "transient",
    "production",
    "pull_request_artifact_id"
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
    (SELECT m."pr_id"
       FROM "entity_links" lnk
       JOIN _pln321_pr_el_to_pr m ON m."external_link_id" = lnk."source_id"
      WHERE lnk."target_id" = el."id"
        AND lnk."source_type" = 'EXTERNAL_LINK'
        AND lnk."target_type" = 'EXTERNAL_LINK'
        AND lnk."link_type" = 'PRODUCES'
      LIMIT 1)
FROM "external_links" el
WHERE el."type" = 'PREVIEW_DEPLOYMENT';

-- 7. Backfill artifact_links for PR/Deployment relationships.
-- Every insert is guarded against orphans (entity_links has no FK to
-- documents/external_links/github_pull_requests, so stale rows exist).
-- The unique index `artifact_links_source_id_target_id_link_type_key`
-- from 2A dedups repeated edges.
--
-- a) PR → Document PRODUCES edges from the legacy github_pull_requests FK.
-- The column on `github_pull_requests` is named `artifact_id` in Postgres
-- (it was preserved by the rename migration) even though the Prisma field
-- is called `documentId`. Use the real column name here.
INSERT INTO "artifact_links" (
    "id",
    "organization_id",
    "source_id",
    "target_id",
    "link_type",
    "created_at"
)
SELECT
    gen_random_uuid(),
    pr."organization_id",
    pr."artifact_id",
    pr."id",
    'PRODUCES',
    pr."created_at"
FROM "github_pull_requests" pr
WHERE pr."artifact_id" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "artifacts" a WHERE a."id" = pr."artifact_id")
  AND EXISTS (SELECT 1 FROM "artifacts" a WHERE a."id" = pr."id")
ON CONFLICT ("source_id", "target_id", "link_type") DO NOTHING;

-- b) DOCUMENT → EXTERNAL_LINK(PR) entity_links — remap target to PR id.
INSERT INTO "artifact_links" (
    "id",
    "organization_id",
    "source_id",
    "target_id",
    "link_type",
    "metadata",
    "created_at"
)
SELECT
    lnk."id",
    lnk."organization_id",
    lnk."source_id",
    m."pr_id",
    lnk."link_type",
    lnk."metadata",
    lnk."created_at"
FROM "entity_links" lnk
JOIN _pln321_pr_el_to_pr m ON m."external_link_id" = lnk."target_id"
WHERE lnk."source_type" = 'DOCUMENT'
  AND lnk."target_type" = 'EXTERNAL_LINK'
  AND EXISTS (SELECT 1 FROM "artifacts" a WHERE a."id" = lnk."source_id")
  AND EXISTS (SELECT 1 FROM "artifacts" a WHERE a."id" = m."pr_id")
ON CONFLICT ("source_id", "target_id", "link_type") DO NOTHING;

-- c) DOCUMENT → EXTERNAL_LINK(PREVIEW_DEPLOYMENT) entity_links — target id
-- is already reused by the artifact row we inserted in step 4.
INSERT INTO "artifact_links" (
    "id",
    "organization_id",
    "source_id",
    "target_id",
    "link_type",
    "metadata",
    "created_at"
)
SELECT
    lnk."id",
    lnk."organization_id",
    lnk."source_id",
    lnk."target_id",
    lnk."link_type",
    lnk."metadata",
    lnk."created_at"
FROM "entity_links" lnk
JOIN "external_links" el ON el."id" = lnk."target_id"
WHERE lnk."source_type" = 'DOCUMENT'
  AND lnk."target_type" = 'EXTERNAL_LINK'
  AND el."type" = 'PREVIEW_DEPLOYMENT'
  AND EXISTS (SELECT 1 FROM "artifacts" a WHERE a."id" = lnk."source_id")
  AND EXISTS (SELECT 1 FROM "artifacts" a WHERE a."id" = lnk."target_id")
ON CONFLICT ("source_id", "target_id", "link_type") DO NOTHING;

-- d) EXTERNAL_LINK(PR) → EXTERNAL_LINK(PREVIEW_DEPLOYMENT) entity_links —
-- remap source to PR id; target is already the deployment artifact id.
INSERT INTO "artifact_links" (
    "id",
    "organization_id",
    "source_id",
    "target_id",
    "link_type",
    "metadata",
    "created_at"
)
SELECT
    lnk."id",
    lnk."organization_id",
    m."pr_id",
    lnk."target_id",
    lnk."link_type",
    lnk."metadata",
    lnk."created_at"
FROM "entity_links" lnk
JOIN _pln321_pr_el_to_pr m ON m."external_link_id" = lnk."source_id"
JOIN "external_links" el ON el."id" = lnk."target_id"
WHERE lnk."source_type" = 'EXTERNAL_LINK'
  AND lnk."target_type" = 'EXTERNAL_LINK'
  AND el."type" = 'PREVIEW_DEPLOYMENT'
  AND EXISTS (SELECT 1 FROM "artifacts" a WHERE a."id" = m."pr_id")
  AND EXISTS (SELECT 1 FROM "artifacts" a WHERE a."id" = lnk."target_id")
ON CONFLICT ("source_id", "target_id", "link_type") DO NOTHING;

DROP TABLE _pln321_pr_el_to_pr;

-- FIGMA_DESIGN entity_links are intentionally dropped per Decision #5;
-- no insert for them.

-- 8. Indexes on the new detail tables (names match Prisma's defaults).
CREATE UNIQUE INDEX "pull_request_detail_github_id_key"
    ON "pull_request_detail"("github_id");

CREATE UNIQUE INDEX "pull_request_detail_repository_id_number_key"
    ON "pull_request_detail"("repository_id", "number");

CREATE INDEX "pull_request_detail_head_sha_idx"
    ON "pull_request_detail"("head_sha");

CREATE INDEX "deployment_detail_pull_request_artifact_id_idx"
    ON "deployment_detail"("pull_request_artifact_id");

CREATE INDEX "deployment_detail_ref_sha_idx"
    ON "deployment_detail"("ref", "sha");

-- 9. FKs on the new detail tables. Added last so backfills complete first;
-- the JOIN-guarded inserts above guarantee every row has a parent.
ALTER TABLE "pull_request_detail"
    ADD CONSTRAINT "pull_request_detail_artifact_id_fkey"
        FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pull_request_detail"
    ADD CONSTRAINT "pull_request_detail_repository_id_fkey"
        FOREIGN KEY ("repository_id") REFERENCES "github_installation_repositories"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deployment_detail"
    ADD CONSTRAINT "deployment_detail_artifact_id_fkey"
        FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deployment_detail"
    ADD CONSTRAINT "deployment_detail_pull_request_artifact_id_fkey"
        FOREIGN KEY ("pull_request_artifact_id") REFERENCES "artifacts"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
