-- CreateEnum
CREATE TYPE "PullRequestCommentLane" AS ENUM ('ISSUE_COMMENTS', 'REVIEW_COMMENTS', 'REVIEWS');

-- CreateEnum
CREATE TYPE "PullRequestCommentLaneStatus" AS ENUM ('COMPLETE', 'CEILING', 'SHIFTED', 'FAILED');

-- CreateTable
CREATE TABLE "pull_request_comment_acquisitions" (
    "pull_request_detail_id" UUID NOT NULL,
    "lane" "PullRequestCommentLane" NOT NULL,
    "organization_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "status" "PullRequestCommentLaneStatus" NOT NULL,
    "item_count" INTEGER,
    "error_code" VARCHAR(64),
    "listed_at" TIMESTAMP(3) NOT NULL,
    "last_complete_listed_at" TIMESTAMP(3),
    "incomplete_streak" INTEGER NOT NULL,
    "retracted_count" INTEGER,
    "recorded_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_request_comment_acquisitions_pkey" PRIMARY KEY ("pull_request_detail_id","lane")
);

-- AddForeignKey
ALTER TABLE "pull_request_comment_acquisitions" ADD CONSTRAINT "pull_request_comment_acquisitions_pull_request_detail_fkey" FOREIGN KEY ("organization_id", "pull_request_detail_id") REFERENCES "pull_request_detail"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed (hand-written: a data write Prisma cannot generate). Since #8321 a
-- non-NULL comments_reconciled_at means all three lists were read complete, so
-- each such PR gets three COMPLETE lanes observed at that stamp. A PR whose
-- latest attempt is newer than its last complete reconcile did not complete
-- that attempt, and the latest attempt wins (PLN-2174 decision 2), so it gets
-- none. A row a live reconcile already recorded is newer than this seed and
-- is kept.
INSERT INTO "pull_request_comment_acquisitions" (
    "pull_request_detail_id",
    "lane",
    "organization_id",
    "generation",
    "status",
    "item_count",
    "error_code",
    "listed_at",
    "last_complete_listed_at",
    "incomplete_streak",
    "retracted_count",
    "recorded_at"
)
SELECT
    pr."id",
    lane."value",
    pr."organization_id",
    1,
    'COMPLETE'::"PullRequestCommentLaneStatus",
    NULL,
    NULL,
    pr."comments_reconciled_at",
    pr."comments_reconciled_at",
    0,
    NULL,
    now()
FROM "pull_request_detail" pr
CROSS JOIN unnest(enum_range(NULL::"PullRequestCommentLane")) AS lane("value")
WHERE pr."comments_reconciled_at" IS NOT NULL
    AND (
        pr."comments_reconcile_attempted_at" IS NULL
        OR pr."comments_reconciled_at" >= pr."comments_reconcile_attempted_at"
    )
ON CONFLICT DO NOTHING;
