import type { TransactionClient } from "@repo/database";
import {
  type IndexKeyOrigin,
  indexKeyLookupCandidates,
} from "@/lib/index-key-lookup";

/**
 * Acquires BOTH the legacy 32-bit and new 64-bit per-session advisory locks in
 * a fixed old-then-new order for deploy-transition safety (PRD-536 D12).
 *
 * The two locks are acquired in separate sequential statements so PostgreSQL
 * cannot reorder them within a single SELECT list — concurrent transactions
 * always acquire in the same order and cannot deadlock.
 *
 * ISS-8200: over the whole CANDIDATE SET for this identity, not over the one
 * string the caller happens to hold. `hashtext` of two different strings is two
 * different lock slots, and the ingest passes the RAW wire id
 * (`session-slice-identity.ts`) while the stale reaper passes the DB-read —
 * therefore possibly PROJECTED — id (`stale-session-reaper-service.ts`). For
 * exactly the sessions ISS-8069 re-keyed, the two stopped mutually excluding:
 * each took a slot the other never asked for and both wrote the same row
 * concurrently. Locking every key the identity could be stored under makes the
 * two sets OVERLAP whichever value each side is holding, which is all mutual
 * exclusion needs.
 */
export async function acquireSessionAdvisoryLocks(
  tx: TransactionClient,
  externalSessionId: string,
  // REQUIRED, not defaulted (ISS-8200 review). A default sent a column-read
  // value down the WIRE path, which re-projects it — and `projectIndexKey` is
  // not idempotent, so an already-projected key becomes a THIRD value and the
  // caller locks a slot no other writer takes. That is worse than the single
  // shared slot it replaced, and it type-checked silently. Naming the origin is
  // now the only way to call this.
  origin: IndexKeyOrigin
): Promise<void> {
  for (const key of sessionAdvisoryLockKeys(externalSessionId, origin)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0::bigint))`;
  }
}

/**
 * Serialize every writer for one Session's Branch/PR relationship set.
 *
 * One key per Session, taken at most once per transaction (ISS-11608). Every
 * writer of a Session->Branch edge holds this key before it touches the edge,
 * so a finer per-edge lock added no exclusion; the key string is unchanged, so
 * pods still taking the old per-edge locks after it exclude this one.
 *
 * The skip relies on the transaction having no SAVEPOINT: a lock taken inside a
 * rolled-back subtransaction is released while the memo still records it.
 * `upsert-sessions-batch-commit-boundary.integration.test.ts` pins that the
 * ingest slice opens none.
 */
export async function acquireSessionArtifactLinksAdvisoryLock(
  tx: Pick<TransactionClient, "$executeRaw">,
  input: {
    organizationId: string;
    sessionArtifactId: string;
  }
): Promise<void> {
  const sessionIdentity = `iss-6980:session-artifact-links:${input.organizationId}:${input.sessionArtifactId}`;
  const held = sessionLinkLocksHeldByTransaction.get(tx);
  if (held?.has(sessionIdentity)) {
    return;
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${sessionIdentity}, 0::bigint))`;
  if (held) {
    held.add(sessionIdentity);
  } else {
    sessionLinkLocksHeldByTransaction.set(tx, new Set([sessionIdentity]));
  }
}

/**
 * ISS-8602: the NON-BLOCKING twin of {@link acquireSessionAdvisoryLocks}, for a
 * background sweep that writes a session's columns but must never queue behind
 * live ingest traffic. Takes the same pair in the same old-then-new order and
 * reports whether it got BOTH.
 *
 * `$queryRaw`, not `$executeRaw`: `pg_try_advisory_xact_lock` returns `bool`,
 * unlike the void-returning blocking form Prisma cannot deserialize (ISS-8780).
 *
 * Two statements, not one SELECT list, for the same reason the blocking form
 * uses two — and here it also short-circuits, so a caller that loses the 32-bit
 * lock does not go on to hold the 64-bit one for a session it is about to skip.
 *
 * A `false` means some other transaction holds the session, which for a sweep is
 * itself the answer: the row is being written right now, so it is not abandoned.
 * Callers must treat the candidate as skipped, never as clear-to-write.
 */
export async function tryAcquireSessionAdvisoryLocks(
  tx: TransactionClient,
  externalSessionId: string,
  /** REQUIRED for the reason {@link acquireSessionAdvisoryLocks} states. */
  origin: IndexKeyOrigin
): Promise<boolean> {
  for (const key of sessionAdvisoryLockKeys(externalSessionId, origin)) {
    const legacy = await tx.$queryRaw<
      Array<{ acquired: boolean }>
    >`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS acquired`;
    if (legacy[0]?.acquired !== true) {
      return false;
    }
    const current = await tx.$queryRaw<
      Array<{ acquired: boolean }>
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0::bigint)) AS acquired`;
    if (current[0]?.acquired !== true) {
      return false;
    }
  }
  return true;
}

/**
 * The keys one session identity must be locked under, in a GLOBAL TOTAL ORDER.
 *
 * Sorted rather than left in candidate order, which is what keeps the multi-key
 * acquisition deadlock-free: every caller walks the same sorted key list and,
 * within a key, the same old-then-new flavour order, so two transactions holding
 * overlapping sets acquire along one consistent order and cannot form a cycle.
 * Candidate ORDER still decides which row wins a lookup — see
 * `lib/index-key-lookup.ts` — but it must not decide lock order, and the two
 * concerns are independent.
 *
 * One key for every id inside the byte budget, which is all of them in practice,
 * so ordinary traffic takes exactly the pair of locks this replaced.
 */
function sessionAdvisoryLockKeys(
  externalSessionId: string,
  origin: IndexKeyOrigin
): string[] {
  return [...indexKeyLookupCandidates(externalSessionId, origin)].sort();
}

/**
 * Session-link keys each transaction client already holds. Keyed weakly on the
 * client, so an entry goes when the transaction's client is collected. A miss
 * (a wrapped client) costs one re-entrant statement; a false hit would need one
 * client reused across transactions, which Prisma does not do.
 */
const sessionLinkLocksHeldByTransaction = new WeakMap<object, Set<string>>();
