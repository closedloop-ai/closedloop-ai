import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PoolTelemetrySample } from "@repo/database";

/**
 * ISS-6820 — a file tee for pg pool telemetry, for the `just profile-api` lane.
 *
 * ## Why the API lane needs this at all
 *
 * The workload driver can time a request and weigh its response, but neither
 * number can tell you WHY a read was slow. A fan-out wider than the connection
 * pool queues even when every individual statement is fast, and that queueing is
 * the mechanism ISS-6821 proposes to remove — so an instrument that folds pool
 * wait into request latency cannot see the thing being fixed, and would score a
 * change that traded queueing for statement time as a wash.
 *
 * `@repo/database` already measures every acquisition and exposes an injected
 * sink for exactly this reason (FEA-3300). This module is a second consumer of
 * that same sink, not a second measurement: the numbers here are the ones
 * production emits to Datadog, written to a file a profiling run can read.
 *
 * ## Closed by default, and fail-open when open
 *
 * The tee exists only when {@link PERF_PROFILE_DIR_ENV} names an absolute
 * directory — the same env var the desktop lane gates all of its capture on.
 * Unset (production, CI, and every local run that is not a profiling run) means
 * {@link createPerfPoolWaitSink} returns `null` and nothing is installed. When
 * it IS installed it can never throw: a telemetry writer that could fail a
 * database acquisition would invert the risk this instrumentation reduces.
 *
 * ## Why synchronous appends
 *
 * A buffered writer would lose its tail: `just profile-api` stops the server
 * with SIGINT, which terminates the process without running `exit` handlers, so
 * whatever sat in the buffer at that moment — the most contended part of the
 * run — would be exactly the part that never reached disk. The upstream sink
 * only emits waits at or above its 10ms contention threshold plus a 10s-cadence
 * gauge, so the write rate is a trickle, and a sub-millisecond append on that
 * path is far below the signal being measured.
 *
 * ## Two files, because the sink carries two units
 *
 * `@repo/database` emits durations (`db_pool_acquire_wait`,
 * `db_pool_checkout_duration`) and connection COUNTS (`db_pool_in_use`,
 * `db_pool_total`, the wait-queue depth, the acquire-timeout counter) through
 * one sink. Writing them to one file would put a count of 10 open connections
 * into a table whose columns say milliseconds, where — the table being sorted
 * by p95 — it can outrank the waits and read as the worst latency in the lane.
 * The counter rows are worse than misleading: they carry no `value` at all, so
 * a duration analyzer counts an acquire TIMEOUT, the strongest possible
 * evidence that the pool is the constraint, as a malformed line.
 *
 * So durations go to {@link PERF_POOL_WAIT_FILE_NAME}, which the perf registry
 * reads and judges, and everything else goes to {@link
 * PERF_POOL_GAUGE_FILE_NAME}, which is deliberately unregistered evidence for a
 * human — the same posture the desktop lane takes with its phase index.
 *
 * ## What these files therefore do and do NOT contain
 *
 * They contain what `@repo/database` chose to emit: acquire waits at or above
 * its contention threshold (never throttled while the pool is saturated,
 * throttled to 1/s otherwise), acquire timeouts, checkout durations, and the
 * periodic gauges. They do NOT contain a row per statement — a warm-pool
 * acquire is sub-millisecond and emits nothing by design — so this is a record
 * of CONTENTION, not a statement counter, and must not be read as one.
 */

/** Absolute directory profiling artifacts are written into; unset means off. */
export const PERF_PROFILE_DIR_ENV = "CLOSEDLOOP_PROFILE_DIR";

/** Duration rows. Registered in `scripts/perf/thresholds.ts` under the `api` lane. */
export const PERF_POOL_WAIT_FILE_NAME = "api-pool-wait.jsonl";

/** Everything the sink emits that is not a duration. Unregistered by design. */
export const PERF_POOL_GAUGE_FILE_NAME = "api-pool-gauges.jsonl";

/**
 * The metrics whose `value` is milliseconds.
 *
 * Named rather than shape-sniffed: the gauges carry a numeric `value` too, so
 * "has a number" cannot tell a wait from a connection count. Pinned against
 * `PoolTelemetryMetric` by `scripts/perf/twin-constants.test.ts`. A duration
 * metric added upstream and not added here lands in the gauge file — visible,
 * unjudged, and never silently averaged into a latency.
 */
const DURATION_METRICS = [
  "db_pool_acquire_wait",
  "db_pool_checkout_duration",
] as const;

/** One emitted sample, plus the wall clock an operator correlates it by. */
export type PerfPoolWaitRow = PoolTelemetrySample & { readonly ts: number };

/**
 * Builds the file tee, or `null` when profiling is off or the directory is
 * unusable.
 *
 * A relative path is refused rather than resolved against an unknown cwd: the
 * Next.js server's working directory is not the run directory, so resolving one
 * would scatter evidence somewhere nobody looks and report success.
 */
export function createPerfPoolWaitSink(
  profileDir: string | undefined
): ((sample: PoolTelemetrySample) => void) | null {
  const trimmed = profileDir?.trim();
  if (!(trimmed && path.isAbsolute(trimmed))) {
    return null;
  }
  const waitPath = path.join(trimmed, PERF_POOL_WAIT_FILE_NAME);
  const gaugePath = path.join(trimmed, PERF_POOL_GAUGE_FILE_NAME);
  try {
    // Truncate up front so a rerun into an existing directory measures this run
    // rather than this run appended to the last one.
    writeFileSync(waitPath, "", "utf8");
    writeFileSync(gaugePath, "", "utf8");
  } catch {
    return null;
  }

  const durations = new Set<string>(DURATION_METRICS);
  return (sample: PoolTelemetrySample): void => {
    const row: PerfPoolWaitRow = { ...sample, ts: Date.now() };
    try {
      appendFileSync(
        durations.has(sample.metric) ? waitPath : gaugePath,
        `${JSON.stringify(row)}\n`,
        "utf8"
      );
    } catch {
      // Fail-open: a full disk or a deleted run directory must not be able to
      // fail the query whose acquisition raised this sample.
    }
  };
}
