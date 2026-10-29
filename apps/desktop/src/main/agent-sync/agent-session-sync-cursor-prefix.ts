/**
 * @file agent-session-sync-cursor-prefix.ts
 * @description ISS-8041: WHERE the session lane's durable cursor is allowed to
 * be recorded — the acked-contiguous PREFIX boundary. Extracted out of the
 * grandfathered `agent-session-sync-service.ts` as a cohesive, directly
 * unit-testable sibling, mirroring `incremental-cursor-feed` /
 * `backfill-queue-feed`: the service keeps only the thin delegate that hands its
 * own fields through, and the policy argument lives here where it can be tested
 * without a service, a source, or a transport.
 *
 * THE BUG THIS REPLACES. FEA-1962 persisted the watermark only once BOTH queues
 * were empty and no chunk tail was pinned. That is an all-or-nothing watermark:
 * ONE session in bounded retry (`applyBoundedFailureFold`) pins the cursor while
 * every other session in the corpus acks, so the lane completes units every pass
 * against a motionless cursor — the ISS-8041 signature, which the ISS-7401
 * burn-down diagnostic names as `DURABLE CURSOR NOT ADVANCING`. Nothing was
 * lost, but every restart re-walked the whole window (`re-enqueued 254 un-acked
 * agent session(s) ... on resume`), so the lane never converged.
 *
 * THE RULE. Record the OLDEST `updated_at` still owed by a lane, not the newest
 * one observed. Everything strictly below that stamp has been acked, so it is a
 * safe resume point; everything at or above it is re-selected on restart.
 *
 * WHY THE EMPTY TIED-TOP SET IS THE MECHANISM, not a loss of precision. The
 * resume scan is `updated_at > $1 OR (updated_at = $1 AND id NOT IN (<tied>))`
 * (`listUpdatedSessionCursorRows`, `database/sync-source.ts`), and an EMPTY tied
 * set omits the `NOT IN` term entirely — SQLite rejects `NOT IN ()` — so the
 * predicate collapses to `updated_at >= $1` and re-selects the whole tied group.
 * A prefix boundary therefore persists `{ boundary, [] }`: the row still queued
 * AT the boundary stamp is re-selected by construction, and so is every row
 * above it. This is the same fallback `capPersistedTopIds` already relies on for
 * an over-cap tied set, and the outbox plus the server idempotently dedupe the
 * rows that were in fact already acked. The IN-MEMORY tied set is untouched, so
 * live incremental dedup stays exact.
 *
 * THE HARD INVARIANT — never advance past a row that could still need
 * re-selection after a restart — is upheld by three refusals, in this order:
 *
 *  1. UNKNOWN PROVENANCE BLOCKS EVERYTHING. Only a row admitted by a live cursor
 *     scan carries a stamp this lane can compare (`queuedUpdatedAtById`). A row
 *     that reached a queue by another route — the resume re-enqueue from the
 *     durable outbox, a data-revision inject, a recovered dead-letter — has no
 *     stamp here, so there is no boundary that can be proven to sit below it and
 *     NOTHING is recorded. That is exactly the pre-ISS-8041 behavior, which is
 *     the correct floor: those rows are the ones whose durable outbox row is
 *     written fire-and-forget (`recordOutboxEnqueue`, `recordOutboxRePend`,
 *     `recordOutboxReEnqueue`), so their durable coverage is not confirmed and
 *     may not be assumed.
 *  2. THE BOUNDARY IS A MINIMUM, not a sample. One retrying row holds the whole
 *     cursor at its own stamp; the lane still makes forward progress every time
 *     that oldest row changes, which is the property ISS-8041 asks for.
 *  3. IT NEVER MOVES BACKWARDS. FEA-3473 deliberately persists the corpus
 *     maximum mid-backfill once the outbox seed commits, so during that walk the
 *     durable cursor is legitimately AHEAD of the oldest queued row. Recomputing
 *     a prefix there would rewrite it downwards and reinstate the full re-walk
 *     that FEA-3473 removed, so a boundary at or below what was last written is
 *     refused rather than persisted.
 *
 * DEAD-LETTERED ROWS DO NOT BLOCK, unchanged. They are dequeued when abandoned,
 * so they never reach `unackedIds`, and they are RECORDED in the cursor's own
 * `deadLetteredIds` list instead of pinning it.
 *
 * Pure: it reads the state it is handed and returns what to record, so no
 * durable write, telemetry, or scheduling decision is made here.
 */

/**
 * A watermark that is safe to record durably. `observedIdsAtTopUpdatedAt` is the
 * tied-top set to serialize — the live one when the lane is fully drained, and
 * EMPTY at a prefix boundary so the resume scan re-selects the whole tied group.
 */
