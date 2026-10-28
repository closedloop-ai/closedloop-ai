-- CreateTable
CREATE TABLE "artifact_operation_receipts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "principal_user_id" UUID NOT NULL,
    "api_key_id" UUID,
    "source" TEXT NOT NULL,
    "operation_kind" TEXT NOT NULL,
    "target_artifact_id" UUID,
    "outcome" TEXT NOT NULL,
    "created_artifact_id" UUID,
    "version_number" INTEGER,
    "comment_id" UUID,
    "link_id" UUID,
    "changed_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "content_digest_before" TEXT,
    "content_digest_after" TEXT,
    "client_call_id" TEXT,
    "request_fingerprint" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "committed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_operation_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- index-lock-ok(artifact_operation_receipts): table is created empty in this same migration so its indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "artifact_operation_receipts_call_id_idx" ON "artifact_operation_receipts"("organization_id", "principal_user_id", "client_call_id");

-- CreateIndex
-- index-lock-ok(artifact_operation_receipts): table is created empty in this same migration so its indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "artifact_operation_receipts_fingerprint_idx" ON "artifact_operation_receipts"("organization_id", "principal_user_id", "request_fingerprint", "requested_at");

-- CreateIndex
-- index-lock-ok(artifact_operation_receipts): table is created empty in this same migration so its indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_operation_receipts_rejected_call_key" ON "artifact_operation_receipts"("organization_id", "principal_user_id", "client_call_id") WHERE ((outcome = 'rejected'::text) AND (client_call_id IS NOT NULL));
