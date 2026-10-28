/**
 * @file sync-batch-counter.ts
 * @description ISS-7497 — the unsampled half of sync batch telemetry.
 *
 * The `sync.batch` SPAN cannot answer "what fraction of batches succeed": it is
 * a child of the desktop activity-window root, the collector's `tail_sampling`
 * decides per trace, and a failed batch sets span status ERROR while a
 * successful one does not. Failures are therefore retained whole and successes
 * survive at the baseline rate, which leaves a rate read off spans directionally
 * wrong rather than merely noisy.
 *
 * `tail_sampling` is trace-only, so a counter is the fix: every increment is
 * aggregated in-process and shipped by the periodic metric reader, and no
 * sampling decision stands between the batch and the number. Its own module
 * rather than another branch of `app-otel-runtime.ts` because it is a separate
 * signal with a separate failure mode, and because that file is 40 lines from
 * the 1,000-line ceiling.
 */
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  SyncBatchCounterName,
  SyncBatchCounterSchema,
  type SyncLane,
  type SyncOutcome,
} from "@closedloop-ai/telemetry-contract/sync";
import { metrics } from "@opentelemetry/api";

/** Instrumentation scope for the sync meter; mirrors the sync tracer's name. */
export const SYNC_METER_NAME = "closedloop-desktop-sync";

/**
 * Count one settled sync batch.
 *
 * Called beside the span emit and guarded separately on purpose: the span is a
 * forensic record and the count is the population, so a batch whose span is
 * rejected by the strict attribute schema must still be counted. Sharing one
 * try block would let a span-side regression silently deflate the rate this
 * instrument exists to keep honest.
 */
export function recordSyncBatchOutcome(input: {
  outcome: SyncOutcome;
  lane?: SyncLane;
}): void {
  try {
    const attributes = SyncBatchCounterSchema.parse({
      [TelemetryAttribute.SyncOutcome]: input.outcome,
      ...(input.lane ? { [TelemetryAttribute.SyncLane]: input.lane } : {}),
    });
    // Resolved per call rather than cached at module scope: a process can run
    // more than one runtime in sequence (the suite does), and a counter captured
    // from a retired MeterProvider would silently drop every later increment.
    // The SDK dedupes the underlying storage by descriptor, so repeated calls
    // share one time series; the per-call descriptor and wrapper are two small
    // allocations, which is nothing at the frequency batches settle.
    metrics
      .getMeter(SYNC_METER_NAME)
      .createCounter(SyncBatchCounterName, {
        description:
          "Sync batches by outcome and lane, counted on the metrics pipeline so the rate is not tail-sampled.",
      })
      .add(1, attributes);
  } catch {
    // Best-effort, per the desktop exporter boundary rule: counting a batch must
    // never throw into the sync loop that produced it.
  }
}
