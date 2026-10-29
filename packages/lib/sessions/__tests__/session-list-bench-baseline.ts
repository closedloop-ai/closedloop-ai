/**
 * ISS-9483 (PRD-721 R10-S08) — the recorded p95 latency per Sessions list
 * query, and the p95 helper both benches report it with. Read by
 * `apps/api/app/agent-sessions/service/session-list-query.bench.ts` and
 * `apps/desktop/test/session-list-query.bench.ts`.
 *
 * Reporting only: a bench prints its current p95 beside the recorded one and
 * asserts nothing (Perrin Upcott, 2026-10-12, ISS-9483 "Baseline as budget":
 * "reported, not a CI gate").
 */

export const SessionListBenchHost = {
  Cloud: "cloud",
  Desktop: "desktop",
} as const;
export type SessionListBenchHost =
  (typeof SessionListBenchHost)[keyof typeof SessionListBenchHost];

/** Recorded p95 in ms, keyed host, then store size, then parity query name. */
export type SessionListBenchBaseline = Record<
  SessionListBenchHost,
  Record<string, Record<string, number>>
>;

/**
 * Each value is the MEDIAN nearest-rank p95 of one query's latency samples
 * across several full bench runs, not a single run: review found single-run
 * outliers where a smaller store read slower than a 3.4x-bigger one on the
 * same query (e.g. desktop `status` at 45.999ms/2,296 rows vs 13.432ms/7,872
 * rows in the first measurement), so this re-measures with the median.
 *
 * Machine (one laptop, both hosts), 2026-10-13: Apple M1 Max, 10 cores,
 * 32 GiB RAM, macOS 26.6.2 (25G83), Node v24.18.1. Cloud store: Postgres
 * 16.15 (`postgres:16`, local Docker, a disposable scratch database). Desktop
 * store: SQLite 3.53.1 (Node's built-in `node:sqlite`, no separate image).
 *
 * Cloud (`findSessions`), N=5 full runs (vitest bench, retainSamples), UTC,
 * each a window (load average 1/5/15-min at start -> at end):
 *   run1 02:05-02:08   6.82/6.19/6.30   -> 8.86/7.42/6.74
 *   run2 02:09-02:13   8.86/7.42/6.74   -> 16.15/11.13/8.46
 *   run3 02:13-02:17  19.88/12.11/8.84  -> 15.12/15.02/11.05
 *   run4 02:18-02:23  15.80/16.15/12.05 -> 8.54/12.86/11.67
 *   run5 02:24-02:28  10.58/12.50/11.69 -> 10.12/11.63/11.51
 * (run1's start reading is the closest capture before launch, ~3 min stale;
 * every other reading above was taken at that exact moment. This machine ran
 * other concurrent work throughout — load is from a shared box, not an idle
 * one, by design; see the N rationale below.)
 *
 * Desktop (`getSharedAgentSessions`) was measured TWICE, N=3 full runs each
 * time, UTC. First measurement (pre-#8768, reported below only to show the
 * before/after):
 *   run1 02:13-03:10  19.40/12.38/9.00  -> 9.29/10.07/10.14
 *   run2 03:10-04:05  10.16/10.23/10.20 -> 6.45/7.08/8.27
 *   run3 04:05-04:56   6.34/7.03/8.23   -> 6.72/6.54/6.91
 * Second measurement, on this branch merged onto main at ISS-12439 (#8768,
 * main `24a07a4639`, merge commit `18ef3ef398`), which rewrote the desktop
 * list-facet/sort queries in SQL and added a facet-index migration — the
 * recorded desktop values below are this measurement's medians:
 *   run1 05:08-05:35  13.77/12.45/10.08 -> 7.42/8.82/9.54
 *   run2 05:35-06:01   7.08/8.64/9.45   -> 7.41/8.80/9.39
 *   run3 06:01-06:27   7.20/8.71/9.35   -> 7.13/6.41/6.61
 * Cloud is untouched by that merge (#8768 is desktop-only) and keeps its
 * first-measurement numbers above.
 *
 * N differs by host because cost differs by two orders of magnitude (~4 min
 * a cloud run, ~26-57 min a desktop run): cloud ran long enough (5) to show
 * diminishing returns — the worst-case row's median moved <75% going from 3
 * to 5 runs, comfortably inside the ~200% ("about 3x") swing review named as
 * this baseline's noise floor, so a tighter N buys little; desktop kept the
 * ruling's minimum of 3 each time, since a literal median of 3 already
 * discards exactly one high and one low draw per query — the single-bad-run
 * failure mode review described. Desktop's own run-to-run spread is
 * comparable (median ~24%, worst ~79%, before taking the median), consistent
 * with the same "about 3x" noise floor.
 *
 * Both reviewer-named outliers resolved once medianed, and #8768 did not
 * move either beyond that same noise: desktop `status` (45.999/13.432ms
 * single-run -> 13.317/13.502ms first median -> 13.137/13.849ms second
 * median, a <2.6% move) and `last activity desc` (39.196/11.854ms ->
 * 12.364/12.329ms -> 12.216/12.432ms, a <1.2% move) read flat across store
 * sizes throughout. `cloud["owner, includeEmpty false"]` does NOT resolve —
 * it still orders backwards after N=5 (39.94ms at 2,296 rows vs 26.821ms at
 * 7,872 rows, down from a 39.962/19.336ms single-run gap); reported as
 * measured, not hand-tuned.
 *
 * #8768's facet indexes otherwise dropped nearly every non-indexed desktop
 * query's p95 by ~97-99.5% at both store sizes — e.g. `owner` 713.874ms ->
 * 12.762ms at 2,296 rows, `priority` 2270.156ms -> 12.492ms at 7,872 rows —
 * far past any run-to-run noise this baseline measured; that whole family
 * (`owner`, `harness`, `model`, `priority`, `cost asc`/`desc`, `updated
 * asc`/`desc`, `status and cost`) is why the desktop numbers below are a
 * full re-measurement, not a touch-up.
 *
 * Store sizes `DESKTOP_STORE_SESSIONS` (2,293 and 7,865 sessions, replicated
 * to 2,296 and 7,872 rows); pinned in session-list-bench-baseline.test.ts so
 * a moved constant invalidates this baseline instead of silently drifting.
 */
