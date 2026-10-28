import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type { TransactionClient } from "@repo/database";
import { AGENT_SESSION_UPSERT_TX_TIMEOUT_MS } from "@/app/agent-sessions/service/ingest-work-budget";

export type PullRequestProviderLockIdentity = {
  organizationId: string;
  repositoryFullName: string;
  number: number;
};

/**
 * Serialize every cloud and Desktop writer for the same provider-independent
 * PR identity. Locks are sorted so a Session carrying several PRs cannot
 * deadlock another writer that observed the same set in a different order.
 *
 * The sort is JavaScript's, and it is the only sort. Two or more keys go to
 * `advisory_xact_lock_text_keys_in_order` in one statement, which locks them in
 * array order and never re-sorts (ISS-11608): a SQL `ORDER BY` uses the
 * database collation, which orders hyphenated repository names differently and
 * deadlocks against writers still taking these keys one at a time. A single key
 * keeps the one-statement form, so single-PR writers do not depend on that
 * function existing.
 */
export async function acquirePullRequestProviderIdentityLocksInTransaction(
  tx: Pick<TransactionClient, "$executeRaw">,
  identities: readonly PullRequestProviderLockIdentity[]
): Promise<void> {
  const keys = [
    ...new Set(
      identities.map((identity) => pullRequestProviderLockKey(identity))
    ),
  ].sort();
  if (keys.length === 0) {
    return;
  }
  if (keys.length === 1) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${keys[0]}, 0::bigint))`;
    return;
  }
  await tx.$executeRaw`SELECT advisory_xact_lock_text_keys_in_order(${keys}::text[])`;
}

/** Acquire the canonical lock for one provider-independent PR identity. */
export function acquirePullRequestProviderIdentityLockInTransaction(
  tx: Pick<TransactionClient, "$executeRaw">,
  identity: PullRequestProviderLockIdentity
): Promise<void> {
  return acquirePullRequestProviderIdentityLocksInTransaction(tx, [identity]);
}

/** Stable database advisory-lock key used by production barriers and writers. */
export function pullRequestProviderLockKey(
  identity: PullRequestProviderLockIdentity
): string {
  return `iss-6980:pull-request-provider:${identity.organizationId}:${normalizeRepoFullName(identity.repositoryFullName)}#${identity.number}`;
}

/**
 * Budget a WAITER keeps for its OWN work, on top of the longest a holder of
 * this lock may live.
 *
 * Prisma's default interactive-transaction timeout, and not a guess: it is the
 * budget the short lock-taking bodies (`upsertBranchArtifactOnce`, the
 * `pull_request` webhook) ran their WHOLE selves under before ISS-6980 put a
 * blocking acquisition in the path, so the pre-/post-lock work being reserved
 * for is measured by a bound those paths demonstrably already lived within.
 */
const PROVIDER_LOCK_WAITER_WORK_MS = 5000;

/**
 * What the GitHub backfill projection write needs for one batch. Its own
 * `BACKFILL_PROJECTION_TRANSACTION_TIMEOUT_MS`, moved here rather than dropped
 * when that lane started reading its bounds from this module: the ceiling below
 * has to cover it independently of what the session lane happens to carry.
 */
const BACKFILL_PROJECTION_TX_TIMEOUT_MS = 30_000;

/**
 * Bounds for a transaction that takes this lock and is itself a LONG HOLDER of
 * it — a batch whose work is the point, not the wait: the session-sync ingest
 * slice (which carries `AGENT_SESSION_UPSERT_TX_TIMEOUT_MS` from its own work
 * budget) and the GitHub backfill projection write.
 *
 * The MAX of what those two need, not either one: written as just the session
 * constant, a later cut to the desktop-sync work budget would silently shrink
 * the backfill batch below the budget it independently already had, and no test
 * would go red because both suites assert against whatever this resolves to.
 *
 * This is also the ceiling `pullRequestProviderLockTxOptions` is derived FROM,
 * so it must not itself be derived from that: a waiter cannot reserve a margin
 * beyond the maximum holder lifetime if every holder is sized to the waiter's
 * own bound.
 */
export const pullRequestProviderLockHolderTxOptions = {
  maxWait: 5000,
  timeout: Math.max(
    AGENT_SESSION_UPSERT_TX_TIMEOUT_MS,
    BACKFILL_PROJECTION_TX_TIMEOUT_MS
  ),
} as const;

/**
 * Bounds for a SHORT transaction that takes this lock and may have to wait out
 * one of the holders above.
 *
 * ISS-7130: `pg_advisory_xact_lock` BLOCKS, and it blocks inside the waiter's
 * own transaction — so the transaction `timeout`, not `maxWait`, is what bounds
 * the wait. On Prisma's 5s default a waiter aborts with P2028 under exactly the
 * contention the lock exists to serialize, and its write is lost rather than
 * ordered behind the holder.
 *
 * The ceiling is DERIVED, not picked, and the derivation is the whole point. A
 * waiter's clock starts at BEGIN, not when `pg_advisory_xact_lock` returns, so
 * what it must cover is the longest a holder may live PLUS its own pre- and
 * post-lock work. Sizing it to the holder ceiling EXACTLY left that own work no
 * budget at all, so a holder running near its ceiling still took the waiter
 * down with P2028 and still lost the write (davetho, #6454).
 *
 * The derivation does not close on itself, because the two kinds of lane hold
 * the lock for different lengths. A holder-bound lane may hold it for its whole
 * batch, which is why that ceiling is an independent constant rather than this
 * one minus a margin. A waiter-bound lane's HOLD is only its own post-lock work
 * — the value below is wait PLUS work, never work alone — budgeted at
 * `PROVIDER_LOCK_WAITER_WORK_MS` on the evidence that these bodies ran their
 * ENTIRE selves inside Prisma's 5s default before ISS-6980. So the maximum
 * holder lifetime the margin is reserved beyond stays the 30s ceiling, not this
 * one. That decomposition is MODELED, not enforced: a waiter-bound lane that
 * ever needed more than its own-work budget would quietly become the longest
 * holder and eat the margin, which is what to check before adding work inside
 * one of these transactions.
 *
 * WHAT IS STILL NOT CLOSED, and cannot be by any ceiling: a QUEUE. Two
 * long-batch lanes are each other's waiters on one shared bound, and no bound
 * satisfies "waiter outlives holder plus its own work" when the holder's
 * lifetime IS that same bound; a third waiter behind them is worse again. The
 * session-sync slice lane is the same shape from the other side — its deadline
 * clamp can hand a slice far less than the holder ceiling, and a clamped slice
 * contending here still loses. Both need a bounded recovery path (replay the
 * whole write after a P2028), not a larger number, and are left as named
 * follow-up: a waiter pins its pooled connection for whatever ceiling it is
 * given and the `pull_request` webhook answers GitHub synchronously, so the
 * residual is cheaper than paying pool pressure on every delivery for
 * contention that is rare per PR identity.
 *
 * `maxWait` bounds pooled-connection acquisition only, which the lock does not
 * affect; it is named here so both bounds are read from one owner instead of
 * being restated per call site.
 */
export const pullRequestProviderLockTxOptions = {
  maxWait: 5000,
  timeout:
    pullRequestProviderLockHolderTxOptions.timeout +
    PROVIDER_LOCK_WAITER_WORK_MS,
} as const;
