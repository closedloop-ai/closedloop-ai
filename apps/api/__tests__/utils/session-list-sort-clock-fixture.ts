/**
 * ISS-8554 Phase 3 — the minute anchor the SQL-native list-sort suites seed a
 * RUNNING row against.
 *
 * Shared because both the single-rule `duration` suite and the compound-chain
 * suite need it, and the statements they cover splice the same minute-flooring
 * fragment: a second copy of this is how one suite comes to exercise the floor
 * and the other silently stops (tamsinb on #8732).
 */

import { withDb } from "@repo/database";

const MINUTE_MS = 60_000;
/** How far inside a minute the anchor has to sit, at either edge. */
const ANCHOR_MARGIN_MS = 5000;
const ANCHOR_LATEST_MS = MINUTE_MS - 2 * ANCHOR_MARGIN_MS;

/** Postgres's `now()` — the clock the statements under test actually read. */
export async function readDatabaseNowMs(): Promise<number> {
  const rows = await withDb(
    (db) =>
      db.$queryRaw<{ dbNow: Date }[]>`
        SELECT (now() AT TIME ZONE 'UTC') AS "dbNow"
      `
  );
  return rows[0].dbNow.getTime();
}

/**
 * The DATABASE's current minute boundary, entered far enough from both of its
 * edges that a fixture anchored on it is not racing the clock.
 *
 * Flooring is only observable relative to where inside a minute the statement
 * runs, so this reads Postgres's own clock rather than the host's and, when the
 * remainder sits too close to an edge, waits to re-enter the window. Too EARLY
 * and a bare `now()` would measure a span the 1s reference row still outranks,
 * hiding the mutation; too LATE and the statement could cross into the next
 * minute and read the anchored row as a full minute long.
 */
export async function settleOnAMinuteAnchor(): Promise<number> {
  let nowMs = await readDatabaseNowMs();
  const entryRemainderMs = nowMs % MINUTE_MS;
  if (
    entryRemainderMs < ANCHOR_MARGIN_MS ||
    entryRemainderMs > ANCHOR_LATEST_MS
  ) {
    const toWindowMs =
      entryRemainderMs < ANCHOR_MARGIN_MS
        ? ANCHOR_MARGIN_MS - entryRemainderMs
        : MINUTE_MS - entryRemainderMs + ANCHOR_MARGIN_MS;
    await new Promise((resolve) => setTimeout(resolve, toWindowMs));
    nowMs = await readDatabaseNowMs();
  }
  const remainderMs = nowMs % MINUTE_MS;
  if (remainderMs < ANCHOR_MARGIN_MS || remainderMs > ANCHOR_LATEST_MS) {
    throw new Error(
      `anchor window missed: ${remainderMs}ms into the minute, wanted ${ANCHOR_MARGIN_MS}..${ANCHOR_LATEST_MS}ms`
    );
  }
  return nowMs - remainderMs;
}
