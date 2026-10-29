import { GITHUB_PULL_REQUESTS_BY_NUMBER_MAX_ALIASES } from "@repo/api/src/github-pull-requests-by-number";

/** How many terminal-but-missing-LOC rows a single tick tries to self-heal. */
export const RECONCILE_SELF_HEAL_BATCH = 25;

/**
 * Debounces bounded per-PR provider reads between reconcile ticks. Rows whose
 * provider data is inaccessible or permanently missing would otherwise refill a
 * fixed targeted/self-heal batch every tick and starve the tail.
 */
export const RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS = 24 * 60 * 60 * 1000;

export const RECONCILE_SELF_HEAL_DEBOUNCE_MS =
  RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS;

/**
 * The same debounce, shortened, for a `desktop_sync` row that carries no
 * fetchable fact (ISS-8423). Such a row is worth retrying sooner than a day
 * because until it is filled its branch fails cloud eligibility and vanishes
 * from the Branches list — but it still needs a bound, for exactly the reason
 * the 24h constant above states: a PR number the provider will never resolve is
 * the shape this arm selects most often, and an UNBOUNDED arm would refill the
 * batch with it every tick. It sorts first (`last_verified_at ASC NULLS
 * FIRST`), so unbounded it would also starve the verified tail behind it.
 *
 * This window only bounds anything because the desktop lane no longer stamps
 * `lastRefreshAttemptAt` on a write this arm would still classify as a stub:
 * the column is that row's reconciler-owned attempt clock, and a producer that
 * re-stamped it on every sync would push an ACTIVE branch's stub back out of
 * any window, however short — the self-reinforcement ISS-8423 measured. The
 * producer's gate is the shared `DESKTOP_PR_FETCHABLE_FACT_COLUMNS` map, so a
 * `state`-only ref (which observes something but fills none of the columns a
 * fetch could) does not reset this clock either.
 */
export const RECONCILE_DESKTOP_STUB_ATTEMPT_DEBOUNCE_MS = 60 * 60 * 1000;

/**
 * ISS-12034: how many delivery-coverage GAP rows one installed-tier tick
 * point-reads — session-linked PR rows the coverage numerator does not count.
 *
 * Sized well under {@link RECONCILE_SELF_HEAL_BATCH} on purpose. This arm's
 * population is the monitored shortfall itself, which prod measures at 2 and 3
 * rows on the two repos that page (ISS-12034), not a backlog: a tick that needs
 * more than 8 is a repo whose coverage is collapsing, and the right response to
 * that is the alert firing, not this lane quietly absorbing it. It also rides on
 * top of the self-heal batch in the SAME by-number provider read, so the bound
 * keeps the combined request inside the budget that read already honors.
 */
export const RECONCILE_COVERAGE_GAP_BATCH = 8;

export const RECONCILE_UNVERIFIED_PULL_REQUEST_BATCH =
  GITHUB_PULL_REQUESTS_BY_NUMBER_MAX_ALIASES -
  RECONCILE_SELF_HEAL_BATCH -
  RECONCILE_COVERAGE_GAP_BATCH;
