-- ISS-7229, step 1 of 2: project Claude's OWN reported session cost onto
-- `session_detail` so estimator drift is a SQL expression over two columns on
-- one table (`estimated_cost - authoritative_cost_usd`) instead of a per-row
-- JSON extraction out of `loop_events.data`.
--
-- NULLABLE, NO DEFAULT. `null` means "Claude reported no cost" and is the
-- majority of rows: the `result` envelope this figure comes from exists only for
-- harness stdout captures. A `0` is a REPORTED zero — a real measurement — so a
-- `DEFAULT 0` here would manufacture a fleet of fake measurements and bias every
-- aggregate that reads the column. This is the "never emit a plausible-but-wrong
-- number" rule expressed in DDL.
--
-- Decimal(14,6) matches the sibling `estimated_cost` exactly, on purpose: the
-- two are the operands of one subtraction, and a width or scale mismatch would
-- put a rounding artifact into the delta.
--
-- ADDITIVE AND SEPARATE. `ADD COLUMN` with no default and no `NOT NULL` is a
-- catalog-only change in PostgreSQL 11+ — no table rewrite — but it still takes
-- ACCESS EXCLUSIVE for the life of its transaction, and `prisma migrate deploy`
-- wraps each migration FILE in one transaction. The backfill therefore lives in
-- its own directory (…120100) so this lock is held for a catalog update rather
-- than for a whole-table scan. Ordering is guaranteed by the directory
-- timestamps, which is what the append-only migration-order gate in
-- scripts/lint/check-destructive-migrations.ts enforces.

ALTER TABLE "session_detail"
ADD COLUMN "authoritative_cost_usd" DECIMAL(14,6);
