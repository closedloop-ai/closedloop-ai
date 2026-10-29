-- CreateEnum
CREATE TYPE "CommentReanchorMode" AS ENUM ('MISSING', 'FULL');

-- AlterTable
ALTER TABLE "comment_attachments" ADD COLUMN     "bucket" TEXT,
ADD COLUMN     "key" TEXT,
ADD COLUMN     "uploaded_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "comment_reanchor_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "mode" "CommentReanchorMode" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "claim_generation" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comment_reanchor_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- index-lock-ok(comment_reanchor_requests): table is created empty in this same migration so both indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "comment_reanchor_requests_artifact_id_key" ON "comment_reanchor_requests"("artifact_id");

-- CreateIndex
-- index-lock-ok(comment_reanchor_requests): table is created empty in this same migration so both indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "comment_reanchor_requests_next_attempt_at_idx" ON "comment_reanchor_requests"("next_attempt_at");

-- AddForeignKey
ALTER TABLE "comment_reanchor_requests" ADD CONSTRAINT "comment_reanchor_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_reanchor_requests" ADD CONSTRAINT "comment_reanchor_requests_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
