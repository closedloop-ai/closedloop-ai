/**
 * The ONE hand-written window table the cross-surface parity suites assert
 * against — `apps/api/app/insights/service/period-sessions-window-parity.test.ts`
 * and `apps/desktop/test/insights-sessions-window-parity.test.ts`.
 *
 * ISS-10583 asked for a test that fails when the two resolvers DIVERGE. Two
 * copies of these literals, one per suite, cannot do that: a change to one
 * resolver plus a matching edit to its own copy is green on both sides while the
 * product is back to two windows for one selection — the exact defect. Sharing
 * the table is what makes a coordinated edit show up, because there is only one
 * thing to edit and every suite reading it goes red together.
 *
 * WRITTEN OUT, never derived. Nothing here imports `stable-utc-window` or either
 * resolver, and nothing computes a bound — a fixture that called the code it
 * polices would agree with it no matter what that code did. Each value below was
 * obtained by counting UTC days.
 *
 * It lives in this package because it is the only one `apps/api`, `apps/desktop`
 * and `packages/app` all already depend on, and `apps/api` cannot see
 * `@repo/app`.
 *
 * ITS TEST-ONLY SCOPE IS A CONVENTION, NOT A BOUNDARY (review, 2026-09-18).
 * `@closedloop-ai/loops-api`'s exports map is `./*` -> `./src/*.ts`, so this module is
 * importable from PRODUCTION code in any of the three consumers and nothing
 * would stop it. The two importers today are the parity suites named above and
 * that is the whole set, but the directory name is the only thing saying so.
 *
 * If you are here because you want these literals in shipped code: you do not.
 * They are a hand-counted snapshot of one instant, `PARITY_NOW_ISO`, and they
 * exist to DISAGREE with the resolvers when those drift. Production wants
 * `stable-utc-window`, which computes a window for the actual clock.
 */

/**
 * The clock every parity assertion is made at. Midday UTC on purpose: it is
 * where a rolling now-anchored window and a stable UTC day window are furthest
 * apart, so a resolver that regressed to the old shape cannot coincide with
 * these bounds.
 */
export const PARITY_NOW_ISO = "2026-09-17T12:00:00.000Z";

export type ParityWindow = { startDate: string; endDate: string };

/**
 * Derivation, by hand. At {@link PARITY_NOW_ISO} the current UTC day is
 * 2026-09-17, and each window is the inclusive run of N UTC days ENDING with it:
 *
 * - 7 days  → Sep 11…Sep 17.
 * - 30 days → Sep 1…Sep 17 is 17 days, so 13 more reach back to Aug 19.
 * - 90 days → 17 (Sep) + 31 (Aug) + 31 (Jul) is 79, so 11 more reach to Jun 20.
 *
 * Every window closes at the last instant of Sep 17, which is ahead of the clock
 * — see `stableUtcWindowElapsedEnd` for why that is the point rather than a bug.
 */
export const PARITY_WINDOW_BY_DAYS: Record<number, ParityWindow> = {
  7: {
    startDate: "2026-09-11T00:00:00.000Z",
    endDate: "2026-09-17T23:59:59.999Z",
  },
  30: {
    startDate: "2026-08-19T00:00:00.000Z",
    endDate: "2026-09-17T23:59:59.999Z",
  },
  90: {
    startDate: "2026-06-20T00:00:00.000Z",
    endDate: "2026-09-17T23:59:59.999Z",
  },
};

/** The day counts above, for suites that iterate rather than index. */
export const PARITY_WINDOW_DAYS = [7, 30, 90] as const;

/** The instant the 7-day window has actually reached at {@link PARITY_NOW_ISO}. */
export const PARITY_ELAPSED_END_ISO = "2026-09-17T12:00:00.000Z";

/**
 * The 7-day prior window: one full period before Sep 11 00:00 is Sep 4 00:00,
 * and the clock has run 6 days 12 hours into the current window, so the prior
 * one closes at Sep 10 12:00 — the same weekday and hour as the current
 * window's own leading edge.
 */
export const PARITY_PRIOR_WINDOW: ParityWindow = {
  startDate: "2026-09-04T00:00:00.000Z",
  endDate: "2026-09-10T12:00:00.000Z",
};

/**
 * The window the NEXT UTC day resolves to for 7 days. The positive twin of every
 * "the window does not move through the day" assertion: without it, a resolver
 * that ignored `now` entirely would satisfy the stability check.
 */
export const PARITY_NEXT_UTC_DAY_NOW_ISO = "2026-09-18T00:00:00.000Z";
export const PARITY_NEXT_UTC_DAY_WINDOW: ParityWindow = {
  startDate: "2026-09-12T00:00:00.000Z",
  endDate: "2026-09-18T23:59:59.999Z",
};

/**
 * ISS-12263: a session's last activity AFTER the shared windows' end — six
 * hours into Sep 18, the UTC day after {@link PARITY_NOW_ISO}'s. The Sessions
 * list's "All" sends no bounds, so it lists this session, and the all-time
 * Sessions KPI, status donut and cost must count it too.
 */
export const PARITY_FUTURE_LAST_ACTIVITY_ISO = "2026-09-18T06:00:00.000Z";
