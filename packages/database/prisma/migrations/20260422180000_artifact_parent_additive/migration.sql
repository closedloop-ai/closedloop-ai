-- Chunk 2a of PLN-321 (PRD-186 Artifact Schema Refactor): additive schema
-- that introduces the `Artifact` parent, `DocumentDetail`, `ArtifactLink`, and
-- the templates-sentinel flag on `Project`. No drops, no renames. Legacy
-- `documents`/`external_links`/`entity_links`/`github_pull_requests` tables
-- are unchanged and remain the read path until Chunk 2d reader flips.
--
-- Dual-writes wired into `documentsService` keep `documents` and `artifacts`
-- in lockstep for DOCUMENT-typed artifacts after this migration lands.
-- Chunks 2b/2c follow with additive PR/deployment detail tables and rating
-- consolidation; Chunk 2e contracts by dropping legacy.

-- 1. Enums
CREATE TYPE "ArtifactType" AS ENUM ('DOCUMENT', 'PULL_REQUEST', 'DEPLOYMENT');

CREATE TYPE "ArtifactSubtype" AS ENUM ('PRD', 'IMPLEMENTATION_PLAN', 'TEMPLATE', 'FEATURE');

-- 2. Parent and detail tables
CREATE TABLE "artifacts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "workstream_id" UUID,
    "type" "ArtifactType" NOT NULL,
    "subtype" "ArtifactSubtype",
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "assignee_id" UUID,
    "status" TEXT NOT NULL,
    "priority" "Priority",
    "due_date" TIMESTAMP(3),
    "external_url" TEXT,
    "sort_order" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_detail" (
    "artifact_id" UUID NOT NULL,
    "file_name" TEXT,
    "approver_id" UUID,
    "template_for_type" "ArtifactSubtype",
    "latest_version" INTEGER NOT NULL DEFAULT 1,
    "target_repo" TEXT,
    "target_branch" TEXT,
    CONSTRAINT "document_detail_pkey" PRIMARY KEY ("artifact_id")
);

CREATE TABLE "artifact_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "link_type" "LinkType" NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "artifact_links_pkey" PRIMARY KEY ("id")
);

-- 3. Project templates-sentinel flag + its indexes
ALTER TABLE "projects" ADD COLUMN "is_templates_sentinel" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "projects_organization_id_is_templates_sentinel_idx"
    ON "projects"("organization_id", "is_templates_sentinel");

-- Partial unique index enforces at most one sentinel per organization
-- (Prisma cannot express partial indexes; maintained via raw migration.)
CREATE UNIQUE INDEX "projects_org_one_templates_sentinel"
    ON "projects"("organization_id") WHERE "is_templates_sentinel";

-- 4. One sentinel project per organization (skipped for orgs with no users;
-- `documentsService` lazily creates it on first template write for those).
INSERT INTO "projects" (
    "id",
    "organization_id",
    "name",
    "is_templates_sentinel",
    "created_by_id",
    "settings",
    "priority",
    "status",
    "created_at",
    "updated_at"
)
SELECT
    gen_random_uuid(),
    o."id",
    'Templates',
    true,
    (SELECT u."id" FROM "users" u
      WHERE u."organization_id" = o."id"
      ORDER BY u."created_at" ASC
      LIMIT 1),
    '{}'::jsonb,
    'MEDIUM'::"Priority",
    'NOT_STARTED'::"ProjectStatus",
    NOW(),
    NOW()
FROM "organizations" o
WHERE NOT EXISTS (
    SELECT 1 FROM "projects" p
    WHERE p."organization_id" = o."id" AND p."is_templates_sentinel"
  )
  AND EXISTS (
    SELECT 1 FROM "users" u WHERE u."organization_id" = o."id"
  );

-- 5. Backfill artifacts from documents. Every existing document row gets a
-- paired artifact row with the same id, so consumer code can follow ids
-- across both shapes during the expand/contract window.
--
-- Zero-user orgs were skipped in step 4, so their template documents have
-- no sentinel project to land on and COALESCE would resolve to NULL. The
-- guard in the WHERE clause filters those rows out; `documentsService`
-- creates the sentinel lazily on the first template write from a user
-- that joins such an org, and a subsequent reconciliation job will
-- backfill the skipped rows before Chunk 2d reader flips.
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
    d."id",
    d."organization_id",
    COALESCE(
        d."project_id",
        (SELECT p."id" FROM "projects" p
          WHERE p."organization_id" = d."organization_id"
            AND p."is_templates_sentinel")
    ),
    d."workstream_id",
    'DOCUMENT'::"ArtifactType",
    d."type"::text::"ArtifactSubtype",
    d."title",
    d."slug",
    d."assignee_id",
    d."status"::text,
    d."priority",
    NULL,
    d."sort_order",
    d."created_at",
    d."created_by_id",
    d."updated_at"
