import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { Origin } from "@repo/observability/telemetry/origin";

export const RealtimeGauge = {
  LiveConnections: "realtime_live_connections",
  Degraded: "realtime_degraded",
} as const;

/**
 * One sample per server-sent resync: the sockets it reached, for ISS-11210
 * finalize item 4's resync-rate monitor.
 */
export const RealtimeCount = {
  Resyncs: "realtime_resyncs",
} as const;

/**
 * PLN-2105 step 2: one sample per fanned-out signal, from its envelope's `ts`,
 * up to `SIGNAL_DELAY_SAMPLES_PER_MINUTE` per instance from fan-outs with no
 * recipients (ISS-12703).
 */
export const RealtimeHistogram = {
  SignalEmitToDeliveryMs: "realtime_signal_emit_to_delivery_ms",
} as const;

export type GaugeSources = {
  liveConnections: () => number;
  degraded: () => boolean;
};

/**
 * PLN-2104 step 10: the live-connection and degraded gauges, sampled on an
 * interval. They carry no org or connection tag (ISS-11210 requirement 15).
 * Returns the stop function.
 */
export function startGaugeReporter(
  sources: GaugeSources,
  intervalMs = GAUGE_INTERVAL_MS
): () => void {
  const report = () => {
    emitTelemetryMetric({
      metric: RealtimeGauge.LiveConnections,
      origin: Origin.Realtime,
      value: sources.liveConnections(),
    });
    emitTelemetryMetric({
      metric: RealtimeGauge.Degraded,
      origin: Origin.Realtime,
      value: sources.degraded() ? 1 : 0,
    });
  };
  report();
  const timer = setInterval(report, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

const GAUGE_INTERVAL_MS = 10_000;
