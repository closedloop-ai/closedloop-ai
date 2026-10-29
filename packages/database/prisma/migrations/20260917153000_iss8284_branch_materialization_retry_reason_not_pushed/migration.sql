-- ISS-8284: widen `branch_materialization_retries_reason_check` to accept
-- 'not_pushed', the one member of the TypeScript terminal-reason vocabulary
-- (`BranchMaterializationRetryTerminalReason`,
-- apps/api/app/agent-sessions/service/artifact-links/branch-materialization-retry-monitor.ts)
-- that the column has never listed.
--
-- NOT A LIVE BREAKAGE TODAY, and this file must not be read as claiming one.
-- The reviewer concern that produced this ticket asserted that the retry drain
-- persists 'not_pushed' and that the terminal UPDATE therefore fails with a
-- check violation, leaving the retry claimed. Adjudicated against `main` and
-- REFUTED: `drainBranchMaterializationRetryClaim` tests
-- `isRetryableBranchMaterializationCause` BEFORE it maps a terminal reason, and
-- that predicate accepts `NotPushed` (ISS-8148), so the cause takes the
-- reschedule branch and never reaches `settleTerminalBranchMaterializationRetry`.
-- A horizon- or attempt-expired retry settles as 'attempts_exhausted'.
--
-- WHAT IS REAL is the latent vocabulary gap that ordering hides:
-- `terminalReasonFromBranchMaterializationCause()` CAN return
-- `BranchMaterializationRetryTerminalReason.NotPushed`, and that value is one
-- the column refuses. The only thing standing between that mapper and a check
-- violation is an early return in a DIFFERENT file. Widening the column makes
-- the DB vocabulary a superset of the runtime vocabulary, so the guard test
-- added with this migration can be a plain exhaustive parity check with no
-- exception carved into it, and a future caller that legitimately reaches the
-- mapper cannot be refused by storage.
--
-- HAND-WRITTEN ON PURPOSE (packages/database/AGENTS.md): Prisma cannot express
-- CHECK constraints, so `prisma migrate dev` has nothing to generate here and
-- reports no drift — the baseline that first added this constraint
-- (20260825170000_iss8001_branch_materialization_retry) says the same.
--
-- ADDITIVE: this only ADDS one accepted value, so every row already stored
-- satisfies the new predicate and no data can be rejected or lost. It is also a
-- provable no-op against the code deployed today, which has no path that emits
-- the value.
--
-- ONE EXPLICIT TRANSACTION, DELIBERATELY. `prisma migrate deploy` applies a
-- migration file WITHOUT a transaction wrapper, so bare statements would
-- autocommit the DROP on its own and leave a committed window in which `reason`
-- accepts anything at all; if the ADD then failed, the column would stay
-- permanently unconstrained behind a failed `_prisma_migrations` row. The
-- BEGIN/COMMIT makes the swap atomic. `IF EXISTS` on the DROP keeps a re-run
-- idempotent rather than raising 42704 against a constraint a prior attempt
-- already replaced. Precedent and the full reasoning:
-- 20260902100000_iss7149_pr_materialization_retry_reason_vocabulary.
--
-- LOCK IMPLICATION: ADD CONSTRAINT ... CHECK takes ACCESS EXCLUSIVE on
-- branch_materialization_retries and scans it once to validate. The risk is
-- lock QUEUEING behind a concurrent drain claim rather than scan duration, so
-- `SET LOCAL lock_timeout` bounds the blast radius: the migration fails fast and
-- rolls back whole rather than stalling the drain. `SET LOCAL` is correct here
-- precisely because there IS a transaction block — it reverts at COMMIT.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "branch_materialization_retries"
DROP CONSTRAINT IF EXISTS "branch_materialization_retries_reason_check";

ALTER TABLE "branch_materialization_retries"
ADD CONSTRAINT "branch_materialization_retries_reason_check"
CHECK (
    "reason" IS NULL OR "reason" IN (
        'authority_unavailable',
        'attempts_exhausted',
        'conflicting_authority',
        'corrupt_state',
        'cross_organization',
        'default_branch',
        'identity_mismatch',
        'not_pushed',
        'source_missing'
    )
);

COMMIT;
