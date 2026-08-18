-- FEA-3476 / PRD-536 D7: persist the permanent, non-retryable disposition of a
-- transcript the desktop will never upload (e.g. it exceeds the local size cap).
-- Additive, append-only, nullable column with no NOT NULL/backfill and no
-- deployed readers until the FEA-3476 read/write paths ship, so it is safe to
-- apply ahead of the code. The terminal `uploadStatus = 'skipped'` value it
-- accompanies needs no DDL — `upload_status` is a free-text TEXT column.
-- Generated offline (no DB reachable in the authoring sandbox); applied by
-- `prisma migrate deploy` in CI/prod.

-- AlterTable
ALTER TABLE "session_transcript" ADD COLUMN "permanent_failure_reason" TEXT;
