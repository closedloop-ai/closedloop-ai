-- ISS-8462: durable desktop-origin marker for the tier-2 reconcile selector,
-- plus the origin assignment for rows that predate it.
--
-- HAND-WRITTEN ON PURPOSE (packages/database/AGENTS.md): the UPDATE is a pure
-- DATA migration, so `prisma migrate dev` has nothing to generate for it and
-- reports no drift.
--
-- ONE FILE, ONE EXPLICIT TRANSACTION, DELIBERATELY (whitlockk review on #6214).
-- An earlier revision shipped these as two migration files on the theory that
-- `prisma migrate deploy` wraps each file in a transaction, so a combined file
-- would hold ACCESS EXCLUSIVE across the whole backfill scan. THAT PREMISE IS
-- FALSE, and was measured false: a two-statement migration whose second
-- statement raises still leaves the first committed, so Prisma applies these
-- files WITHOUT a wrapper. Split across two files the ADD COLUMN therefore
-- commits on its own and opens a live gap — every row is `false`, the running
-- reconciler is free to relabel a `desktop_sync` row to `graphql`, and the
-- backfill's predicate then misses it permanently, which is the exact defect
-- this migration exists to fix. The explicit BEGIN/COMMIT below closes that
-- gap: the ACCESS EXCLUSIVE taken by ADD COLUMN is held until the origin
-- assignment commits with it, so no writer can observe the intermediate state.
--
-- WHAT THAT COSTS. The lock is held for the backfill's seq scan instead of
-- being released immediately. Measured on a seeded Postgres 16 — 250k
-- `pull_request_detail` rows / 140 MB, 12.5k matching — at 807 ms for the
-- UPDATE (`ALTER` itself 3 ms; a constant DEFAULT is metadata-only on PG11+).
-- Sub-second contention once, against a row orphaned forever, is the trade this
-- takes. Explicit BEGIN/COMMIT inside a migration is an established shape here
-- (see 20260629130000_split_document_and_feature_status).
--
-- WHY THIS PREDICATE. It reproduces the selector arm's membership EXACTLY as it
-- stood before this change: `fetch_mechanism = 'desktop_sync'` was what admitted
-- a row to that arm, so the set admitted immediately after this runs is the set
-- admitted immediately before it. The change is therefore non-widening; the
-- column only additionally SURVIVES the reconciler's overwrite, which is the fix.
--
-- WHAT IT DELIBERATELY DOES NOT RECOVER. A row already frozen to 'graphql' by a
-- completed reconcile is not selected here and stays unmarked. Repairing that
-- population is ISS-8463, which owns the one-time repair; widening this
-- predicate to guess at them would mark rows on evidence this column does not
-- have.
--
-- ADDITIVE: adds one column and writes it to `true` on a subset. No DROP, no
-- column altered, no row deleted.

BEGIN;

ALTER TABLE "pull_request_detail"
  ADD COLUMN "desktop_originated" BOOLEAN NOT NULL DEFAULT false;

UPDATE "pull_request_detail"
SET "desktop_originated" = true
WHERE "fetch_mechanism" = 'desktop_sync';

COMMIT;
