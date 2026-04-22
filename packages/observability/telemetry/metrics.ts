import { log } from "../log";
import type { Origin } from "./origin";

// ---------------------------------------------------------------------------
// QueueMetric — executor/queue health metrics
// ---------------------------------------------------------------------------

export type QueueMetric = {
  metric:
    | "queued_command_count"
    | "in_flight_command_count"
    | "retry_attempts"
    | "replay_frequency"
    | "executor_saturation"
    | "dropped_expired_work_items"
    | "command_state_transition";
  origin: Origin;
  count?: number;
  value?: number;
  computeTargetId?: string;
  timestamp?: string;
  fromStatus?: string;
  toStatus?: string;
  commandId?: string;
};

// ---------------------------------------------------------------------------
// ConnectionState — connection health state values
// ---------------------------------------------------------------------------

export const ConnectionState = {
  Online: "online",
  Degraded: "degraded",
  Disconnected: "disconnected",
} as const;
export type ConnectionState =
  (typeof ConnectionState)[keyof typeof ConnectionState];

// ---------------------------------------------------------------------------
// ProtocolMetric — connection/protocol health metrics
// ---------------------------------------------------------------------------

/** Emitted with count: 1 per state transition. Aggregate via sum(count) by {state} for transition-rate view; NOT a live gauge of currently-connected workers. The literal `count: 1` is the enforced invariant — any other numeric count on this metric is a bug. */
type ConnectionStateCountMetric = {
  metric: "connection_state_count";
  state: ConnectionState;
  count: 1;
  computeTargetId?: string;
  gatewaySessionId?: string;
  timestamp?: string;
};

type ProtocolBaseMetric = {
  metric:
    | "ack_latency"
    | "terminal_event_latency"
    | "heartbeat_freshness"
    | "presence_received_latency"
    | "reconnect_frequency"
    | "event_ordering_gaps"
    | "connection_churn_rate"
    | "replay_window_usage";
  origin: Origin;
  value?: number;
  count?: number;
  computeTargetId?: string;
  gatewaySessionId?: string;
  timestamp?: string;
};

export type ProtocolMetric = ConnectionStateCountMetric | ProtocolBaseMetric;

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

/**
 * Emit a queue/executor metric. Logged as JSON with _telemetryMetric marker
 * for downstream aggregation.
 */
export function emitQueueMetric(metric: QueueMetric): void {
  log.info(JSON.stringify({ ...metric, _telemetryMetric: true }));
}

/**
 * Emit a protocol/connection health metric. Logged as JSON with
 * _telemetryMetric marker for downstream aggregation.
 */
export function emitProtocolMetric(metric: ProtocolMetric): void {
  log.info(JSON.stringify({ ...metric, _telemetryMetric: true }));
}

/**
 * Emit a validation-failed counter event tagged with optional computeTargetId.
 */
export function emitValidationFailedCounter(context: {
  computeTargetId?: string;
}): void {
  log.warn(
    JSON.stringify({
      metric: "telemetry.validation_failed_count",
      count: 1,
      ...context,
      _telemetryMetric: true,
    })
  );
}

// ---------------------------------------------------------------------------
// Snapshot aggregation
// ---------------------------------------------------------------------------

/**
 * Filter log lines where _telemetryMetric === true and aggregate a single
 * numeric per metric name. When both `count` and `value` are present on a
 * line, `value` wins — `count` is typically a per-occurrence sentinel (e.g.
 * `replay_frequency` emits `count: 1, value: events.length`), and summing
 * the sentinel would collapse depth information. Lines with only `count`
 * or only `value` sum that field directly; lines with neither fall back to 1.
 */
export function computeMetricSnapshot(
  logLines: Record<string, unknown>[]
): Record<string, number> {
  const result: Record<string, number> = {};

  for (const line of logLines) {
    if (line._telemetryMetric !== true) {
      continue;
    }

    const metricName =
      typeof line.metric === "string" ? line.metric : undefined;
    if (metricName === undefined) {
      continue;
    }

    let numeric: number;
    if (typeof line.value === "number") {
      numeric = line.value;
    } else if (typeof line.count === "number") {
      numeric = line.count;
    } else {
      numeric = 1;
    }

    result[metricName] = (result[metricName] ?? 0) + numeric;
  }

  return result;
}