FROM "documents" d
WHERE d."project_id" IS NOT NULL
   OR EXISTS (
        SELECT 1 FROM "projects" p
        WHERE p."organization_id" = d."organization_id"
          AND p."is_templates_sentinel"
    );

-- 6. Backfill document_detail only for documents that got an artifact
-- parent in step 5. Inner-joining on the freshly-inserted `artifacts` rows
-- keeps the invariant local: no parent, no detail row. Otherwise step 9's
-- FK (document_detail.artifact_id → artifacts.id) would reject the orphans
-- that a zero-user-org template document would produce and abort the
-- migration mid-way.
INSERT INTO "document_detail" (
    "artifact_id",
    "file_name",
    "approver_id",
    "template_for_type",
    "latest_version",
    "target_repo",
    "target_branch"
)
SELECT
    d."id",
    d."file_name",
    d."approver_id",
    d."template_for_type"::text::"ArtifactSubtype",
    d."latest_version",
    d."target_repo",
    d."target_branch"
FROM "documents" d
JOIN "artifacts" a ON a."id" = d."id";

-- 7. Indexes on artifacts (names match Prisma's default generation so that
-- future `prisma migrate dev` runs don't detect drift).
CREATE UNIQUE INDEX "artifacts_organization_id_slug_key"
    ON "artifacts"("organization_id", "slug");

CREATE INDEX "artifacts_organization_id_project_id_type_idx"
    ON "artifacts"("organization_id", "project_id", "type");

CREATE INDEX "artifacts_organization_id_workstream_id_type_idx"
    ON "artifacts"("organization_id", "workstream_id", "type");

CREATE INDEX "artifacts_organization_id_type_status_idx"
    ON "artifacts"("organization_id", "type", "status");

CREATE INDEX "artifacts_organization_id_assignee_id_idx"
    ON "artifacts"("organization_id", "assignee_id");

-- 8. FK constraints on artifacts.
ALTER TABLE "artifacts"
    ADD CONSTRAINT "artifacts_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "artifacts"
    ADD CONSTRAINT "artifacts_project_id_fkey"
        FOREIGN KEY ("project_id") REFERENCES "projects"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "artifacts"
    ADD CONSTRAINT "artifacts_workstream_id_fkey"
        FOREIGN KEY ("workstream_id") REFERENCES "workstreams"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "artifacts"
    ADD CONSTRAINT "artifacts_assignee_id_fkey"
        FOREIGN KEY ("assignee_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "artifacts"
    ADD CONSTRAINT "artifacts_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

-- 9. FK constraints on document_detail.
ALTER TABLE "document_detail"
    ADD CONSTRAINT "document_detail_artifact_id_fkey"
        FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_detail"
    ADD CONSTRAINT "document_detail_approver_id_fkey"
        FOREIGN KEY ("approver_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

-- 10. Indexes and FK constraints on artifact_links. The unique index is
-- created before the DOCUMENT↔DOCUMENT backfill so we can dedup against
-- future PR/Deployment inserts in Chunk 2b.
CREATE UNIQUE INDEX "artifact_links_source_id_target_id_link_type_key"
    ON "artifact_links"("source_id", "target_id", "link_type");

CREATE INDEX "artifact_links_organization_id_source_id_link_type_idx"
    ON "artifact_links"("organization_id", "source_id", "link_type");

CREATE INDEX "artifact_links_organization_id_target_id_link_type_idx"
    ON "artifact_links"("organization_id", "target_id", "link_type");

ALTER TABLE "artifact_links"
    ADD CONSTRAINT "artifact_links_source_id_fkey"
        FOREIGN KEY ("source_id") REFERENCES "artifacts"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "artifact_links"
    ADD CONSTRAINT "artifact_links_target_id_fkey"
        FOREIGN KEY ("target_id") REFERENCES "artifacts"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

-- 11. Backfill artifact_links from DOCUMENT↔DOCUMENT entity_links. PR and
-- deployment links land in Chunk 2b; FIGMA_DESIGN links are intentionally
-- dropped per the plan's Decision #5.
--
-- `entity_links` has no FK to `documents`, so orphan rows pointing at
-- deleted documents can exist in the wild. The FK on `artifact_links`
-- would reject those rows because the artifact parent only contains ids
-- that are still in `documents`. The EXISTS guards drop the orphans up
-- front; step 5 would have skipped those documents' artifact rows too.
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
    el."id",
    el."organization_id",
    el."source_id",
    el."target_id",
    el."link_type",
    el."metadata",
    el."created_at"
FROM "entity_links" el
WHERE el."source_type" = 'DOCUMENT'
  AND el."target_type" = 'DOCUMENT'
  AND EXISTS (
        SELECT 1 FROM "artifacts" a WHERE a."id" = el."source_id"
    )
  AND EXISTS (
        SELECT 1 FROM "artifacts" a WHERE a."id" = el."target_id"
    )
ON CONFLICT ("source_id", "target_id", "link_type") DO NOTHING;
