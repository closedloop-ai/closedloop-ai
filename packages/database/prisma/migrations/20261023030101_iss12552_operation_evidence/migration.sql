-- CreateTable
CREATE TABLE "agent_session_operation_evidence" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_session_id" UUID NOT NULL,
    "claim_key" TEXT NOT NULL,
    "receipt_id" UUID,
    "target_artifact_id" UUID,
    "observed_target" TEXT,
    "relationship_kind" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "operation_kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "unresolved_reason" TEXT,
    "agent_id" TEXT,
    "invoked_at" TIMESTAMP(3),
    "effective_at" TIMESTAMP(3),
    "changed_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version_number" INTEGER,
    "provider_call_id" TEXT,
    "request_fingerprint" TEXT,
    "anchors" JSONB NOT NULL DEFAULT '{}',
    "extractor_version" INTEGER NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_session_operation_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_session_operation_evidence_snapshots" (
    "agent_session_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "digest" TEXT NOT NULL,
    "extractor_version" INTEGER NOT NULL,
    "coverage" JSONB NOT NULL,
    "unparsed_claims" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_session_operation_evidence_snapshots_pkey" PRIMARY KEY ("agent_session_id")
);

-- CreateIndex
-- index-lock-ok(agent_session_operation_evidence): table is created empty in this same migration so its indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "agent_session_operation_evidence_call_id_idx" ON "agent_session_operation_evidence"("organization_id", "provider_call_id");

-- CreateIndex
-- index-lock-ok(agent_session_operation_evidence): table is created empty in this same migration so its indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "agent_session_operation_evidence_fingerprint_idx" ON "agent_session_operation_evidence"("organization_id", "request_fingerprint");

-- CreateIndex
-- index-lock-ok(agent_session_operation_evidence): table is created empty in this same migration so its indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "agent_session_operation_evidence_target_idx" ON "agent_session_operation_evidence"("organization_id", "target_artifact_id");

-- CreateIndex
-- index-lock-ok(agent_session_operation_evidence): table is created empty in this same migration so its indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "agent_session_operation_evidence_claim_key" ON "agent_session_operation_evidence"("agent_session_id", "claim_key");

-- CreateIndex
-- index-lock-ok(agent_session_operation_evidence): table is created empty in this same migration so its indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "agent_session_operation_evidence_receipt_key" ON "agent_session_operation_evidence"("receipt_id") WHERE (receipt_id IS NOT NULL);

-- CreateIndex
-- index-lock-ok(agent_session_operation_evidence_snapshots): table is created empty in this same migration so its indexes build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "agent_session_operation_evidence_snapshot_org_idx" ON "agent_session_operation_evidence_snapshots"("organization_id");

-- AddForeignKey
ALTER TABLE "agent_session_operation_evidence" ADD CONSTRAINT "agent_session_operation_evidence_agent_session_id_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_session_operation_evidence_snapshots" ADD CONSTRAINT "agent_session_operation_evidence_snapshots_agent_session_i_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;
