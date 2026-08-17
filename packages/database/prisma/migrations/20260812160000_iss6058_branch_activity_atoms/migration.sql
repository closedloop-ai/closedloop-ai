-- ISS-6058: additive provenance-bearing Branch activity atoms.
-- The existing Branch aggregate remains in place for application rollback and
-- staggered deploy compatibility. Only durable identities with authoritative
-- occurrence/completion timestamps are promoted below.
-- Prisma owns the table, relation, and index names in schema.prisma. The
-- organization-scoped foreign-key target indexes are prepared concurrently in
-- the immediately preceding migration. This SQL is hand-edited because Prisma
-- cannot express the CHECK constraints or data backfill; those additions
-- enforce normalized immutable identities, attribution coupling, and
-- trustworthy-only promotion.

-- CreateTable
CREATE TABLE "branch_activity_atoms" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_artifact_id" UUID NOT NULL,
    "source" VARCHAR(128) NOT NULL,
    "source_event_id" VARCHAR(512) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "attribution_kind" VARCHAR(32) NOT NULL,
    "pull_request_detail_id" UUID,
    "completeness" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_activity_atoms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "branch_activity_atoms_version_check" CHECK ("version" >= 1),
    CONSTRAINT "branch_activity_atoms_source_nonempty" CHECK ("source" = btrim("source") AND length("source") > 0),
    CONSTRAINT "branch_activity_atoms_source_event_nonempty" CHECK ("source_event_id" = btrim("source_event_id") AND length("source_event_id") > 0),
    CONSTRAINT "branch_activity_atoms_attribution_kind_check" CHECK ("attribution_kind" IN ('branch', 'pull_request')),
    CONSTRAINT "branch_activity_atoms_completeness_check" CHECK ("completeness" IN ('complete', 'partial')),
    CONSTRAINT "branch_activity_atoms_attribution_check" CHECK (
        ("attribution_kind" = 'branch' AND "pull_request_detail_id" IS NULL)
        OR
        ("attribution_kind" = 'pull_request' AND "pull_request_detail_id" IS NOT NULL)
    ),
    CONSTRAINT "branch_activity_atoms_dedupe_key" UNIQUE ("organization_id", "branch_artifact_id", "source", "source_event_id")
);

-- CreateIndex
-- index-lock-ok(branch_activity_atoms): table is created empty in this same migration so the latest-read index build locks zero rows with no concurrent writer, and CONCURRENTLY must stay in a bare migration rather than mix with this table DDL and backfill
CREATE INDEX IF NOT EXISTS "branch_activity_atoms_latest_idx"
ON "branch_activity_atoms"("organization_id", "branch_artifact_id", "occurred_at" DESC, "source", "source_event_id");

