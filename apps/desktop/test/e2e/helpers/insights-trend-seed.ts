/**
 * A seed instant that lands inside the Insights TREND window on any run day.
 *
 * ISS-6268. Two dashboard chart specs seeded at a literal
 * `"2026-05-15T12:00:00.000Z"` and widened the range to "All time", on the
 * stated assumption that this put the fixture in scope "regardless of the run
 * clock". It does not: FEA-2210 caps trend series at a ROLLING
 * {@link TREND_LOOKBACK_DAYS} even for `InsightsPeriod.All`, so that the
 * all-time corpus cannot paint an unreadable ~200-column heatmap. KPI totals
 * stay uncapped, which is why only the chart assertions notice.
 *
 * The seed therefore aged out at 2026-05-15T12:00Z + 90d = 2026-08-13T12:00Z and
 * took `desktop-e2e` — a required check — red across every open PR in the repo,
 * on five branches from four authors plus the merge queue, with nothing in any
 * of those diffs to explain it.
 *
 * Derived from the production constant rather than a second literal so that
 * moving the cap moves the seed with it — but imported from the LEAF module that
 * holds only the constant, never from `local-insights-range.ts`. That module
 * reaches `db-helpers.ts` and `@repo/api/src/types/agent-component`, which the
 * Playwright loader cannot resolve: importing it here aborted the entire
 * `desktop-e2e` run before any spec executed (wongk, PR #4974).
 */
import { TREND_LOOKBACK_DAYS } from "../../../src/main/database/insights-trend-window.js";

const MS_PER_DAY = 86_400_000;

/**
 * How far back to place the seed.
 *
 * Not zero: a fixture stamped "now" races the clock the app reads, and a
 * same-instant bucket is the one most likely to fall on the wrong side of a
 * local-day boundary. Not near the cap either — the margin below is what stops
 * a long suite, a slow runner, or a timezone offset from pushing the point back
 * out of the window mid-run.
 */
const SEED_DAYS_AGO = 7;

if (SEED_DAYS_AGO >= TREND_LOOKBACK_DAYS) {
  throw new Error(
    `SEED_DAYS_AGO (${SEED_DAYS_AGO}) must stay inside the ${TREND_LOOKBACK_DAYS}-day trend window`
  );
}

/**
 * An instant inside the trend window, in the past, stable within a run.
 *
 * `now` is injectable so a unit test can pin the clock; production e2e specs
 * take the default.
 */
export function insightsTrendSeedAt(now: Date = new Date()): Date {
  return new Date(now.getTime() - SEED_DAYS_AGO * MS_PER_DAY);
}

/**
 * {@link insightsTrendSeedAt} as the ISO string the seed helpers store.
 *
 * For a fixture that needs a SPAN rather than a point, take
 * {@link insightsTrendSeedAt} once and derive both ends from it — two calls here
 * would read the clock twice and could straddle a millisecond.
 */
export function insightsTrendSeedIso(now: Date = new Date()): string {
  return insightsTrendSeedAt(now).toISOString();
}
