// Zod-free so a zod-free module can apply the same floor
// (`list-query-capability.ts`).

/**
 * Earliest instant a PostgreSQL `timestamp` column can hold (4713 BC).
 *
 * `-4712`, not `-4713`, because `Date.UTC` takes an ASTRONOMICAL year, which has
 * a year zero: 4713 BC is astronomical -4712. Writing the era year here would
 * put the floor a year BELOW Postgres's and admit a value the column refuses.
 *
 * There is deliberately no matching upper bound. Postgres tops out at 294276 AD,
 * which is ABOVE the largest instant a JS `Date` can represent (+275760-09-13),
 * so any value that survives `Date.parse` as finite is already inside the
 * column's range at the top end. A `PG_TIMESTAMP_MAX_MS` would be unreachable —
 * and computing one as `Date.UTC(294_276, 0, 1)` yields `NaN`, which would make
 * every comparison against it false and reject every timestamp.
 */
export const PG_TIMESTAMP_MIN_MS = Date.UTC(-4712, 0, 1);

/**
 * Whether an instant is below {@link PG_TIMESTAMP_MIN_MS} — the one range test
 * the repo performs, so every site that guards a Postgres `timestamp` write or
 * filter agrees on the floor. `NaN` (a malformed value) is NOT below the floor:
 * malformed is a separate condition that each caller already rejects on its own
 * terms, and folding it in here would let a range guard silently absorb a parse
 * failure.
 */
export function isBelowPgTimestampFloor(instant: Date | number): boolean {
  return Number(instant) < PG_TIMESTAMP_MIN_MS;
}
