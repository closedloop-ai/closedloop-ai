-- AlterTable
ALTER TABLE "github_action_runs" ALTER COLUMN "run_id" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "github_installations" ALTER COLUMN "installation_id" SET DATA TYPE TEXT,
ALTER COLUMN "account_id" SET DATA TYPE TEXT,
ALTER COLUMN "sender_id" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "github_pr_review_comments" ALTER COLUMN "github_comment_id" SET DATA TYPE TEXT,
ALTER COLUMN "review_id" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "github_pr_reviews" ALTER COLUMN "github_review_id" SET DATA TYPE TEXT;
