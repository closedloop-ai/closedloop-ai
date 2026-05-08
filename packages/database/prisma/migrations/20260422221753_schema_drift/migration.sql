-- DropForeignKey
ALTER TABLE "artifact_evaluations" DROP CONSTRAINT "artifact_evaluations_artifact_id_fkey";

-- DropForeignKey
ALTER TABLE "artifact_generation_status_dismissals" DROP CONSTRAINT "artifact_generation_status_dismissals_artifact_id_fkey";

-- DropForeignKey
ALTER TABLE "artifact_ratings" DROP CONSTRAINT "artifact_ratings_artifact_id_fkey";

-- DropForeignKey
ALTER TABLE "artifact_ratings" DROP CONSTRAINT "artifact_ratings_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "artifact_ratings" DROP CONSTRAINT "artifact_ratings_user_id_fkey";

-- DropForeignKey
ALTER TABLE "comment_threads" DROP CONSTRAINT "comment_threads_artifact_id_fkey";

-- DropForeignKey
ALTER TABLE "document_versions" DROP CONSTRAINT "document_versions_document_id_fkey";

-- DropForeignKey
ALTER TABLE "file_attachments" DROP CONSTRAINT "file_attachments_artifact_id_fkey";

-- DropForeignKey
ALTER TABLE "github_action_run_performances" DROP CONSTRAINT "github_action_run_performances_artifact_id_fkey";

-- DropForeignKey
ALTER TABLE "github_pr_review_comments" DROP CONSTRAINT "github_pr_review_comments_pull_request_id_fkey";

-- DropForeignKey
ALTER TABLE "github_pr_reviews" DROP CONSTRAINT "github_pr_reviews_pull_request_id_fkey";

-- DropForeignKey
ALTER TABLE "loops" DROP CONSTRAINT "loops_artifact_id_fkey";

-- AddForeignKey
ALTER TABLE "artifact_generation_status_dismissals" ADD CONSTRAINT "artifact_generation_status_dismissals_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "document_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_evaluations" ADD CONSTRAINT "artifact_evaluations_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_action_run_performances" ADD CONSTRAINT "github_action_run_performances_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "document_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_ratings" ADD CONSTRAINT "artifact_ratings_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_ratings" ADD CONSTRAINT "artifact_ratings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_ratings" ADD CONSTRAINT "artifact_ratings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_attachments" ADD CONSTRAINT "file_attachments_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_threads" ADD CONSTRAINT "comment_threads_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loops" ADD CONSTRAINT "loops_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_pr_review_comments" ADD CONSTRAINT "github_pr_review_comments_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_request_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_pr_reviews" ADD CONSTRAINT "github_pr_reviews_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_request_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;