-- AddForeignKey
ALTER TABLE "branch_activity_atoms" ADD CONSTRAINT "branch_activity_atoms_organization_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_activity_atoms" ADD CONSTRAINT "branch_activity_atoms_branch_fkey"
FOREIGN KEY ("organization_id", "branch_artifact_id")
REFERENCES "branch_detail"("organization_id", "artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_activity_atoms" ADD CONSTRAINT "branch_activity_atoms_pull_request_fkey"
FOREIGN KEY ("organization_id", "pull_request_detail_id")
REFERENCES "pull_request_detail"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill provider push-backed current-head evidence. A head SHA supplies
-- stable source identity, while the push_webhook source proves that the
-- observation time came from genuine remote push evidence rather than a
-- routine authoritative refresh of an unchanged head.
INSERT INTO "branch_activity_atoms" (
    "id",
    "version",
    "organization_id",
    "branch_artifact_id",
    "source",
    "source_event_id",
    "occurred_at",
    "attribution_kind",
    "pull_request_detail_id",
    "completeness"
)
SELECT
    gen_random_uuid(),
    1,
    branch."organization_id",
    branch."artifact_id",
    'git_head',
    branch."head_sha",
    branch."head_sha_observed_at",
    'branch',
    NULL,
    'complete'
FROM "branch_detail" AS branch
WHERE branch."head_sha" IS NOT NULL
  AND branch."head_sha_observed_at" IS NOT NULL
  AND branch."head_sha_source" = 'push_webhook'
  AND branch."head_sha" = btrim(branch."head_sha")
  AND length(branch."head_sha") BETWEEN 1 AND 512
ON CONFLICT ("organization_id", "branch_artifact_id", "source", "source_event_id") DO NOTHING;

-- Backfill associated pull-request lifecycle evidence. Each source id combines
-- the immutable PR detail id with the lifecycle boundary it represents.
INSERT INTO "branch_activity_atoms" (
    "id",
    "version",
    "organization_id",
    "branch_artifact_id",
    "source",
    "source_event_id",
    "occurred_at",
    "attribution_kind",
    "pull_request_detail_id",
    "completeness"
)
SELECT
    gen_random_uuid(),
    1,
    lifecycle."organization_id",
    lifecycle."branch_artifact_id",
    'pull_request_lifecycle',
    lifecycle."source_event_id",
    lifecycle."occurred_at",
    'pull_request',
    lifecycle."pull_request_detail_id",
    'complete'
FROM (
    SELECT
        branch."organization_id",
        pr."branch_artifact_id",
        pr."id" AS "pull_request_detail_id",
        pr."id"::text || ':opened' AS "source_event_id",
        pr."github_created_at" AS "occurred_at"
    FROM "pull_request_detail" AS pr
    INNER JOIN "branch_detail" AS branch
      ON branch."artifact_id" = pr."branch_artifact_id"
     AND branch."organization_id" = pr."organization_id"
    WHERE pr."github_created_at" IS NOT NULL

    UNION ALL

    SELECT
        branch."organization_id",
        pr."branch_artifact_id",
        pr."id" AS "pull_request_detail_id",
        pr."id"::text || ':merged' AS "source_event_id",
        pr."merged_at" AS "occurred_at"
    FROM "pull_request_detail" AS pr
    INNER JOIN "branch_detail" AS branch
      ON branch."artifact_id" = pr."branch_artifact_id"
     AND branch."organization_id" = pr."organization_id"
    WHERE pr."merged_at" IS NOT NULL

    UNION ALL

    SELECT
        branch."organization_id",
        pr."branch_artifact_id",
        pr."id" AS "pull_request_detail_id",
        pr."id"::text || ':closed' AS "source_event_id",
        pr."closed_at" AS "occurred_at"
    FROM "pull_request_detail" AS pr
    INNER JOIN "branch_detail" AS branch
      ON branch."artifact_id" = pr."branch_artifact_id"
     AND branch."organization_id" = pr."organization_id"
    WHERE pr."closed_at" IS NOT NULL
) AS lifecycle
ON CONFLICT ("organization_id", "branch_artifact_id", "source", "source_event_id") DO NOTHING;

-- Backfill submitted PR review evidence from its provider-stable review id and
-- authoritative submission timestamp.
INSERT INTO "branch_activity_atoms" (
    "id",
    "version",
    "organization_id",
    "branch_artifact_id",
    "source",
    "source_event_id",
    "occurred_at",
    "attribution_kind",
    "pull_request_detail_id",
    "completeness"
)
SELECT
    gen_random_uuid(),
    1,
    branch."organization_id",
    pr."branch_artifact_id",
    'pull_request_review',
    review."github_review_id",
    review."submitted_at",
    'pull_request',
    pr."id",
    'complete'
FROM "github_pr_reviews" AS review
INNER JOIN "pull_request_detail" AS pr ON pr."id" = review."pull_request_id"
INNER JOIN "branch_detail" AS branch
  ON branch."artifact_id" = pr."branch_artifact_id"
 AND branch."organization_id" = pr."organization_id"
WHERE review."github_review_id" = btrim(review."github_review_id")
  AND length(review."github_review_id") BETWEEN 1 AND 512
ON CONFLICT ("organization_id", "branch_artifact_id", "source", "source_event_id") DO NOTHING;