export const SESSION_LIST_BENCH_BASELINE: SessionListBenchBaseline = {
  cloud: {
    p50: {
      status: 29.976,
      "status, two values": 28.9,
      "status, includeEmpty false": 21.848,
      owner: 179.423,
      "owner, includeEmpty false": 39.94,
      harness: 21.87,
      "harness, includeEmpty false": 21.633,
      model: 30.708,
      repository: 35.849,
      "repository, includeEmpty false": 23.848,
      priority: 26.595,
      "priority isEmpty": 19.362,
      "priority isNotEmpty": 25.297,
      "last activity window": 24.482,
      "status and cost": 21.932,
      "cost asc": 20.441,
      "cost desc": 22.111,
      "started asc": 20.683,
      "started desc": 37.573,
      "last activity asc": 38.169,
      "last activity desc": 41.555,
      "updated asc": 87.552,
      "updated desc": 90.237,
      "model asc": 20.859,
      "model desc": 22.43,
      "priority desc, one harness": 30.261,
      "status asc, one repository": 22.685,
      "harness asc, one priority": 37.18,
      "repository asc, one status": 20.834,
      "duration desc, ended rows": 52.492,
      "second page": 13.34,
    },
    p95: {
      status: 33.417,
      "status, two values": 30.403,
      "status, includeEmpty false": 23.801,
      owner: 23.282,
      "owner, includeEmpty false": 26.821,
      harness: 24.138,
      "harness, includeEmpty false": 24.799,
      model: 50.644,
      repository: 24.424,
      "repository, includeEmpty false": 23.605,
      priority: 27.177,
      "priority isEmpty": 29.432,
      "priority isNotEmpty": 28.998,
      "last activity window": 47.932,
      "status and cost": 26.646,
      "cost asc": 24.198,
      "cost desc": 27.697,
      "started asc": 22.282,
      "started desc": 22.801,
      "last activity asc": 29.346,
      "last activity desc": 26.907,
      "updated asc": 241.779,
      "updated desc": 261.38,
      "model asc": 21.508,
      "model desc": 28.307,
      "priority desc, one harness": 36.123,
      "status asc, one repository": 29.083,
      "harness asc, one priority": 24.862,
      "repository asc, one status": 25.926,
      "duration desc, ended rows": 123.191,
      "second page": 17.331,
    },
  },
  desktop: {
    p50: {
      status: 13.137,
      "status, two values": 13.217,
      "status, includeEmpty false": 12.151,
      owner: 12.762,
      "owner, includeEmpty false": 12.244,
      harness: 12.583,
      "harness, includeEmpty false": 12.559,
      model: 12.23,
      repository: 21.29,
      "repository, includeEmpty false": 26.437,
      priority: 13.64,
      "priority isEmpty": 13.631,
      "priority isNotEmpty": 13.374,
      "last activity window": 12.183,
      "status and cost": 858.209,
      "cost asc": 529.301,
      "cost desc": 572.501,
      "started asc": 13.025,
      "started desc": 12.388,
      "last activity asc": 12.269,
      "last activity desc": 12.216,
      "updated asc": 13.557,
      "updated desc": 12.428,
      "model asc": 577.856,
      "model desc": 461.003,
      "priority desc, one harness": 536.704,
      "status asc, one repository": 140.933,
      "harness asc, one priority": 624.145,
      "repository asc, one status": 534.613,
      "duration desc, ended rows": 467.597,
      "second page": 4.263,
    },
    p95: {
      status: 13.849,
      "status, two values": 15.174,
      "status, includeEmpty false": 13.008,
      owner: 12.775,
      "owner, includeEmpty false": 13.719,
      harness: 12.848,
      "harness, includeEmpty false": 12.704,
      model: 12.599,
      repository: 22.206,
      "repository, includeEmpty false": 22.001,
      priority: 12.492,
      "priority isEmpty": 12.699,
      "priority isNotEmpty": 14.007,
      "last activity window": 12.109,
      "status and cost": 1788.854,
      "cost asc": 1809.357,
      "cost desc": 1729.826,
      "started asc": 14.125,
      "started desc": 14.292,
      "last activity asc": 12.461,
      "last activity desc": 12.432,
      "updated asc": 12.311,
      "updated desc": 11.705,
      "model asc": 1744.356,
      "model desc": 1724.531,
      "priority desc, one harness": 1776.036,
      "status asc, one repository": 415.365,
      "harness asc, one priority": 1776.972,
      "repository asc, one status": 1783.522,
      "duration desc, ended rows": 1799.556,
      "second page": 4.624,
    },
  },
};

/**
 * Nearest-rank p95 of ascending-sorted `samples` (tinybench's
 * `latency.samples` order); tinybench reports p50/p75/p99 but no p95.
 */
export function p95Of(samples: readonly number[]): number {
  if (samples.length === 0) {
    throw new Error("p95Of needs at least one sample");
  }
  return samples[Math.ceil(0.95 * samples.length) - 1];
}

/** The recorded p95 for one query, or `undefined` when none is recorded. */
export function baselineP95Of(
  host: SessionListBenchHost,
  storePercentile: string,
  query: string
): number | undefined {
  return SESSION_LIST_BENCH_BASELINE[host][storePercentile]?.[query];
}
