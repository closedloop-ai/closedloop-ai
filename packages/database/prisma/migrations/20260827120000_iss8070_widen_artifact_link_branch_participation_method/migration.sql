-- ISS-8070: widen `artifact_links.branch_participation_method` from
-- VARCHAR(200) to TEXT, in the same change that drops the matching wire
-- `.max(200)` on the branch-ref `method`. Dropping the wire bound alone would
-- have moved the rejection into Postgres as a 22001 (string_data_right_truncation)
-- mid-transaction — later and far less legible than the 400 it replaced.
--
-- Safe by construction: TEXT and VARCHAR are the same storage in Postgres and
-- perform identically; the length limit bought nothing. This column
-- participates in NO index (only the sibling `branch_participation` does, via
-- artifact_links_org_source_link_participation_idx and its target twin), so
-- widening cannot affect an index tuple or its 2704-byte btree limit.
--
-- LOCK IMPLICATION: since Postgres 9.2 a VARCHAR(n) -> TEXT widening is a
-- no-rewrite catalog change (the new type is binary-coercible and strictly
-- less constrained). It still takes a brief ACCESS EXCLUSIVE lock on
-- artifact_links and on the four indexes' parent relation for the catalog
-- update, but it does NOT rewrite the heap, so the lock is held for the
-- catalog write rather than for a full table scan. `artifact_links` is a large,
-- hot table, so the risk is lock QUEUEING behind a long-running reader, not
-- rewrite duration: the statement waits for conflicting locks and everything
-- arriving behind it queues too. The lock_timeout below bounds that blast
-- radius — the migration fails fast and is retried rather than stalling writes.
--
-- `SET` (as opposed to `SET LOCAL`) is SESSION-scoped, and `prisma migrate
-- deploy` applies every pending migration over ONE connection. Left set, this
-- 5s bound would silently follow the rest of the deploy and could fail an
-- unrelated later migration that legitimately waits longer for its lock. The
-- `RESET` below hands the session back at its configured default so the bound
-- stays with the one lock acquisition it was written for. `SET LOCAL` is not
-- used instead: it is a no-op outside a transaction block, which would drop the
-- guard entirely rather than scope it.
SET lock_timeout = '5s';

ALTER TABLE "artifact_links"
  ALTER COLUMN "branch_participation_method" TYPE TEXT;

RESET lock_timeout;
