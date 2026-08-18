-- FEA-4044 — index the audit-outbox drain scan.
--
-- `drainAuditOutbox` reads pending rows with
--   WHERE "attempts" < $cap ORDER BY "created_at" ASC LIMIT $n
-- (a global, cross-org scan — the drain is not org-scoped). The existing
-- (organization_id, created_at) index cannot serve it. Once a poison row is
-- parked at the dead-letter cap it stays in the table forever, so without a
-- query-aligned index this scan+sort grows with the parked set and can recreate
-- the starvation the drain cap fixes.
--
-- A composite (attempts, created_at) index serves it: the leading `attempts`
-- column range-excludes parked rows (attempts >= cap) from the scan, so the
-- growing dead-letter set never enters a drain pass. Prisma-expressible; this
-- SQL matches `prisma migrate dev` output for `@@index([attempts, createdAt])`.

-- CreateIndex
CREATE INDEX "audit_outbox_attempts_created_at_idx" ON "audit_outbox"("attempts", "created_at");
