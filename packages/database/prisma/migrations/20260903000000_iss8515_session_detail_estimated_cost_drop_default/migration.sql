-- ISS-8515: drop `DEFAULT 0` from `session_detail.estimated_cost`.
--
-- The column has been NULLABLE since ISS-7813; only the default goes. `null` is
-- the honest persisted value for a cost nothing ever computed, and the default
-- was what turned an omitted write into a confident $0 — the exact conflation
-- `sessionHasNumericCost` was added to detect. The sibling column
-- `authoritative_cost_usd` (ISS-7229) was created nullable with NO default for
-- this same reason; this brings `estimated_cost` in line with it.
--
-- WHY THIS IS SAFE NOW, AND WAS NOT AT ISS-7813. That migration kept the default
-- deliberately, because `resolveTokenRollupColumns` returned `{}` for a payload
-- with no token rows and the create arm then OMITTED the column — dropping the
-- default would have written NULL from a path nobody had changed. The precondition
-- is now met: both production insert paths name the column explicitly, verified by
-- enumerating direct `sessionDetail.create|upsert|createMany` calls AND nested
-- `session: { create }` relation creates across apps/ and packages/ (a direct-call
-- grep alone cannot see the nested form). Exactly two production paths exist:
-- `upsert-session-slice.ts` and `session-write-service.ts`, both in this change.
--
-- No row is rewritten. Existing zeros stay zero; repairing them is ISS-8517.
--
-- LOCK IMPLICATION. Dropping a default is a catalog-only change and does NOT
-- rewrite the heap, so the lock is held for the catalog write rather than a table
-- scan. But it still takes ACCESS EXCLUSIVE on `session_detail`, which is a large
-- and hot table, so the real risk is lock QUEUEING behind a long-running reader —
-- everything arriving behind it queues too. The bound below makes this migration
-- fail fast and be retried rather than stall writes. Same reasoning, same shape as
-- 20260827120000_iss8070_widen_artifact_link_branch_participation_method.
--
-- `SET` and not `SET LOCAL`: `prisma migrate deploy` applies every pending
-- migration over ONE connection, and `SET LOCAL` is a no-op outside a transaction
-- block, which would drop the guard entirely rather than scope it. The explicit
-- `RESET` hands the session back at its configured default so this 5s bound cannot
-- follow the rest of the deploy and fail an unrelated later migration that
-- legitimately waits longer for its lock.
--
-- ROLLBACK: `SET lock_timeout` / `ALTER TABLE "session_detail" ALTER COLUMN
-- "estimated_cost" SET DEFAULT 0;` / `RESET lock_timeout` — the same catalog lock,
-- so the same bound. A CODE-ONLY rollback is safe to any post-ISS-7813 bundle
-- because the read side already distinguishes null from $0; it is NOT safe past
-- ISS-7813, whose `branch-cost-evidence.ts` threw on a null cost.
SET lock_timeout = '5s';

ALTER TABLE "session_detail" ALTER COLUMN "estimated_cost" DROP DEFAULT;

RESET lock_timeout;
