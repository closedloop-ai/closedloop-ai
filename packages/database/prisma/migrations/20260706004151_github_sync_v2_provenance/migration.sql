-- AlterTable
ALTER TABLE "branch_detail" ADD COLUMN     "fetch_credential_owner_id" UUID,
ADD COLUMN     "fetch_credential_type" VARCHAR(32),
ADD COLUMN     "fetch_mechanism" VARCHAR(32),
ADD COLUMN     "fetch_observed_at" TIMESTAMP(3),
ADD COLUMN     "fetch_result_reason" VARCHAR(64),
ADD COLUMN     "fetch_trigger" VARCHAR(32);

-- AlterTable
ALTER TABLE "branch_status_checks" ADD COLUMN     "fetch_credential_owner_id" UUID,
ADD COLUMN     "fetch_credential_type" VARCHAR(32),
ADD COLUMN     "fetch_mechanism" VARCHAR(32),
ADD COLUMN     "fetch_observed_at" TIMESTAMP(3),
ADD COLUMN     "fetch_result_reason" VARCHAR(64),
ADD COLUMN     "fetch_trigger" VARCHAR(32);

-- AlterTable
ALTER TABLE "github_comment_projections" ADD COLUMN     "fetch_credential_owner_id" UUID,
ADD COLUMN     "fetch_credential_type" VARCHAR(32),
ADD COLUMN     "fetch_mechanism" VARCHAR(32),
ADD COLUMN     "fetch_observed_at" TIMESTAMP(3),
ADD COLUMN     "fetch_result_reason" VARCHAR(64),
ADD COLUMN     "fetch_trigger" VARCHAR(32);

-- AlterTable
ALTER TABLE "github_comment_thread_projections" ADD COLUMN     "fetch_credential_owner_id" UUID,
ADD COLUMN     "fetch_credential_type" VARCHAR(32),
ADD COLUMN     "fetch_mechanism" VARCHAR(32),
ADD COLUMN     "fetch_observed_at" TIMESTAMP(3),
ADD COLUMN     "fetch_result_reason" VARCHAR(64),
ADD COLUMN     "fetch_trigger" VARCHAR(32);

-- AlterTable
ALTER TABLE "github_pr_reviews" ADD COLUMN     "fetch_credential_owner_id" UUID,
ADD COLUMN     "fetch_credential_type" VARCHAR(32),
ADD COLUMN     "fetch_mechanism" VARCHAR(32),
ADD COLUMN     "fetch_observed_at" TIMESTAMP(3),
ADD COLUMN     "fetch_result_reason" VARCHAR(64),
ADD COLUMN     "fetch_trigger" VARCHAR(32);

-- AlterTable
ALTER TABLE "pull_request_detail" ADD COLUMN     "fetch_credential_owner_id" UUID,
ADD COLUMN     "fetch_credential_type" VARCHAR(32),
ADD COLUMN     "fetch_mechanism" VARCHAR(32),
ADD COLUMN     "fetch_observed_at" TIMESTAMP(3),
ADD COLUMN     "fetch_result_reason" VARCHAR(64),
ADD COLUMN     "fetch_trigger" VARCHAR(32);
