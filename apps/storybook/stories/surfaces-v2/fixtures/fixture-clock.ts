/**
 * Maps a fixture's authored instants onto the days ending YESTERDAY (UTC),
 * keeping each one's time of day and their spacing.
 *
 * A windowed list narrows the rows it renders to its default date range, so a
 * pinned ISO instant leaves that window on a calendar boundary and empties
 * every row-dependent story and `play` with no code change (ISS-12442);
 * `e2e/helpers/branches-surface-fixtures.ts` carries a note about the same
 * failure. Yesterday rather than today because `branch-row-adapter.ts` drops a
 * future instant to an em dash, which today's anchor produces on any run before
 * the authored time of day.
 *
 * Caller contract: `newestAuthoredDay` is UTC midnight of the latest day the
 * fixture pins, and the authored span must be SHORTER than the narrowest window
 * any surface reading that fixture applies, or the oldest instants still fall
 * off the back of it. `__tests__/surfaces-v2-fixture-window.test.ts` holds both
 * callers to that.
 */
export function createFixtureInstant(
  newestAuthoredDay: string
): (value: string) => string {
  const authoredAnchor = Date.parse(newestAuthoredDay);
  return (value: string) =>
    new Date(
      Date.parse(value) + yesterdayUtcMidnight() - authoredAnchor
    ).toISOString();
}

function yesterdayUtcMidnight(): number {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 1
  );
}
