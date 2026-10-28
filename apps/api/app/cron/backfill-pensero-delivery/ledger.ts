import { withDb } from "@repo/database";
import { toIsoDateOnly } from "@/lib/date-only";
import type { DeliveryPointWindow } from "@/lib/delivery-points/delivery-point-attribution";
import type { BackfillCursors } from "./day-plan";

/**
 * Persistence for the Pensero backfill's attempt ledger and cursors (ISS-8761).
 *
 * ## Every write here is an atomic upsert
 *
 * Both tables carry a UNIQUE key the write targets directly
 * (`(organization_id, day)` and `organization_id`), so a ledger entry and a
 * cursor move are each ONE statement. A `findFirst`-then-create/update would
 * race two overlapping runs — the cron's own retry against a slow predecessor
 * is exactly that case — and the loser would either throw on the unique index
 * or silently clobber the other's counters.
 *
 * ## The ledger records attempts, never completeness
 *
 * There is no `complete` column and no code path that would set one. A day's
 * `lastSuccessAt` means a fetch returned without a transport or parse failure;
 * a zero-row day sets it exactly like a busy one, because a zero-row day IS a
 * successful attempt whose answer was "nothing" — and, per
 * `SegmentCompleteness`, we cannot tell that answer from a truncated window.
 * That is precisely why the recheck cursor exists to ask again.
 */

/** What one day's attempt did. `null` failure means it succeeded. */
export type BackfillDayOutcome = {
  readonly day: string;
  readonly succeeded: boolean;
  /** The failure, when it failed. Cleared on success so it cannot go stale. */
  readonly failureReason: string | null;
  /** Rows persisted by a successful attempt. Zero is a real measurement. */
  readonly rowsWritten: number;
};

/** One organization's persisted walk state, as the planner consumes it. */
export type OrganizationBackfillState = {
  readonly cursors: BackfillCursors;
  readonly attemptedDays: readonly string[];
};

/**
 * Read one organization's cursors and a window of the days it has attempted.
 *
 * ## The window is ANCHORED AT THE RECHECK CURSOR, and this is load-bearing
 *
 * The day table grows by one row per org per day forever in both directions —
 * one for each new day, and one for each day the backward walk discovers — so
 * the read has to be bounded. Bounding it the obvious way (oldest N, ascending)
 * is a starvation bug rather than a saving: past N attempted days the query
 * returns the same oldest N every run, the round-robin lane can only ever see
 * that prefix, and every day after it is NEVER rechecked. The cursor would
 * advance to the end of the prefix and wrap inside it forever.
 *
 * So the window starts strictly after the cursor and WRAPS: days after the
 * cursor first, then — only if that did not fill the budget — the oldest days,
 * which is where the round robin is about to wrap to anyway. The bound
 * therefore narrows how much is read on any one run, never which days are
 * eligible to be read on some run.
 *
 * The two reads are sequential rather than concurrent because the second one's
 * predicate is the first one's result.
 */
export async function readOrganizationBackfillState(
  organizationId: string,
  attemptedDayLimit: number
): Promise<OrganizationBackfillState> {
  const limit = Math.max(1, Math.floor(attemptedDayLimit));
  const cursorRow = await withDb((db) =>
    db.penseroBackfillCursor.findUnique({
      where: { organizationId },
      select: { backwardCursor: true, recheckCursor: true },
    })
  );
  const recheckCursor = cursorRow?.recheckCursor ?? null;

  const afterCursor = await withDb((db) =>
    db.penseroBackfillDay.findMany({
      where: {
        organizationId,
        ...(recheckCursor ? { day: { gt: recheckCursor } } : {}),
      },
      select: { day: true },
      orderBy: { day: "asc" },
      take: limit,
    })
  );

  const days = new Set(afterCursor.map((row) => toIsoDateOnly(row.day)));
  if (days.size < limit) {
    const wrapped = await withDb((db) =>
      db.penseroBackfillDay.findMany({
        where: { organizationId },
        select: { day: true },
        orderBy: { day: "asc" },
        take: limit - days.size,
      })
    );
    for (const row of wrapped) {
      days.add(toIsoDateOnly(row.day));
    }
  }

  return {
    cursors: {
      backwardCursor: cursorRow?.backwardCursor
        ? toIsoDateOnly(cursorRow.backwardCursor)
        : null,
      recheckCursor: recheckCursor ? toIsoDateOnly(recheckCursor) : null,
    },
    attemptedDays: [...days].sort(),
  };
}

/**
 * Record one day's attempt.
 *
 * `attemptCount` increments on EVERY attempt including a failed one — it counts
 * what we did, not what worked — while `lastSuccessAt` and `lastRowsWritten`
 * move only on success. A failure therefore cannot overwrite the record of the
 * last time we actually got an answer, which is the figure an operator needs to
 * tell "failing since Tuesday" from "never worked".
 */
export async function recordBackfillDayAttempt(
  organizationId: string,
  attemptedAt: Date,
  outcome: BackfillDayOutcome
): Promise<void> {
  const day = new Date(`${outcome.day}T00:00:00.000Z`);
  const successFields = outcome.succeeded
    ? {
        lastSuccessAt: attemptedAt,
        lastFailureReason: null,
        lastRowsWritten: outcome.rowsWritten,
      }
    : { lastFailureReason: outcome.failureReason };

  await withDb((db) =>
    db.penseroBackfillDay.upsert({
      where: { organizationId_day: { organizationId, day } },
      create: {
        organizationId,
        day,
        lastAttemptAt: attemptedAt,
        attemptCount: 1,
        lastSuccessAt: outcome.succeeded ? attemptedAt : null,
        lastFailureReason: outcome.succeeded ? null : outcome.failureReason,
        lastRowsWritten: outcome.succeeded ? outcome.rowsWritten : 0,
      },
      update: {
        lastAttemptAt: attemptedAt,
        attemptCount: { increment: 1 },
        ...successFields,
      },
    })
  );
}

