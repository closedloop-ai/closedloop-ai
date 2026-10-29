-- ISS-7149: widen `pr_materialization_retries_reason_check` to accept the two
-- terminal reasons that previously had no member in the vocabulary and were
-- therefore both persisted and monitored as 'attempts_exhausted':
--
--   'provider_delay_out_of_policy' — the provider named a retry delay outside
--     what isProviderRetryDelayWithinPolicy accepts: longer than
--     PrMaterializationRetryPolicy.MaxProviderDelaySeconds (6h), or otherwise
--     unusable (non-positive, or not a safe integer). The claim is abandoned on
--     whatever attempt it is on, often the first.
--   'retry_horizon_exceeded'       — the next attempt would fall past the row's
--     created_at + MaxHorizonMs (24h) horizon.
--
-- HAND-WRITTEN ON PURPOSE (packages/database/AGENTS.md): Prisma cannot express
-- CHECK constraints, so `prisma migrate dev` has nothing to generate here and
-- reports no drift — the baseline that first added this constraint
-- (20260818200348_iss5971_loop_pr_materialization_retry) says the same.
--
-- Neither is exhaustion: both abandon a claim that still has attempts left, so
-- an event reading `reason: attempts_exhausted, attempts: 1` against a
-- MaxAttempts of 5 contradicted itself on its face. The Datadog terminal-event
-- monitor could not tell a rate-limit backoff blowout from a spent retry.
--
-- ADDITIVE: this only ADDS two accepted values, so every row already stored
-- satisfies the new predicate and no data can be rejected or lost. That also
-- makes it a provable no-op against the code deployed today, which has no
-- member emitting either value — it is the compatibility half of ISS-7149 and
-- lands one deploy AHEAD of the drain change that starts emitting them.
--
-- ONE EXPLICIT TRANSACTION, DELIBERATELY. `prisma migrate deploy` applies a
-- migration file WITHOUT a transaction wrapper — measured, and documented at
-- length in 20260828140000_iss8462_pull_request_detail_desktop_originated. Bare
-- statements would therefore autocommit the DROP on its own and leave a
-- committed window in which `reason` accepts anything at all; if the ADD then
-- failed, the column would stay permanently unconstrained behind a failed
-- `_prisma_migrations` row. The BEGIN/COMMIT below makes the swap atomic, so no
-- writer and no failure path can observe the column unconstrained. `IF EXISTS`
-- on the DROP additionally keeps a re-run idempotent rather than raising 42704
-- against a constraint a prior attempt already replaced.
--
-- LOCK IMPLICATION: ADD CONSTRAINT ... CHECK takes ACCESS EXCLUSIVE on
-- pr_materialization_retries and scans it once to validate. Only the SUCCESS
-- path deletes a row (settleSuccessfulPrMaterializationRetry,
-- apps/api/lib/loops/pr-materialization-retry.ts) — terminal and dead-letter
-- settlements UPDATE in place, and nothing reaps them, so the table retains
-- every abandoned claim and its size tracks cumulative materialization
-- failures rather than the live queue depth. The scan is still short at today's
-- volume, and the risk remains lock QUEUEING behind a concurrent drain claim
-- rather than scan duration, so lock_timeout bounds the blast radius: the
-- migration fails fast and rolls back whole rather than stalling the drain.
--
-- WHAT THAT FAST FAILURE COSTS, given the transaction above: not a wedged
-- pipeline. A lock_timeout abort rolls the whole migration back, so it leaves a
-- FAILED `_prisma_migrations` row and NO partial DDL. Non-preview recovery
-- (packages/database/scripts/migrate-deploy-recovery.ts) resolves that row as
-- rolled back on the P3018/P3009 it raises and reruns `prisma migrate deploy`
-- itself, and with nothing committed for the retry to collide with, this file
-- re-applies cleanly — no operator step. The `partial_committed_ddl_artifact`
-- dead end in docs/runbooks/prisma-deploy-migration-recovery.md is reached only
-- when that retry meets an object a PARTIAL commit already created (42P07 /
-- 42701 / 42710), which is exactly what the BEGIN/COMMIT above rules out. So a
-- timeout costs one stalled deploy attempt, and both the drain and the deploy
-- recover without a human.
--
-- `SET LOCAL` is correct here precisely because there IS a transaction block —
-- it reverts at COMMIT, so the bound cannot follow the shared `migrate deploy`
-- connection into a later migration that legitimately waits longer.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "pr_materialization_retries"
DROP CONSTRAINT IF EXISTS "pr_materialization_retries_reason_check";

ALTER TABLE "pr_materialization_retries"
ADD CONSTRAINT "pr_materialization_retries_reason_check"
CHECK (
    "reason" IS NULL OR "reason" IN (
        'provider_unavailable',
        'provider_rate_limit',
        'attempts_exhausted',
        'corrupt_state',
        'source_conflict',
        'authorization_lost',
        'repository_removed',
        'installation_inactive',
        'installation_missing',
        'cross_organization',
        'pull_request_not_found',
        'credential_unauthorized',
        'permission_denied',
        'provider_delay_out_of_policy',
        'retry_horizon_exceeded'
    )
);

COMMIT;
