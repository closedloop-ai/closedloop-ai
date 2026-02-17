-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "PRReviewCommentState" AS ENUM ('PENDING', 'ADDRESSED', 'DISMISSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WorkstreamEventType" ADD VALUE 'GITHUB_PR_REVIEW_SUBMITTED';
ALTER TYPE "WorkstreamEventType" ADD VALUE 'GITHUB_PR_COMMENT_ADDED';

-- AlterTable
ALTER TABLE "github_pull_requests" ADD COLUMN     "review_decision" "ReviewDecision";

-- CreateTable
CREATE TABLE "github_pr_review_comments" (
    "id" UUID NOT NULL,
    "pull_request_id" UUID NOT NULL,
    "github_comment_id" BIGINT NOT NULL,
    "review_id" BIGINT,
    "body" TEXT NOT NULL,
    "path" TEXT,
    "line" INTEGER,
    "author_login" TEXT NOT NULL,
    "author_avatar_url" TEXT,
    "state" "PRReviewCommentState" NOT NULL DEFAULT 'PENDING',
    "html_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_pr_review_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_pr_reviews" (
    "id" UUID NOT NULL,
    "pull_request_id" UUID NOT NULL,
    "github_review_id" BIGINT NOT NULL,
    "author_login" TEXT NOT NULL,
    "author_avatar_url" TEXT,
    "state" "ReviewDecision" NOT NULL,
    "body" TEXT,
    "html_url" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_pr_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_pr_review_comments_github_comment_id_key" ON "github_pr_review_comments"("github_comment_id");

-- CreateIndex
CREATE INDEX "github_pr_review_comments_pull_request_id_state_idx" ON "github_pr_review_comments"("pull_request_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "github_pr_reviews_github_review_id_key" ON "github_pr_reviews"("github_review_id");

-- CreateIndex
CREATE INDEX "github_pr_reviews_pull_request_id_idx" ON "github_pr_reviews"("pull_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_pr_reviews_pull_request_id_author_login_key" ON "github_pr_reviews"("pull_request_id", "author_login");
