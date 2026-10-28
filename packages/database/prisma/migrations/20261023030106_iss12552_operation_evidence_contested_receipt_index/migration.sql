-- ISS-12552: sync reconciliation looks up a receipt's tied claim by
-- contested_receipt_id alongside its holder by receipt_id. Partial, because
-- almost every claim contests nothing. Prisma cannot express a concurrent
-- index build; keep this as one bare statement so deployment does not block
-- evidence writes or accept an invalid prior index.
-- CreateIndex
CREATE INDEX CONCURRENTLY "agent_session_operation_evidence_contested_receipt_idx" ON "agent_session_operation_evidence"("contested_receipt_id") WHERE (contested_receipt_id IS NOT NULL);