export type CursorPrefixBoundary = {
  observedTopUpdatedAt: string;
  observedIdsAtTopUpdatedAt: ReadonlySet<string>;
};

/**
 * Shared by every prefix boundary. Never mutated — `buildPersistedCursorState`
 * only spreads it — so one frozen instance stands in for all of them.
 */
const EMPTY_TIED_TOP_IDS: ReadonlySet<string> = Object.freeze(
  new Set<string>()
) as ReadonlySet<string>;

/**
 * The lane state the boundary is computed from. Matches the service's own
 * fields, so it passes them straight through.
 */
export type CursorPrefixInput = {
  /**
   * Every id a lane still owes: both queues, plus any pinned chunk tail. A
   * MATERIALIZED array, never a lazy iterable — this is read more than once, and
   * a generator handed across this boundary yields nothing on the second pass,
   * which reads as "nothing is owed" rather than as an error.
   */
  unackedIds: readonly string[];
  /** `updated_at` per id admitted by a live scan; ABSENT means unknown provenance. */
  queuedUpdatedAtById: ReadonlyMap<string, string>;
  /** The lane's live tied-top watermark, or null before the first scan. */
  observedTopUpdatedAt: string | null;
  observedIdsAtTopUpdatedAt: ReadonlySet<string>;
  /** The watermark last written durably for this identity, or null if none was. */
  lastPersistedTopUpdatedAt: string | null;
};

/**
 * Resolve the watermark this lane may record right now, or `null` when it may
 * record nothing. See the file header for the three refusals that make the
 * non-null answer safe.
 *
 * `updated_at` is compared as a raw string on purpose: the resume scan compares
 * the same TEXT column byte-wise under BINARY collation, so lexical order here
 * is the order the restart will actually apply (`session-sync-watermark.ts`).
 */
export function resolveCursorPrefixBoundary(
  input: CursorPrefixInput
): CursorPrefixBoundary | null {
  if (input.observedTopUpdatedAt === null) {
    return null;
  }
  const oldestUnacked = scanOldestUnacked(input);
  if (oldestUnacked === undefined) {
    return null;
  }
  if (oldestUnacked === null) {
    // Fully drained: record the live watermark and its exact tied-top set, the
    // pre-ISS-8041 behavior for this case, unchanged.
    return {
      observedTopUpdatedAt: input.observedTopUpdatedAt,
      observedIdsAtTopUpdatedAt: input.observedIdsAtTopUpdatedAt,
    };
  }
  if (
    input.lastPersistedTopUpdatedAt !== null &&
    oldestUnacked <= input.lastPersistedTopUpdatedAt
  ) {
    return null;
  }
  return {
    observedTopUpdatedAt: oldestUnacked,
    observedIdsAtTopUpdatedAt: EMPTY_TIED_TOP_IDS,
  };
}

/**
 * ISS-10429: the row the durable cursor is waiting on, named for the burn-down's
 * cursor-stall detector. `value` is the OLDEST stamp among the ids the lane still
 * owes, in the same units as the `sync_state` watermark, so it is exactly the
 * position {@link resolveCursorPrefixBoundary} would record next.
 */
export type SessionCursorBoundary = {
  /** The identity the in-memory queues belong to. */
  sourceKey: string;
  value: string;
};

/**
 * ISS-10429: the oldest stamp among the ids the lane still owes, or `null` when
 * no row can be named. That is the case when nothing is owed, or when an owed id
 * has no live-scan stamp (the unknown provenance that makes
 * {@link resolveCursorPrefixBoundary} record nothing).
 */
export function resolveOldestOwedUpdatedAt(
  input: Pick<CursorPrefixInput, "unackedIds" | "queuedUpdatedAtById">
): string | null {
  return scanOldestUnacked(input) ?? null;
}

/**
 * The oldest stamp among the owed ids. `undefined` when an owed id has no stamp,
 * `null` when nothing is owed. The two mean different things to
 * {@link resolveCursorPrefixBoundary}: record nothing, or record the live top.
 */
function scanOldestUnacked(
  input: Pick<CursorPrefixInput, "unackedIds" | "queuedUpdatedAtById">
): string | null | undefined {
  let oldestUnacked: string | null = null;
  for (const id of input.unackedIds) {
    const updatedAt = input.queuedUpdatedAtById.get(id);
    if (updatedAt === undefined) {
      return;
    }
    if (oldestUnacked === null || updatedAt < oldestUnacked) {
      oldestUnacked = updatedAt;
    }
  }
  return oldestUnacked;
}
