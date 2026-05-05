-- prisma-migrate: disable-transaction

-- PLN-477: Replace the artifact_version-scoped loop uniqueness index with a
-- simpler (artifact_id, command) partial unique index.
--
-- The old index enforced: at most one active loop per (artifact_id, command,
-- artifact_version). The new index enforces: at most one active loop per
-- (artifact_id, command), regardless of version. This prevents concurrent
-- duplicate loops for any version combination, not just the same version.
-- Terminal loops (COMPLETED/FAILED/CANCELLED/TIMED_OUT) remain excluded so
-- re-runs are still allowed after completion.
-- NULL artifact_id rows never conflict (Postgres NULL != NULL in unique indexes).
-- Chat command is excluded from the uniqueness constraint because application
-- logic explicitly allows concurrent Chat loops on the same document.

-- 1. Drop the old partial unique index (artifact_id, command, artifact_version).
-- CONCURRENTLY avoids AccessExclusiveLock; requires running outside a transaction.
DROP INDEX CONCURRENTLY IF EXISTS "loops_active_artifact_command_version_key";

-- 2. Drop the companion regular index used for non-status-filtered queries.
-- CONCURRENTLY avoids AccessExclusiveLock; requires running outside a transaction.
DROP INDEX CONCURRENTLY IF EXISTS "loops_artifact_id_command_artifact_version_idx";

-- 3. Create the new partial unique index on (artifact_id, command) only.
-- Maintained via raw SQL because Prisma cannot express partial unique indexes
-- (WHERE clause). Prisma 7.4+ falsely flags this as drift — we pin to 7.3.0
-- until resolved. Do NOT drop it.
-- See: https://github.com/prisma/prisma/issues/29289
-- Chat is excluded so concurrent Chat loops never hit a P2002 unique violation.
-- CONCURRENTLY avoids ShareLock blocking writes during index build.
CREATE UNIQUE INDEX CONCURRENTLY "loops_active_artifact_command_key"
ON "loops"("artifact_id", "command")
WHERE "status" IN ('PENDING', 'CLAIMED', 'RUNNING') AND "command" <> 'CHAT';

-- 4. Create a companion regular index for non-status-filtered queries
-- (query performance on artifact_id + command lookups).
-- CONCURRENTLY avoids ShareLock blocking writes during index build.
CREATE INDEX CONCURRENTLY "loops_artifact_id_command_idx" ON "loops"("artifact_id", "command");
