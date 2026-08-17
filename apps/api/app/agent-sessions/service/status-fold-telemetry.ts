/**
 * ISS-5981: the BATCH-level tally behind the ingest's status-fold metric,
 * `SessionSyncMetric.UnmodelledStatusFolded`.
 *
 * ISS-5592 removed the second metric this module used to carry
 * (`RetiredStatusFolded`, split by `SessionSyncRetiredStatusFoldSource`) along
 * with the retired fold it measured — with nothing folding those spellings, the
 * counter could only ever read zero. A retired spelling now arrives through the
 * unmodelled counter instead, with the raw word in `unmodelledStatusSamples`.
 *
 * `upsertSessionSlice` reports its fold decisions rather than emitting them
 * (wongk, PR #4786). This module accumulates them across one sync request and
 * emits at most ONE event for the whole batch.
 *
 * Why not per session: the ingest schema accepts up to 200 sessions per request
 * for version skew — even though the current desktop sends
 * `DESKTOP_AGENT_SESSION_SYNC_MAX_SESSIONS_PER_REQUEST` — so a per-row emit on
 * this authenticated path is the amplification vector `apps/api/AGENTS.md`
 * ("Emission and Abuse Control") forbids: one max-size request would write 200
 * Datadog-bound logs. The counter stays additive, so a monitor reading
 * `sum(count)` sees the same total it would have seen per session.
 */

import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import type { UpsertSessionsContext } from "./records";
import { SessionSyncMetric } from "./session-sync-metrics";
import type { UpsertSessionSliceResult } from "./upsert-session-slice";

/**
 * How many DISTINCT unmodelled spellings one batch reports (wongk, #5047).
 *
 * The counter alone is unactionable — it says version skew is happening but not
 * WHICH spelling arrived, and since ISS-5592 removed the alias map the response
 * is a decision about the producer rather than a new fold entry. Carrying the spellings closes that, but they are caller-supplied,
 * so both dimensions are bounded: distinct values per batch, and characters per
 * value. `session.status` is validated as `z.string().trim().min(1)` with NO
 * `.max()`, so an unbounded log field would be writable by any authenticated
 * caller.
 *
 * A handful is enough to name a new spelling — a fleet rolling out one unknown
 * status produces one distinct value, not five — and a `Set` means a batch of 200
 * identical spellings still logs one.
 *
 * These are a LOG FIELD, never a metric tag. If a `datadog_logs_metric`
 * generator is ever added for this metric (see the note on
 * `SessionSyncMetric.UnmodelledStatusFolded`), it must tag on `source`-style
 * bounded dimensions only — tagging on caller-supplied text is unbounded
 * cardinality, which is the expensive failure this bound exists to prevent.
 */
const UNMODELLED_STATUS_SAMPLE_LIMIT = 5;
/** Long enough to identify a status spelling, short enough to bound the log. */
const UNMODELLED_STATUS_SAMPLE_MAX_CHARS = 64;

export type StatusFoldTally = {
  /** Fold one slice's decisions into the batch counts. */
  record(outcome: UpsertSessionSliceResult): void;
  /**
   * Emit the accumulated counts. Call ONCE per request, from the caller's
   * `finally`, so a batch that throws part-way still reports the folds its
   * committed slices performed — matching the landed-data watermark stamped
   * alongside it. Silent when nothing was folded, so the metric measures the
   * draining population rather than sync traffic.
   */
  emit(context: UpsertSessionsContext): void;
};

export function createStatusFoldTally(): StatusFoldTally {
  let unmodelledCount = 0;
  const unmodelledSamples = new Set<string>();

  return {
    record(outcome) {
      // TRUTHINESS, not `!== null`: this runs in the caller's `finally` ahead of
      // the ingest watermark stamps and must never throw (see `emit`), so it
      // cannot assume the field is present. An absent value from a partial or
      // older outcome shape reads as "nothing unmodelled", which is the safe
      // answer — the alternative dereferenced `undefined` and took the watermark
      // stamps down with it.
      if (outcome.unmodelledStatus) {
        unmodelledCount++;
        if (unmodelledSamples.size < UNMODELLED_STATUS_SAMPLE_LIMIT) {
          unmodelledSamples.add(
            outcome.unmodelledStatus.slice(
              0,
              UNMODELLED_STATUS_SAMPLE_MAX_CHARS
            )
          );
        }
      }
    },
    emit(context) {
      // Best-effort, and NEVER throwing: the caller runs this from the batch
      // `finally` AHEAD of the ingest watermark stamps, so a throw here would
      // skip them (leaving the org readable as QUIET) and replace whatever
      // real ingest error was already unwinding. Same guard, same reason as
      // `app/integrations/github/service/repository-relink-telemetry.ts`. The
      // guard wraps EACH emit, so one failing metric cannot suppress the others.
      emitFoldCount(context, {
        metric: SessionSyncMetric.UnmodelledStatusFolded,
        count: unmodelledCount,
        unmodelledStatusSamples: [...unmodelledSamples],
      });
    },
  };
}

/**
 * Emit one batch count, or nothing when the count is zero — the metrics measure
 * a draining population, so a zero would turn them into sync-traffic counters.
 * Never throws; see the note on the caller.
 */
function emitFoldCount(
  context: UpsertSessionsContext,
  emission: {
    metric: SessionSyncMetric;
    count: number;
    unmodelledStatusSamples?: readonly string[];
  }
): void {
  if (emission.count <= 0) {
    return;
  }
  try {
    emitTelemetryMetric({
      metric: emission.metric,
      organizationId: context.organizationId,
      computeTargetId: context.computeTargetId,
      count: emission.count,
      ...(emission.unmodelledStatusSamples?.length
        ? { unmodelledStatusSamples: emission.unmodelledStatusSamples }
        : {}),
    });
  } catch (error) {
    log.warn("[agent-sessions] Failed to emit status fold", {
      metric: emission.metric,
      count: emission.count,
      error: parseError(error),
    });
  }
}
