-- ISS-9930 (whitlockk, #7539). `hasFailedPenseroBackfillDay` runs on every eligible
-- branch detail and filters `organization_id = $1 AND last_success_at IS NULL`.
-- `pensero_backfill_days_organization_id_day_key` leads on the same first column
-- but cannot serve the second, so the HEALTHY case — the org has no failed day —
-- had to re-check every one of that org's rows, one per attempted day, growing in
-- both directions forever. `last_success_at` as the second key makes the whole
-- predicate an index condition: the scan seeks to this org, then to its NULL
-- group, and stops.
--
-- ONE BARE STATEMENT, deliberately. `CREATE INDEX CONCURRENTLY` cannot run inside
-- a transaction, and Prisma wraps the whole file the moment any statement defeats
-- its naive splitter (a dollar-quoted block, BEGIN/COMMIT, an index drop) — the
-- build then fails with SQLSTATE 25001. `IF NOT EXISTS` is likewise omitted on
-- purpose: it would no-op over the INVALID index a cancelled concurrent build
-- leaves behind, and the P3018 recovery would record the migration as applied
-- (`packages/database/AGENTS.md`).

-- CreateIndex
CREATE INDEX CONCURRENTLY "pensero_backfill_days_organization_id_last_success_at_idx" ON "pensero_backfill_days"("organization_id", "last_success_at");
