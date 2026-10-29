/**
 * @file session-sync-watermark.ts
 * @description The `sessions.updated_at` sync-watermark helpers, extracted from
 * `write-core.ts` (ISS-6003). They are a cohesive pair used by the boot-heal /
 * analytics-maintenance passes rather than by the import write path itself, and
 * `session-analytics-maintenance.ts` already imported both across the module
 * boundary. Moving them here keeps `write-core.ts` shrinking
 * (see AGENTS.md -> "File Size and Organization").
 */
import type { Prisma } from "./generated/client.js";

/**
 * SYNC INVARIANT helper: advance `sessions.updated_at` for the given ids inside
 * the caller's transaction. Cloud sync selects sessions by `sessions.updated_at`
 * (`listUpdatedSessionCursorRows` in `sync-source.ts`), so a boot heal that
 * rewrites a cloud-synced snapshot (`session_analytics.is_human` / `.est_cost`,
 * `sessions.cost_usd_estimated`, …) but leaves `updated_at` untouched keeps an
 * already-uploaded session showing its stale value in the cloud dashboard until
 * some unrelated mutation touches the row. Mirrors the FEA-3226 /
 * `healCacheCostSplit` pattern. No-op for an empty id list. The bump only
 * advances (the timestamp derives from the boot wall-clock), so it never
 * regresses the watermark, and every caller is convergent (re-selects nothing on
 * the next boot), so a healed session is re-bumped at most once.
 *
 * CURSOR-GROUP BOUND (FEA-3485): a heal that spans several chunks must pass a
 * PER-CHUNK-DISTINCT, strictly-increasing timestamp (see `chunkWatermark`), NOT
 * one shared `now` for the whole pass. The sync cursor persists every session id
 * sharing the top `updated_at` into `observedIdsAtTopUpdatedAt`
 * (`agent-session-sync-service.ts`), uncapped, in the SyncState JSON column. A
 * single shared `now` would fold an O(stale-corpus) set into that top group,
 * the same cursor blow-up the `backfillSessionAnalytics` SYNC NOTE rejects.
 * Staggering per chunk keeps the top group bounded to the last chunk.
 *
 * Callers must be BOUNDED to the actually-stale set (as the heal passes are).
 * The unbounded `backfillSessionAnalytics` deliberately does NOT call this — see
 * its SYNC NOTE for why a whole-corpus single-`now` bump is a regression.
 *
 * The bumped value MUST be an ISO 'T'-form timestamp (as `Date#toISOString` /
 * `chunkWatermark` produce). The cursor compares `updated_at` as a raw string and
 * SQLite's `datetime('now')` space form sorts BEFORE any same-date ISO stamp,
 * which would make a healed bump invisible to the cursor (FEA-3232 review).
 */
export async function bumpSessionsUpdatedAt(
  tx: Prisma.TransactionClient,
  ids: string[],
  now: string
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(", ");
  await tx.$executeRawUnsafe(
    `UPDATE sessions SET updated_at = $1 WHERE id IN (${placeholders})`,
    now,
    ...ids
  );
}

/**
 * FEA-3485: derive a per-chunk sync watermark from the pass's base `now` by
 * offsetting `chunkIndex` milliseconds. Strictly increasing across chunks and
 * always >= the base boot wall-clock, so it never regresses the cursor while
 * giving each chunk its OWN `updated_at`. That bounds the sync cursor's
 * top-timestamp group (`observedIdsAtTopUpdatedAt`) to a single chunk even when a
 * heal repairs an O(corpus) stale set spread over many chunks, avoiding the
 * uncapped cursor blow-up documented on `bumpSessionsUpdatedAt`. Millisecond ISO
 * precision matches `Date#toISOString`, so lexical `updated_at` comparison in the
 * cursor query (`sinceUpdatedAt` >=) orders these exactly as numeric time.
 */
export function chunkWatermark(now: string, chunkIndex: number): string {
  if (chunkIndex === 0) {
    return now;
  }
  return new Date(new Date(now).getTime() + chunkIndex).toISOString();
}

/**
 * Advance ONE session's watermark strictly forward, reporting whether it
 * actually wrote. The single writer for the
 * import pipeline's change signals (FEA-2729 / FEA-3227 links, ISS-5801
 * invocations, ISS-8699 events), which the isolated import path and the
 * stored-row invocation rebuild had each spelled out inline.
 *
 * CALL IT INSIDE THE TRANSACTION THAT COMMITS THE CHANGE IT DESCRIBES (ISS-8758).
 * Every signal that reaches here is an in-pass before/after OBSERVATION of state
 * the same pass committed, so it is not reproducible: a bump that lands in its own
 * transaction and fails is never retried — the next import re-reads the
 * already-committed state, sees no change, and the session stays behind the
 * incremental cursor until an unrelated mutation moves `updated_at`. Sharing a
 * transaction with the change makes the pair all-or-nothing, which is what makes
 * the observation re-derivable on the retry.
 *
 * ISS-8758 (whitlockk on #6383): the target is read HERE, per call, rather than
 * captured once per pass, because the value this must clear is whatever the row
 * holds at the moment of the write — a stale tie the pass inherited, an earlier
 * group of this same pass, or a live-hook bump that landed in between.
 * {@link sessionSyncWatermarkTarget} explains why anything short of strict
 * forward progress leaves the change behind the cursor.
 *
 * The writers that set this column alongside other columns — the gate's content
 * and reactivation writes, and the terminal-end reconciliation — cannot use this
 * function without issuing a second UPDATE, so they bind
 * {@link readSessionSyncWatermarkTarget} into their own SET instead (ISS-8871).
 *
 * ISS-11088: `false` means the write was DECLINED — this column's representation
 * has no value that sorts after the stored one, so the change cannot be made
 * selectable (see {@link sessionSyncWatermarkTarget}). It is not an error and
 * most callers rightly ignore it, but a caller that also commits a "done" marker
 * in the same transaction MUST NOT treat a decline as an advance: doing so marks
 * the work complete while leaving it un-advertised for good. Roll that
 * transaction back and retry instead.
 */
