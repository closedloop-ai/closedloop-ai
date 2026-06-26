-- CreateEnum
CREATE TYPE "GitHubCommentThreadKind" AS ENUM ('REVIEW_THREAD', 'ISSUE_COMMENT');

-- CreateEnum
CREATE TYPE "GitHubDiffSide" AS ENUM ('LEFT', 'RIGHT');

-- CreateEnum
CREATE TYPE "GitHubLegacyCommentState" AS ENUM ('PENDING', 'ADDRESSED', 'DISMISSED');

-- AlterEnum
ALTER TYPE "ThreadSource" ADD VALUE 'GITHUB';

-- Preflight for later backfill lanes: before projecting legacy rows from
-- "github_pr_review_comments", verify duplicate active remote comment ids are
-- scoped by organization, branch artifact, and exact pull_request_detail row.
-- This split intentionally retains "github_pr_review_comments" as the runtime
-- source table and performs no data rewrite or cleanup.

-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "parent_comment_id" UUID;

-- CreateTable
CREATE TABLE "github_comment_thread_projections" (
    "thread_id" UUID NOT NULL,
    "branch_artifact_id" UUID NOT NULL,
    "pull_request_detail_id" UUID NOT NULL,
    "thread_kind" "GitHubCommentThreadKind",
    "review_thread_id" TEXT,
    "root_comment_id" TEXT,
    "review_id" TEXT,
    "path" TEXT,
    "line" INTEGER,
    "side" "GitHubDiffSide",
    "start_line" INTEGER,
    "start_side" "GitHubDiffSide",
    "commit_sha" TEXT,
    "html_url" TEXT,
    "resolvable" BOOLEAN NOT NULL DEFAULT false,
    "legacy_state" "GitHubLegacyCommentState",
    "deleted_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),

    CONSTRAINT "github_comment_thread_projections_pkey" PRIMARY KEY ("thread_id")
);

-- CreateTable
CREATE TABLE "github_comment_projections" (
    "comment_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "github_comment_id" TEXT,
    "github_in_reply_to_comment_id" TEXT,
    "github_html_url" TEXT,
    "github_updated_at" TIMESTAMP(3),
    "github_deleted_at" TIMESTAMP(3),

    CONSTRAINT "github_comment_projections_pkey" PRIMARY KEY ("comment_id")
);

-- CreateIndex
CREATE INDEX "github_comment_thread_projections_root_comment_idx" ON "github_comment_thread_projections"("pull_request_detail_id", "root_comment_id");

-- CreateIndex
CREATE INDEX "github_comment_thread_projections_review_thread_idx" ON "github_comment_thread_projections"("pull_request_detail_id", "review_thread_id");

-- CreateIndex
CREATE INDEX "github_comment_thread_projections_pr_detail_idx" ON "github_comment_thread_projections"("pull_request_detail_id");

-- CreateIndex
CREATE INDEX "github_comment_thread_projections_last_synced_at_idx" ON "github_comment_thread_projections"("last_synced_at");

