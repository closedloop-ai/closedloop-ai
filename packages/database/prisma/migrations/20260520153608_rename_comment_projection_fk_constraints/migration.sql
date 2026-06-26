-- RenameForeignKey
-- This migration may run after databases that already received the same
-- Prisma-generated constraint names from 20260520064305_add_github_comment_identity.
-- Rename only when the old name is still present so fresh and partially
-- upgraded databases both converge without failing on missing constraints.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"github_comment_projections"'::regclass
      AND conname = 'github_comment_projections_comment_thread_fkey'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"github_comment_projections"'::regclass
      AND conname = 'github_comment_projections_comment_id_thread_id_fkey'
  ) THEN
    ALTER TABLE "github_comment_projections"
      RENAME CONSTRAINT "github_comment_projections_comment_thread_fkey"
      TO "github_comment_projections_comment_id_thread_id_fkey";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"github_comment_projections"'::regclass
      AND conname = 'github_comment_projections_thread_projection_fkey'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"github_comment_projections"'::regclass
      AND conname = 'github_comment_projections_thread_id_fkey'
  ) THEN
    ALTER TABLE "github_comment_projections"
      RENAME CONSTRAINT "github_comment_projections_thread_projection_fkey"
      TO "github_comment_projections_thread_id_fkey";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"github_comment_thread_projections"'::regclass
      AND conname = 'github_comment_thread_projections_branch_detail_fkey'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"github_comment_thread_projections"'::regclass
      AND conname = 'github_comment_thread_projections_branch_artifact_id_fkey'
  ) THEN
    ALTER TABLE "github_comment_thread_projections"
      RENAME CONSTRAINT "github_comment_thread_projections_branch_detail_fkey"
      TO "github_comment_thread_projections_branch_artifact_id_fkey";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"github_comment_thread_projections"'::regclass
      AND conname = 'github_comment_thread_projections_pr_branch_fkey'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"github_comment_thread_projections"'::regclass
      AND conname = 'github_comment_thread_projections_pull_request_detail_id_b_fkey'
  ) THEN
    ALTER TABLE "github_comment_thread_projections"
      RENAME CONSTRAINT "github_comment_thread_projections_pr_branch_fkey"
      TO "github_comment_thread_projections_pull_request_detail_id_b_fkey";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"github_comment_thread_projections"'::regclass
      AND conname = 'github_comment_thread_projections_thread_branch_fkey'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"github_comment_thread_projections"'::regclass
      AND conname = 'github_comment_thread_projections_thread_id_branch_artifac_fkey'
  ) THEN
    ALTER TABLE "github_comment_thread_projections"
      RENAME CONSTRAINT "github_comment_thread_projections_thread_branch_fkey"
      TO "github_comment_thread_projections_thread_id_branch_artifac_fkey";
  END IF;
END $$;