export async function advanceSessionSyncWatermark(
  tx: Pick<Prisma.TransactionClient, "$executeRawUnsafe" | "$queryRawUnsafe">,
  sessionId: string,
  now: string
): Promise<boolean> {
  const target = await readSessionSyncWatermarkTarget(tx, sessionId, now);
  if (target === null) {
    return false;
  }
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET updated_at = $1 WHERE id = $2",
    target,
    sessionId
  );
  return true;
}

/**
 * `now`, or — when the row is ALREADY at or past it — the millisecond after the
 * stored value. The step keeps the `toISOString()` form every writer of this
 * column uses, so the column's lexicographic ordering stays its chronological
 * ordering.
 *
 * STRICT forward progress is the contract, not merely a monotonic MAX, and it
 * covers two cases at once. The stale tie is ISS-8758's defect B. The other is
 * intra-pass: an earlier group in the SAME import (a bump for another signal,
 * the gate's content write, the terminal-end reconciliation) may have already
 * published the row at `now`, and a sync read can interleave between two group
 * commits — so a later group that writes `now` back would leave its own change
 * behind a cursor that has already observed the row at that timestamp.
 *
 * `null` means DO NOT WRITE — there is no value this column's ordering can
 * accept as an advance for the stored one (see {@link orderableSuccessor}).
 *
 * `null` rather than `now`, and that is the whole of the second half of this fix
 * (davetho on #6457). Falling back to `now` there writes a value that sorts
 * BELOW the stored one, so it neither re-selects the row under
 * `updated_at > $cursor` nor leaves it where it was: the row is unselectable AND
 * has lost the marker it had, and it may now sit behind cursors it was ahead of.
 * Declining the write is what the pre-ISS-8758 monotonic MAX did with such a
 * value too, so it is the option that cannot make any cursor worse — the change
 * still does not reach the cloud in that case, but no alternative in this
 * representation would have made it, and this one does not also destroy data.
 */
export function sessionSyncWatermarkTarget(
  now: string,
  storedUpdatedAt: string | null
): string | null {
  if (storedUpdatedAt === null || storedUpdatedAt < now) {
    return now;
  }
  return orderableSuccessor(storedUpdatedAt);
}

/**
 * The millisecond after `storedUpdatedAt`, or `null` when this column's
 * representation has no successor that sorts AFTER it.
 *
 * Two ways that happens, and the explicit `> storedUpdatedAt` check is what
 * makes the second one caught rather than shipped:
 *   - the stored value is not a timestamp at all (a legacy row), so
 *     `chunkWatermark` throws `RangeError` off `new Date(NaN).toISOString()` —
 *     and note such a value sorts ABOVE every four-digit stamp anyway, so there
 *     is no orderable successor for it either; and
 *   - ISS-8758 (davetho on #6457): the stored value is the last millisecond
 *     `toISOString`'s four-digit-year form can express. Its successor leaves that
 *     form — `9999-12-31T23:59:59.999Z` steps to `+010000-01-01T00:00:00.000Z` —
 *     and the cursor compares `updated_at` as raw TEXT, where the leading `+`
 *     sorts BEFORE `9`. The "advance" would put the row lexically BEHIND where it
 *     already sat, so `updated_at > $cursor` would never select it again.
 *
 * Four-digit ISO is therefore the supported range of this column, enforced here
 * rather than assumed: `sessions.updated_at` carries no range constraint.
 */
function orderableSuccessor(storedUpdatedAt: string): string | null {
  let successor: string;
  try {
    successor = chunkWatermark(storedUpdatedAt, 1);
  } catch {
    return null;
  }
  return successor > storedUpdatedAt ? successor : null;
}

/**
 * The value a writer must put in `sessions.updated_at` for its change to stay
 * selectable, or `null` when the column must be left alone
 * ({@link sessionSyncWatermarkTarget} owns both answers). `null` for a row that
 * does not exist, which no caller may treat as a reason to insert one.
 *
 * ISS-8871: for the writers that set this column in the SAME statement as the
 * change it describes (the gate's content and reactivation writes, the
 * terminal-end reconciliation), so the strict-forward guarantee costs no extra
 * UPDATE. Those call sites bind the result through
 * `updated_at = COALESCE($n, updated_at)`, which is what carries the `null`
 * decline into SQL without a second statement shape.
 *
 * Read on the CALLER'S transaction, and therefore on the single writer
 * connection: no other writer can interleave between this read and the caller's
 * write, and the read sees this pass's own earlier commits — including an
 * earlier writer of this same pass that already advanced the row.
 */
export async function readSessionSyncWatermarkTarget(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  sessionId: string,
  now: string
): Promise<string | null> {
  const rows = await tx.$queryRawUnsafe<{ updated_at: string | null }[]>(
    "SELECT updated_at FROM sessions WHERE id = $1",
    sessionId
  );
  if (rows.length === 0) {
    return null;
  }
  return sessionSyncWatermarkTarget(now, rows[0]?.updated_at ?? null);
}