-- CreateIndex
CREATE UNIQUE INDEX "comment_threads_id_artifact_id_key" ON "comment_threads"("id", "artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "pull_request_detail_id_branch_artifact_id_key" ON "pull_request_detail"("id", "branch_artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "comments_id_thread_id_key" ON "comments"("id", "thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_comment_thread_projections_thread_branch_key" ON "github_comment_thread_projections"("thread_id", "branch_artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_comment_projections_comment_thread_key" ON "github_comment_projections"("comment_id", "thread_id");

-- CreateIndex
CREATE INDEX "github_comment_projections_thread_github_comment_idx" ON "github_comment_projections"("thread_id", "github_comment_id");

-- CreateIndex
CREATE INDEX "comments_parent_comment_id_idx" ON "comments"("parent_comment_id");

-- CreateIndex
CREATE INDEX "github_comment_projections_in_reply_to_idx" ON "github_comment_projections"("github_in_reply_to_comment_id");

-- Prisma cannot express the active-row predicates below. Keep remote ids
-- reusable after GitHub deletion while preventing duplicate active projections.
--
-- CreateIndex
CREATE UNIQUE INDEX "github_comment_thread_projections_pr_root_comment_unique" ON "github_comment_thread_projections"("pull_request_detail_id", "root_comment_id")
WHERE "root_comment_id" IS NOT NULL
  AND "deleted_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "github_comment_thread_projections_pr_review_thread_unique" ON "github_comment_thread_projections"("pull_request_detail_id", "review_thread_id")
WHERE "review_thread_id" IS NOT NULL
  AND "deleted_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "github_comment_projections_thread_github_comment_unique" ON "github_comment_projections"("thread_id", "github_comment_id")
WHERE "github_comment_id" IS NOT NULL
  AND "github_deleted_at" IS NULL;

-- AddForeignKey
ALTER TABLE "github_comment_thread_projections" ADD CONSTRAINT "github_comment_thread_projections_thread_branch_fkey" FOREIGN KEY ("thread_id", "branch_artifact_id") REFERENCES "comment_threads"("id", "artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_comment_thread_projections" ADD CONSTRAINT "github_comment_thread_projections_branch_detail_fkey" FOREIGN KEY ("branch_artifact_id") REFERENCES "branch_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Prisma cannot express a composite self-reference that only nulls
-- "parent_comment_id" on parent delete. Lock the parent row instead so
-- concurrent parent moves cannot race same-thread reply validation.
--
-- CreateFunction
CREATE FUNCTION "ensure_comments_parent_same_thread"()
RETURNS trigger AS $$
BEGIN
  IF NEW."parent_comment_id" IS NOT NULL
  THEN
    PERFORM 1
    FROM "comments" parent
    WHERE parent."id" = NEW."parent_comment_id"
      AND parent."thread_id" = NEW."thread_id"
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'comments.parent_comment_id must reference a comment in the same thread'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW."thread_id" IS DISTINCT FROM OLD."thread_id"
    AND EXISTS (
      SELECT 1
      FROM "comments" child
      WHERE child."parent_comment_id" = NEW."id"
        AND child."thread_id" IS DISTINCT FROM NEW."thread_id"
    )
  THEN
    RAISE EXCEPTION 'comments with replies cannot move to a different thread'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CreateTrigger
CREATE TRIGGER "comments_parent_same_thread_check"
BEFORE INSERT OR UPDATE OF "parent_comment_id", "thread_id" ON "comments"
FOR EACH ROW
EXECUTE FUNCTION "ensure_comments_parent_same_thread"();

-- Prisma cannot express this cross-table ownership invariant: GitHub
-- projections must attach only to GITHUB-sourced threads whose artifact is the
-- same branch artifact and organization as the PullRequestDetail branch.
--
-- CreateFunction
CREATE FUNCTION "ensure_github_comment_thread_projection_owner"()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "comment_threads" thread
    JOIN "artifacts" artifact
      ON artifact."id" = thread."artifact_id"
    JOIN "branch_detail" branch
      ON branch."artifact_id" = artifact."id"
    JOIN "pull_request_detail" pr
      ON pr."id" = NEW."pull_request_detail_id"
     AND pr."branch_artifact_id" = NEW."branch_artifact_id"
    WHERE thread."id" = NEW."thread_id"
      AND thread."artifact_id" = NEW."branch_artifact_id"
      AND thread."source" = 'GITHUB'
      AND artifact."type" = 'BRANCH'
      AND artifact."organization_id" = thread."organization_id"
  )
  THEN
    RAISE EXCEPTION 'github_comment_thread_projections must reference a GitHub thread on the same branch artifact and organization as the pull request detail'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CreateTrigger
CREATE TRIGGER "github_comment_thread_projection_owner_check"
BEFORE INSERT OR UPDATE OF "thread_id", "branch_artifact_id", "pull_request_detail_id" ON "github_comment_thread_projections"
FOR EACH ROW
EXECUTE FUNCTION "ensure_github_comment_thread_projection_owner"();

-- Keep the non-key owner fields immutable while a GitHub projection exists.
-- Composite FKs protect branch/PR identity, but Prisma cannot express that a
-- projected base thread must remain a GITHUB thread in the same organization.
--
-- CreateFunction
CREATE FUNCTION "prevent_github_comment_thread_projection_thread_drift"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "github_comment_thread_projections" projection
    WHERE projection."thread_id" = OLD."id"
      AND projection."deleted_at" IS NULL
  )
    AND (
      NEW."source" IS DISTINCT FROM OLD."source"
      OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
      OR NEW."artifact_id" IS DISTINCT FROM OLD."artifact_id"
    )
  THEN
    RAISE EXCEPTION 'comment_threads with GitHub projections cannot change source, organization, or artifact'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CreateTrigger
CREATE TRIGGER "comment_threads_github_projection_owner_drift_check"
BEFORE UPDATE OF "source", "organization_id", "artifact_id" ON "comment_threads"
FOR EACH ROW
EXECUTE FUNCTION "prevent_github_comment_thread_projection_thread_drift"();

-- Keep branch artifact owner fields immutable while GitHub projections point
-- at the branch. The projection table's branch_detail FK proves the current
-- row is a branch, and this guard prevents later artifact drift.
--
-- CreateFunction
CREATE FUNCTION "prevent_github_comment_thread_projection_artifact_drift"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "github_comment_thread_projections" projection
    WHERE projection."branch_artifact_id" = OLD."id"
      AND projection."deleted_at" IS NULL
  )
    AND (
      NEW."type" IS DISTINCT FROM OLD."type"
      OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    )
  THEN
    RAISE EXCEPTION 'artifacts with GitHub comment projections cannot change type or organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CreateTrigger
CREATE TRIGGER "artifacts_github_projection_owner_drift_check"
BEFORE UPDATE OF "type", "organization_id" ON "artifacts"
FOR EACH ROW
EXECUTE FUNCTION "prevent_github_comment_thread_projection_artifact_drift"();

-- Prisma cannot express the reverse ownership cleanup. GitHub projection rows
-- are the PR-owned extension of generic comment threads, so deleting a
-- projection should delete its GITHUB base thread and cascade its comments.
--
-- CreateFunction
CREATE FUNCTION "delete_github_comment_thread_projection_base_row"()
RETURNS trigger AS $$
BEGIN
  DELETE FROM "comment_threads"
  WHERE "id" = OLD."thread_id"
    AND "source" = 'GITHUB';

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- CreateTrigger
CREATE TRIGGER "github_comment_thread_projection_base_row_cleanup"
AFTER DELETE ON "github_comment_thread_projections"
FOR EACH ROW
EXECUTE FUNCTION "delete_github_comment_thread_projection_base_row"();

-- AddForeignKey
ALTER TABLE "github_comment_thread_projections" ADD CONSTRAINT "github_comment_thread_projections_pr_branch_fkey" FOREIGN KEY ("pull_request_detail_id", "branch_artifact_id") REFERENCES "pull_request_detail"("id", "branch_artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_comment_projections" ADD CONSTRAINT "github_comment_projections_comment_thread_fkey" FOREIGN KEY ("comment_id", "thread_id") REFERENCES "comments"("id", "thread_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_comment_projections" ADD CONSTRAINT "github_comment_projections_thread_projection_fkey" FOREIGN KEY ("thread_id") REFERENCES "github_comment_thread_projections"("thread_id") ON DELETE CASCADE ON UPDATE CASCADE;