/**
 * Move one organization's cursors to where this run left off.
 *
 * Written AFTER the day attempts, so an invocation killed mid-run leaves the
 * cursors where they were and the next run simply re-asks days it may already
 * have fetched. Re-asking is free — every write downstream is an idempotent
 * upsert keyed on the provider's own row id — whereas advancing a cursor over
 * work that did not happen loses those days until the round robin wraps.
 *
 * ## The backward cursor is written MONOTONICALLY. The recheck cursor is not.
 *
 * Each run computes its cursors from the state it read at its own start, so two
 * overlapping sweeps for one org — the daily run and a retry against a slow
 * predecessor, which nothing serializes — can finish out of order. A blind
 * last-write-wins on the BACKWARD cursor would then let the staler run drag it
 * back over history the other one already walked. The conditional `updateMany`
 * below decides that in SQL rather than in process: it advances only when the
 * new value is strictly older than what is stored, so an out-of-order write is
 * a no-op instead of a regression, and it is still one statement rather than a
 * read-modify-write.
 *
 * The RECHECK cursor deliberately gets no such guard, because monotonicity is
 * the wrong invariant for a cursor that wraps: at the end of a cycle it moves
 * from the newest attempted day back to the oldest, and a "must not go
 * backwards" rule would pin it at the newest day forever and stop the round
 * robin dead. A stale write there costs at most a partial re-walk of the cycle,
 * which is the same idempotent re-ask the rest of this design is built on.
 */
export async function writeBackfillCursors(
  organizationId: string,
  cursors: BackfillCursors
): Promise<void> {
  const backwardCursor = toDateOrNull(cursors.backwardCursor);
  const recheckCursor = toDateOrNull(cursors.recheckCursor);

  // Establish the row and set the wrapping cursor in one atomic upsert. The
  // backward value goes in on CREATE only — there is nothing to regress past
  // when the row did not exist — and is left alone on UPDATE so the guarded
  // write below is the only thing that can move it.
  await withDb((db) =>
    db.penseroBackfillCursor.upsert({
      where: { organizationId },
      create: { organizationId, backwardCursor, recheckCursor },
      update: { recheckCursor },
    })
  );

  if (!backwardCursor) {
    return;
  }
  await withDb((db) =>
    db.penseroBackfillCursor.updateMany({
      where: {
        organizationId,
        OR: [
          { backwardCursor: null },
          { backwardCursor: { gt: backwardCursor } },
        ],
      },
      data: { backwardCursor },
    })
  );
}

/** `YYYY-MM-DD` to a UTC-midnight Date, or null for an absent cursor. */
function toDateOrNull(day: string | null): Date | null {
  return day ? new Date(`${day}T00:00:00.000Z`) : null;
}

/**
 * ISS-9930: whether this org has a day it attempted and never once retrieved.
 *
 * An EXISTENCE check, not a count, because existence is all the disclosure
 * asks. BOUNDED AT BOTH ENDS, which took an index and not a rewrite: this runs
 * on every eligible branch detail, and while `findFirst` always stopped at the
 * first failed day, the HEALTHY case — no failed day — used to walk this org's
 * whole slice of the `(organization_id, day)` index, one row per attempted day,
 * growing forever in both directions as the backfill walks history (see
 * {@link PenseroBackfillCursor}'s schema doc). ISS-9930 (whitlockk, #7539) added
 * `pensero_backfill_days_organization_id_last_success_at_idx`, so the predicate
 * is now an index condition on both columns: the scan seeks to this org, then to
 * its `IS NULL` group, and in the healthy case that group is empty and no heap
 * row is read. Measured on 20k days for each of two orgs: 2 shared buffers with
 * the index, 572 and a sequential scan without it.
 *
 * It lives beside the writes because this module owns `penseroBackfillDay`, and
 * `lastSuccessAt IS NULL` is the same "every attempt so far has failed" the
 * schema comment and {@link recordBackfillDayAttempt} already define.
 *
 * ISS-10653: `window` narrows the probe to the UTC days its instants fall on,
 * both ends inclusive — the grain `day` is written at and the bounds
 * `DeliveryPointWindow` already uses. Omitted, or with neither end, it is the
 * org-wide probe.
 */
export async function hasFailedPenseroBackfillDay(
  organizationId: string,
  window?: DeliveryPointWindow
): Promise<boolean> {
  const row = await withDb((db) =>
    db.penseroBackfillDay.findFirst({
      where: { organizationId, lastSuccessAt: null, ...dayRange(window) },
      select: { id: true },
    })
  );
  return row !== null;
}

function dayRange(window: DeliveryPointWindow | undefined) {
  if (!(window?.start || window?.end)) {
    return {};
  }
  return {
    day: {
      ...(window.start ? { gte: utcDay(window.start) } : {}),
      ...(window.end ? { lte: utcDay(window.end) } : {}),
    },
  };
}

/** The stored `day` an instant falls on, built as {@link recordBackfillDayAttempt} builds it. */
function utcDay(instant: Date): Date {
  return new Date(`${toIsoDateOnly(instant)}T00:00:00.000Z`);
}
