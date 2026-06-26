-- Drop the temporary unique index that Migration A created while
-- pull_request_detail.id was nullable. Migration B promotes id to the primary
-- key, so keeping this separate unique index makes fresh migration replay drift
-- from schema.prisma.
--
-- PostgreSQL can bind foreign keys to the unique index instead of the later
-- primary-key index, so recreate those foreign keys around the drop.

ALTER TABLE "branch_detail" DROP CONSTRAINT IF EXISTS "branch_detail_current_pull_request_detail_id_fkey";
ALTER TABLE "github_pr_reviews" DROP CONSTRAINT IF EXISTS "github_pr_reviews_pull_request_id_fkey";
ALTER TABLE "github_pr_review_comments" DROP CONSTRAINT IF EXISTS "github_pr_review_comments_pull_request_id_fkey";

DROP INDEX IF EXISTS "pull_request_detail_id_key";

ALTER TABLE "branch_detail"
  ADD CONSTRAINT "branch_detail_current_pull_request_detail_id_fkey"
  FOREIGN KEY ("current_pull_request_detail_id") REFERENCES "pull_request_detail"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "github_pr_reviews"
  ADD CONSTRAINT "github_pr_reviews_pull_request_id_fkey"
  FOREIGN KEY ("pull_request_id") REFERENCES "pull_request_detail"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_pr_review_comments"
  ADD CONSTRAINT "github_pr_review_comments_pull_request_id_fkey"
  FOREIGN KEY ("pull_request_id") REFERENCES "pull_request_detail"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
