-- Final cleanup for PLN-624. The legacy GitHub PR review-comment table is
-- removed after unified comment projection storage became the only live path.
-- GitHub PR review state (`github_pr_reviews`) and unified comment projection
-- tables are intentionally preserved.
DROP INDEX IF EXISTS "github_comment_thread_projections_pr_root_comment_unique";
DROP INDEX IF EXISTS "github_comment_thread_projections_pr_review_thread_unique";
DROP INDEX IF EXISTS "github_comment_thread_projections_root_comment_idx";
DROP INDEX IF EXISTS "github_comment_thread_projections_review_thread_idx";

-- Reconcile any unified projections written before source-kind identities were
-- mandatory. Raw provider ids remain in "github_comment_projections"; generic
-- Comment.external_id values carry the source-kind namespace.
UPDATE "github_comment_thread_projections" projection
SET "thread_kind" = (
  CASE
    WHEN legacy."review_id" IS NOT NULL OR legacy."path" IS NOT NULL
      THEN 'REVIEW_THREAD'
    ELSE 'ISSUE_COMMENT'
  END
)::"GitHubCommentThreadKind"
FROM "github_pr_review_comments" legacy
JOIN "pull_request_detail" pr
  ON pr."id" = legacy."pull_request_id"
WHERE projection."thread_kind" IS NULL
  AND projection."pull_request_detail_id" = legacy."pull_request_id"
  AND projection."branch_artifact_id" = pr."branch_artifact_id"
  AND projection."root_comment_id" =
    COALESCE(legacy."in_reply_to_id", legacy."github_comment_id")
  AND legacy."github_comment_id" IS NOT NULL;

DO $$
DECLARE
  null_thread_kind_count integer;
BEGIN
  SELECT COUNT(*)::integer
  INTO null_thread_kind_count
  FROM "github_comment_thread_projections"
  WHERE "thread_kind" IS NULL;

  IF null_thread_kind_count > 0 THEN
    RAISE EXCEPTION
      'github_comment_thread_projections contains % rows with NULL thread_kind; run repair before final cutover',
      null_thread_kind_count;
  END IF;
END $$;

UPDATE "comment_threads" thread
SET "external_id" =
  'github-pr-thread:' || projection."pull_request_detail_id" || ':' ||
  CASE
    WHEN projection."review_thread_id" IS NOT NULL
      THEN 'review-thread:' || projection."review_thread_id"
    ELSE projection."thread_kind"::text || ':root:' || projection."root_comment_id"
  END
FROM "github_comment_thread_projections" projection
WHERE thread."id" = projection."thread_id"
  AND projection."thread_kind" IS NOT NULL
  AND projection."root_comment_id" IS NOT NULL
  AND thread."external_id" IS DISTINCT FROM (
    'github-pr-thread:' || projection."pull_request_detail_id" || ':' ||
    CASE
      WHEN projection."review_thread_id" IS NOT NULL
        THEN 'review-thread:' || projection."review_thread_id"
      ELSE projection."thread_kind"::text || ':root:' || projection."root_comment_id"
    END
  );

UPDATE "comments" comment
SET "external_id" =
  'github:' || thread_projection."thread_kind"::text || ':comment:' || comment_projection."github_comment_id"
FROM "github_comment_projections" comment_projection
JOIN "github_comment_thread_projections" thread_projection
  ON thread_projection."thread_id" = comment_projection."thread_id"
WHERE comment."id" = comment_projection."comment_id"
  AND thread_projection."thread_kind" IS NOT NULL
  AND comment_projection."github_comment_id" IS NOT NULL
  AND comment."external_id" IS DISTINCT FROM (
    'github:' || thread_projection."thread_kind"::text || ':comment:' || comment_projection."github_comment_id"
  );

-- This destructive cutover is not a production backfill. If any legacy review
-- comment lacks a unified projection, abort so the operational repair path can
-- run before the legacy table is removed. Soft-deleted unified projections are
-- accepted because they preserve the migrated tombstone for already-deleted
-- provider comments.
DO $$
DECLARE
  missing_unified_count integer;
BEGIN
  SELECT COUNT(*)::integer
  INTO missing_unified_count
  FROM "github_pr_review_comments" legacy
  JOIN "pull_request_detail" pr
    ON pr."id" = legacy."pull_request_id"
  LEFT JOIN "github_comment_thread_projections" thread_projection
    ON thread_projection."pull_request_detail_id" = legacy."pull_request_id"
    AND thread_projection."branch_artifact_id" = pr."branch_artifact_id"
    AND thread_projection."thread_kind" = (
      CASE
        WHEN legacy."review_id" IS NOT NULL OR legacy."path" IS NOT NULL
          THEN 'REVIEW_THREAD'
        ELSE 'ISSUE_COMMENT'
      END
    )::"GitHubCommentThreadKind"
    AND thread_projection."root_comment_id" =
      COALESCE(legacy."in_reply_to_id", legacy."github_comment_id")
  LEFT JOIN "github_comment_projections" comment_projection
    ON comment_projection."thread_id" = thread_projection."thread_id"
    AND comment_projection."github_comment_id" = legacy."github_comment_id"
  WHERE legacy."github_comment_id" IS NOT NULL
    AND (
      thread_projection."thread_id" IS NULL
      OR comment_projection."comment_id" IS NULL
    );

  IF missing_unified_count > 0 THEN
    RAISE EXCEPTION
      'github_pr_review_comments contains % rows without unified comment projections; run repair before final cutover',
      missing_unified_count;
  END IF;
END $$;

UPDATE "comments" child
SET "parent_comment_id" = parent_projection."comment_id"
FROM "github_comment_projections" child_projection
JOIN "github_comment_thread_projections" child_thread_projection
  ON child_thread_projection."thread_id" = child_projection."thread_id"
JOIN "github_comment_projections" parent_projection
  ON parent_projection."thread_id" = child_projection."thread_id"
  AND parent_projection."github_comment_id" =
    child_projection."github_in_reply_to_comment_id"
WHERE child."id" = child_projection."comment_id"
	  AND child_thread_projection."thread_kind" = 'REVIEW_THREAD'
	  AND child_projection."github_in_reply_to_comment_id" IS NOT NULL
	  AND parent_projection."comment_id" <> child_projection."comment_id"
	  AND child."parent_comment_id" IS NULL;

ALTER TABLE "github_comment_thread_projections"
  ALTER COLUMN "thread_kind" SET NOT NULL;

CREATE INDEX "github_comment_thread_projections_root_comment_idx" ON "github_comment_thread_projections"("pull_request_detail_id", "thread_kind", "root_comment_id");

CREATE INDEX "github_comment_thread_projections_review_thread_idx" ON "github_comment_thread_projections"("pull_request_detail_id", "thread_kind", "review_thread_id");

-- Provider source kind is part of the projection identity. Issue comments and
-- review comments can share a raw GitHub comment id in tests and fixtures, but
-- they must not reuse the same active projection row.
CREATE UNIQUE INDEX "github_comment_thread_projections_pr_root_comment_unique" ON "github_comment_thread_projections"("pull_request_detail_id", "thread_kind", "root_comment_id")
WHERE "root_comment_id" IS NOT NULL
  AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX "github_comment_thread_projections_pr_review_thread_unique" ON "github_comment_thread_projections"("pull_request_detail_id", "thread_kind", "review_thread_id")
WHERE "review_thread_id" IS NOT NULL
  AND "deleted_at" IS NULL;

DROP TABLE IF EXISTS "github_pr_review_comments";

DROP TYPE IF EXISTS "PRReviewCommentState";
