/**
 * @file desktop-metric-temporality.ts
 * @description ISS-9246 — make an unrecorded GAUGE series genuinely absent from
 * the desktop metric export.
 *
 * The SDK default temporality selector answers CUMULATIVE for every instrument
 * type, and under CUMULATIVE `TemporalMetricProcessor` merges each collection
 * into the previous one. An attribute set that stops being recorded is therefore
 * not dropped: it stays in the merged accumulation and is re-exported at its
 * LAST value, indefinitely. For a counter that is the whole point. For these
 * gauges it defeats the contract they are built on — `sync-burndown-gauges.ts`
 * publishes nothing for a figure the device did not measure, and under
 * CUMULATIVE "publish nothing" silently means "publish the last real value
 * again". A lane that reported three dead letters and then lost its source key
 * would keep reporting three for the life of the process, which is a stale
 * measurement presented as a current one.
 *
 * DELTA for GAUGE fixes that and costs nothing on the wire: OTLP's `Gauge`
 * message has no `aggregation_temporality` field (only `Sum` and the histograms
 * do), so the bytes a receiver sees are identical either way. The only
 * difference is the one wanted — a series that stops being recorded stops being
 * sent.
 *
 * Scoped to GAUGE alone. `sync.batch.count` and every future counter keep
 * CUMULATIVE, because a delta counter would change what a rate query means.
 *
 * Declared BY the desktop's two metric exporters rather than wrapped around them
 * at the reader, so there is no separate call site to forget:
 * `PeriodicExportingMetricReader` reads the selector off its exporter and
 * nowhere else, and `withFleetScopedResource` forwards whatever it finds.
 */

import {
  AggregationTemporality,
  InstrumentType,
} from "@opentelemetry/sdk-metrics";

/**
 * The temporality the desktop exports each instrument type at.
 *
 * Both gauge kinds, because the synchronous and observable forms accumulate
 * through the same `TemporalMetricProcessor` and carry the same staleness.
 */
export function selectDesktopMetricTemporality(
  instrumentType: InstrumentType
): AggregationTemporality {
  if (
    instrumentType === InstrumentType.GAUGE ||
    instrumentType === InstrumentType.OBSERVABLE_GAUGE
  ) {
    return AggregationTemporality.DELTA;
  }
  return AggregationTemporality.CUMULATIVE;
}
